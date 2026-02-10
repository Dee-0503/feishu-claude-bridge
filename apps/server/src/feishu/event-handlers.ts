/**
 * Shared event handlers for both HTTP webhook and WebSocket long connection modes.
 * These handlers process Feishu events (messages, card actions) regardless of transport.
 */

import { authStore } from '../store/auth-store.js';
import { permissionRules } from '../store/permission-rules.js';
import { updateCardMessage, buildCard } from './message.js';
import { getChineseAuthOption } from '../types/auth.js';
import { getNormalizedProjectPath } from './group.js';
import { buildTitleTag } from '../routes/hook.js';
import { log } from '../utils/log.js';

/**
 * Handle incoming message events from Feishu.
 * Currently logs the message for debugging purposes.
 */
export async function handleMessage(event: any): Promise<void> {
  const message = event.message;
  const content = JSON.parse(message.content || '{}');
  log('info', 'feishu_message_received', { text: content.text?.substring(0, 50) });
}

/**
 * Handle card action events (e.g., authorization button clicks).
 * Processes user decisions and updates permission rules accordingly.
 *
 * @param event - The card action event from Feishu
 * @param options - Optional configuration, including mode ('http' | 'websocket')
 * @returns The updated card JSON for responsive updates (both HTTP and WebSocket modes)
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

  if (!requestId) {
    log('warn', 'card_action_missing_request_id', { value });

    // Build error card
    const messageId = event.context?.open_message_id;
    if (messageId) {
      const errorContent = [
        '**错误**: 按钮 value 中缺少 requestId',
        '',
        '**接收到的数据**:',
        '```json',
        JSON.stringify(value, null, 2),
        '```',
        '',
        '**调试提示**:',
        '- 检查卡片构建时是否正确设置了 requestId',
        '- 查看服务器日志中的 card_action_value_parsed 事件',
      ].join('\n');

      const errorCardOptions = {
        type: 'authorization_resolved' as const,
        title: '⚠️ 回调数据异常',
        content: errorContent,
        chatId: event.context?.open_chat_id,
      };

      // WebSocket 模式：主动调用 API 更新卡片
      // HTTP 模式：返回卡片 JSON 进行响应式更新
      const messageId = event.context?.open_message_id;
      if (options?.mode === 'websocket' && messageId) {
        log('info', 'card_response_using_api', { requestId: 'unknown', type: 'error', messageId });
        await updateCardMessage(messageId, errorCardOptions);
        return null;
      } else {
        log('info', 'card_response_built', { requestId: 'unknown', mode: options?.mode || 'unknown', type: 'error' });
        return buildCard(errorCardOptions);
      }

    }

    return null;
  }

  // 1. Find auth request
  const authReq = authStore.get(requestId);
  if (!authReq) {
    log('warn', 'card_action_request_not_found', { requestId });
    return null;
  }

  // Already resolved (duplicate click) - need to maintain resolved state
  if (authReq.status !== 'pending') {
    log('info', 'card_action_already_resolved', { requestId, status: authReq.status });

    // Build resolved card for consistency
    if (authReq.decision) {
      const tag = buildTitleTag(authReq.cwd, authReq.sessionId);
      const resolvedTitle = authReq.decision === 'allow'
        ? (tag ? `✅ ${tag} 已授权` : '✅ 已授权')
        : (tag ? `❌ ${tag} 已拒绝` : '❌ 已拒绝');

      const callbackData = {
        requestId,
        action: authReq.decisionReason || optionText,
        sessionId,
        decision: authReq.decision,
        timestamp: new Date(authReq.resolvedAt || Date.now()).toISOString(),
        operator: event.operator?.user_id?.open_id || 'unknown',
      };

      const detailedContent = [
        `**决策**: ${authReq.decision === 'allow' ? '✅ 允许' : '❌ 拒绝'}`,
        `**选项**: ${getChineseAuthOption(authReq.decisionReason || optionText || '')}`,
        `**请求ID**: \`${requestId.substring(0, 16)}...\``,
        `**会话ID**: \`${sessionId?.substring(0, 8) || 'N/A'}\``,
        `**操作时间**: ${new Date(authReq.resolvedAt || Date.now()).toLocaleString('zh-CN')}`,
        '',
        '**回调数据**:',
        '```json',
        JSON.stringify(callbackData, null, 2),
        '```',
        '',
        '**服务器状态**: ✅ 已成功接收并处理 (幂等重发)',
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

      // WebSocket 模式：双重保险策略
      // 1. 调用 API 更新卡片（确保持久化）
      // 2. 也返回卡片 JSON（防止 WebSocket 响应覆盖 API 更新）
      if (options?.mode === 'websocket' && authReq.feishuMessageId) {
        log('info', 'card_response_dual_update', { requestId, type: 'duplicate', messageId: authReq.feishuMessageId });

        // API 更新（不等待，让它异步执行）
        updateCardMessage(authReq.feishuMessageId, cardOptions).catch(err => {
          log('error', 'card_api_update_failed', { requestId, error: String(err) });
        });

        // 同时返回卡片 JSON 用于响应式更新（双重保险）
        return cardJson;
      } else if (options?.mode === 'http') {
        log('info', 'card_response_built', { requestId, mode: 'http', type: 'duplicate' });
        return cardJson;
      }

      return null;

    }

    return null;
  }

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

      // 构建详细的回调数据
      const callbackData = {
        requestId,
        action: optionText,
        sessionId,
        decision,
        timestamp: new Date().toISOString(),
        operator: event.operator?.user_id?.open_id || 'unknown',
      };

      const detailedContent = [
        `**决策**: ${decision === 'allow' ? '✅ 允许' : '❌ 拒绝'}`,
        `**选项**: ${getChineseAuthOption(optionText || '')}`,
        `**请求ID**: \`${requestId.substring(0, 16)}...\``,
        `**会话ID**: \`${sessionId?.substring(0, 8) || 'N/A'}\``,
        `**操作时间**: ${new Date().toLocaleString('zh-CN')}`,
        '',
        '**回调数据**:',
        '```json',
        JSON.stringify(callbackData, null, 2),
        '```',
        '',
        '**服务器状态**: ✅ 已成功接收并处理',
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

      // WebSocket 模式：双重保险策略
      // 1. 调用 API 更新卡片（确保持久化）
      // 2. 也返回卡片 JSON（防止 WebSocket 响应覆盖 API 更新）
      if (options?.mode === 'websocket' && authReq.feishuMessageId) {
        log('info', 'card_response_dual_update', { requestId, messageId: authReq.feishuMessageId });

        // API 更新（不等待，让它异步执行）
        updateCardMessage(authReq.feishuMessageId, cardOptions).catch(err => {
          log('error', 'card_api_update_failed', { requestId, error: String(err) });
        });

        // 同时返回卡片 JSON 用于响应式更新（双重保险）
        return cardJson;
      } else if (options?.mode === 'http') {
        log('info', 'card_response_built', { requestId, mode: 'http' });
        return cardJson;
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
