/**
 * Shared event handlers for both HTTP webhook and WebSocket long connection modes.
 * These handlers process Feishu events (messages, card actions) regardless of transport.
 *
 * WebSocket 卡片更新策略：响应式更新 + API 更新双重保险
 * - 响应式更新（return cardJson）→ 即时反馈给用户
 * - API 更新（updateCardMessage）→ 持久化卡片状态，刷新后不回退
 */

import { authStore } from '../store/auth-store.js';
import { permissionRules } from '../store/permission-rules.js';
import { updateCardMessage, buildCard } from './message.js';
import { getChineseAuthOption } from '../types/auth.js';
import { getNormalizedProjectPath } from './group.js';
import { log } from '../utils/log.js';
import { execSync } from 'child_process';
import path from 'path';

// Phase3: Helper function to build title tag
export function buildTitleTag(cwd?: string, sessionId?: string): string {
  const parts: string[] = [];
  if (cwd) {
    let label: string;
    try {
      label = execSync('git branch --show-current', {
        cwd,
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      label = '';
      log('warn', 'git_branch_fallback', { cwd, reason: 'git command failed' });
    }
    if (!label) {
      label = path.basename(cwd);
    }
    parts.push(`[${label}]`);
  }
  if (sessionId) {
    parts.push(`#${sessionId.substring(0, 4)}`);
  }
  return parts.join(' / ');
}

/**
 * Handle incoming message events from Feishu.
 * Routes messages to appropriate session based on message type:
 * - Reply to notification card → continue existing session (resume)
 * - @mention bot → start new session in project directory
 */
export async function handleMessage(event: any): Promise<void> {
  const message = event.message;
  const content = JSON.parse(message.content || '{}');
  const text = content.text || '';

  // Log complete message structure for analysis
  log('info', 'feishu_message_received', {
    text: text.substring(0, 50),
    messageId: message.message_id,
    chatId: message.chat_id,
    parentId: message.parent_id,
    rootId: message.root_id,
    mentions: message.mentions,
    messageType: message.message_type,
    chatType: message.chat_type,
  });

  // TODO: Phase 2 integration
  // 1. Check if message.parent_id exists → reply to card → resume session
  //    - Find sessionId by parent message ID
  //    - Call session-manager to resume
  // 2. Check if bot is mentioned → new task
  //    - Find project path by chat_id
  //    - Call session-manager to start new session
  // 3. Otherwise → ignore or send help message

  console.log('[DEBUG] Full message event:', JSON.stringify(event, null, 2));
}

/**
 * 异步调用 API 更新卡片（不阻塞响应式返回，不抛错）
 */
function asyncApiUpdate(messageId: string | undefined, cardOptions: any, context: string): void {
  if (!messageId) return;
  updateCardMessage(messageId, cardOptions).catch(err => {
    log('error', 'card_api_update_failed', { context, messageId, error: String(err) });
  });
}

/**
 * Handle card action events (e.g., authorization button clicks).
 * Processes user decisions and updates permission rules accordingly.
 *
 * WebSocket 模式：返回卡片 JSON 做响应式更新 + 异步 API 更新持久化
 * HTTP 模式：通过 API 更新卡片（响应已发送，无法通过响应更新）
 *
 * @param event - The card action event from Feishu
 * @param options - Optional configuration, including mode ('http' | 'websocket')
 * @returns The updated card JSON for responsive updates (WebSocket mode), or null (HTTP mode)
 */
export async function handleCardAction(
  event: any,
  options?: { mode?: 'http' | 'websocket' }
): Promise<object | null> {
  const action = event.action;

  // 增强日志：记录原始事件结构
  log('info', 'card_action_raw_event', {
    hasAction: !!action,
    hasOperator: !!event.operator,
    hasContext: !!event.context,
    keys: Object.keys(event),
  });

  let value: any;
  try {
    // 记录原始 action.value 的类型和内容
    log('info', 'card_action_raw_value', {
      type: typeof action.value,
      value: action.value,
      firstChars: typeof action.value === 'string' ? action.value.substring(0, 100) : 'N/A',
    });

    value = typeof action.value === 'string' ? JSON.parse(action.value) : action.value;

    // 如果解析后还是字符串，再解析一次（处理双重编码）
    if (typeof value === 'string') {
      log('info', 'card_action_double_encoded', { value: value.substring(0, 100) });
      value = JSON.parse(value);
    }
  } catch (error) {
    log('error', 'card_action_invalid_value', {
      rawValue: action.value,
      error: String(error),
      actionKeys: Object.keys(action),
    });
    return null;
  }

  // 详细的value结构日志
  log('info', 'card_action_value_parsed', {
    value,
    valueKeys: Object.keys(value),
    hasRequestId: !!value.requestId,
    hasAction: !!value.action,
    hasSessionId: !!value.sessionId,
  });

  const { requestId, action: optionText, sessionId } = value;

  // 记录完整的回调上下文
  log('info', 'card_action_received', {
    requestId,
    optionText,
    sessionId,
    operator: event.operator?.user_id?.open_id,
    messageId: event.context?.open_message_id,
    chatId: event.context?.open_chat_id,
  });

  // ── 错误分支：缺少 requestId ──
  if (!requestId) {
    log('warn', 'card_action_missing_request_id', { value });

    const errorMsgId = event.context?.open_message_id;
    if (errorMsgId) {
      const errorContent = [
        '**错误**: 按钮 value 中缺少 requestId',
        '',
        `**接收到的数据**: ${JSON.stringify(value)}`,
        '',
        '**调试提示**: 检查卡片构建时是否正确设置了 requestId',
      ].join('\n');

      const errorCardOptions = {
        type: 'authorization_resolved' as const,
        title: '⚠️ 回调数据异常',
        content: errorContent,
        chatId: event.context?.open_chat_id,
      };

      if (options?.mode === 'websocket') {
        // 双重更新：响应式 + 异步 API 持久化
        log('info', 'card_response_websocket_error', { type: 'error', messageId: errorMsgId });
        asyncApiUpdate(errorMsgId, errorCardOptions, 'websocket_error');
        return buildCard(errorCardOptions);
      }

      // HTTP 模式：API 更新
      log('info', 'card_response_api_error', { type: 'error', messageId: errorMsgId });
      await updateCardMessage(errorMsgId, errorCardOptions);
      return null;
    }

    return null;
  }

  // ── 错误分支：authReq 不存在（服务器重启后内存清空） ──
  const authReq = authStore.get(requestId);
  if (!authReq) {
    log('warn', 'card_action_request_not_found', { requestId });

    const expiredMsgId = event.context?.open_message_id;
    const expiredCardOptions = {
      type: 'authorization_resolved' as const,
      title: '⏰ 授权请求已过期',
      content: '该授权请求已过期或服务器已重启，请在终端中操作。',
      sessionId,
      chatId: event.context?.open_chat_id,
    };

    if (options?.mode === 'websocket') {
      // 双重更新：响应式 + 异步 API 持久化
      log('info', 'card_response_websocket_expired', { requestId, messageId: expiredMsgId });
      asyncApiUpdate(expiredMsgId, expiredCardOptions, 'websocket_expired');
      return buildCard(expiredCardOptions);
    }

    // HTTP 模式：API 更新
    if (expiredMsgId) {
      await updateCardMessage(expiredMsgId, expiredCardOptions);
    }
    return null;
  }

  // ── 幂等分支：已处理过的请求（重复点击） ──
  if (authReq.status !== 'pending') {
    log('info', 'card_action_already_resolved', { requestId, status: authReq.status });

    if (authReq.decision) {
      const tag = buildTitleTag(authReq.cwd, authReq.sessionId);
      const resolvedTitle = authReq.decision === 'allow'
        ? (tag ? `✅ ${tag} 已授权` : '✅ 已授权')
        : (tag ? `❌ ${tag} 已拒绝` : '❌ 已拒绝');

      const detailedContent = [
        `**决策**: ${authReq.decision === 'allow' ? '✅ 允许' : '❌ 拒绝'}`,
        `**选项**: ${getChineseAuthOption(authReq.decisionReason || optionText || '')}`,
        `**操作时间**: ${new Date(authReq.resolvedAt || Date.now()).toLocaleString('zh-CN')}`,
        `**服务器状态**: ✅ 已成功接收并处理 (幂等重发)`,
      ].join('\n');

      const cardOptions = {
        type: 'authorization_resolved' as const,
        title: resolvedTitle,
        content: detailedContent,
        command: authReq.command,
        sessionId,
        chatId: authReq.chatId,
      };

      const cardJson = buildCard(cardOptions);

      if (options?.mode === 'websocket') {
        // 双重更新：响应式 + 异步 API 持久化
        log('info', 'card_response_websocket_duplicate', { requestId, messageId: authReq.feishuMessageId });
        asyncApiUpdate(authReq.feishuMessageId, cardOptions, 'websocket_duplicate');
        return cardJson;
      }

      // HTTP 模式：API 更新
      if (authReq.feishuMessageId) {
        log('info', 'card_response_api_update_duplicate', { requestId, type: 'duplicate', messageId: authReq.feishuMessageId });
        updateCardMessage(authReq.feishuMessageId, cardOptions).catch(err => {
          log('error', 'card_api_update_failed', { requestId, error: String(err) });
        });
      }

      return null;
    }

    return null;
  }

  // ── 正常流程：处理新的授权决策 ──

  // 2. Determine allow or deny
  const isReject = optionText?.toLowerCase().includes('no')
                || optionText?.toLowerCase().includes('deny');
  const decision = isReject ? 'deny' : 'allow';

  // 3. Update AuthStore
  authStore.resolve(requestId, decision as 'allow' | 'deny', optionText || '');

  // 4. Handle "always allow" rules
  if (!isReject) {
    const lowerOpt = (optionText || '').toLowerCase();
    const isAlways = lowerOpt.includes('always') || lowerOpt.includes("don't ask again");
    const isProjectScope = lowerOpt.includes('project');

    if (isAlways && authReq.tool) {
      const projectPath = authReq.cwd ? getNormalizedProjectPath(authReq.cwd) : undefined;
      permissionRules.addRule({
        tool: authReq.tool,
        commandPattern: authReq.command ? createPatternFromCommand(authReq.command) : undefined,
        projectPath: isProjectScope ? projectPath : undefined,
        scope: isProjectScope ? 'project' : 'always',
      });
    }
  }

  // 5. Build resolved card with detailed callback data
  if (authReq.feishuMessageId) {
    try {
      const tag = buildTitleTag(authReq.cwd, authReq.sessionId);
      const resolvedTitle = decision === 'allow'
        ? (tag ? `✅ ${tag} 已授权` : '✅ 已授权')
        : (tag ? `❌ ${tag} 已拒绝` : '❌ 已拒绝');

      const detailedContent = [
        `**决策**: ${decision === 'allow' ? '✅ 允许' : '❌ 拒绝'}`,
        `**选项**: ${getChineseAuthOption(optionText || '')}`,
        `**操作时间**: ${new Date().toLocaleString('zh-CN')}`,
        `**服务器状态**: ✅ 已成功接收并处理`,
      ].join('\n');

      const cardOptions = {
        type: 'authorization_resolved' as const,
        title: resolvedTitle,
        content: detailedContent,
        command: authReq.command,
        sessionId,
        chatId: authReq.chatId,
      };

      const cardJson = buildCard(cardOptions);

      if (options?.mode === 'websocket') {
        // 双重更新：响应式即时反馈 + 异步 API 持久化
        log('info', 'card_response_websocket', { requestId, messageId: authReq.feishuMessageId });
        asyncApiUpdate(authReq.feishuMessageId, cardOptions, 'websocket_resolve');
        return cardJson;
      }

      // HTTP 模式：使用 API 更新卡片
      if (authReq.feishuMessageId) {
        log('info', 'card_response_api_update', { requestId, messageId: authReq.feishuMessageId, mode: options?.mode || 'unknown' });
        updateCardMessage(authReq.feishuMessageId, cardOptions).catch(err => {
          log('error', 'card_api_update_failed', { requestId, error: String(err) });
        });
      }

      return null;

    } catch (error) {
      log('error', 'card_build_after_action_failed', { requestId, error: String(error) });
    }
  }

  return null;
}

/**
 * Create a glob pattern from a command for permission rules.
 * E.g., "git push origin main" -> "git push**"
 */
function createPatternFromCommand(command: string): string {
  const parts = command.trim().split(/\s+/);
  // Use the first two words as the pattern base (e.g., "git push")
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1]}**`;
  }
  return `${parts[0]}**`;
}
