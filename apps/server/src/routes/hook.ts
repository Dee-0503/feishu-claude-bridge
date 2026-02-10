import path from 'path';
import { execSync } from 'child_process';
import { Router } from 'express';
import { sendTextMessage, sendCardMessage, updateCardMessage } from '../feishu/message.js';
import type { SendCardResult, SendMessageOptions } from '../feishu/message.js';
import { getOrCreateProjectGroup } from '../feishu/group.js';
import { authStore } from '../store/auth-store.js';
import { permissionRules } from '../store/permission-rules.js';
import { generateCommandExplanation } from '../services/command-explain.js';
import { log } from '../utils/log.js';

/**
 * Build a dynamic title prefix from cwd and session_id.
 * Format: `[feature/my-branch] / #ab12`
 */
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

export const hookRouter = Router();

/**
 * 发送卡片消息，群消息失败时自动重建群并重试一次
 */
export async function sendWithRetry(
  msgOptions: SendMessageOptions,
  projectRoot?: string,
): Promise<SendCardResult | null> {
  try {
    return await sendCardMessage(msgOptions);
  } catch (error) {
    if (msgOptions.chatId && projectRoot) {
      log('warn', 'group_send_failed_retrying', { chatId: msgOptions.chatId });
      const newChatId = await getOrCreateProjectGroup(projectRoot);
      return await sendCardMessage({ ...msgOptions, chatId: newChatId });
    }
    throw error;
  }
}

// Middleware to verify hook secret
hookRouter.use((req, res, next) => {
  const secret = req.headers['x-hook-secret'];
  const expectedSecret = process.env.HOOK_SECRET;

  if (expectedSecret && secret !== expectedSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

/**
 * POST /api/hook/stop
 * Called when Claude Code stops (task complete or waiting for input)
 */
hookRouter.post('/stop', async (req, res) => {
  try {
    const { session_id, cwd, project_dir, message } = req.body;
    const projectRoot = project_dir || cwd;

    // Resolve project group if projectRoot is provided
    let chatId: string | undefined;
    if (projectRoot) {
      try {
        chatId = await getOrCreateProjectGroup(projectRoot);
      } catch {
        // Fall back to default target
      }
    }

    const tag = buildTitleTag(cwd, session_id);
    await sendWithRetry({
      type: 'task_complete',
      title: tag ? `✅ ${tag} 任务完成` : '✅ Claude Code 任务完成',
      content: message || '任务已完成，等待下一步指令',
      sessionId: session_id,
      chatId,
    }, projectRoot);

    res.json({ success: true });
  } catch (error) {
    log('error', 'hook_stop_error', { error: String(error) });
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

/**
 * POST /api/hook/pre-tool
 * Called before a tool is executed.
 * Creates an AuthRequest, sends a Feishu authorization card, and returns requestId.
 */
hookRouter.post('/pre-tool', async (req, res) => {
  try {
    const { session_id, tool_name, tool, tool_input, options, cwd, project_dir } = req.body;
    const projectRoot = project_dir || cwd;
    const toolName = tool_name || tool; // Claude Code uses tool_name

    // Extract command for Bash tool
    const command = toolName === 'Bash' ? tool_input?.command : JSON.stringify(tool_input);

    // Check if a permission rule already allows this
    const matchedRule = permissionRules.match(toolName, command, cwd);
    if (matchedRule) {
      log('info', 'auth_rule_matched', {
        ruleId: matchedRule.id,
        tool: toolName,
        command: command?.substring(0, 100),
      });
      res.json({
        requestId: null,
        decision: 'allow',
        reason: '匹配已有规则',
        ruleId: matchedRule.id,
      });
      return;
    }

    // Ensure options always has values — empty/missing defaults to ['Yes', 'No']
    const resolvedOptions: string[] =
      Array.isArray(options) && options.length > 0 ? options : ['Yes', 'No'];

    // Create auth request
    const authRequest = authStore.create({
      sessionId: session_id,
      tool: toolName,
      toolInput: tool_input,
      command,
      options: resolvedOptions,
      cwd,
    });

    // Resolve project group
    let chatId: string | undefined;
    if (projectRoot) {
      try {
        chatId = await getOrCreateProjectGroup(projectRoot);
      } catch {
        // Fall back to default target
      }
    }

    // Build dynamic title
    const tag = buildTitleTag(cwd, session_id);
    const authTitle = tag ? `🔔 ${tag} 需要授权` : '🔔 Claude 需要授权';

    // Send Feishu authorization card (immediately, without AI explanation)
    const cardResult = await sendWithRetry({
      type: 'authorization_required',
      title: authTitle,
      content: `工具: **${toolName}**`,
      command,
      sessionId: session_id,
      options: resolvedOptions,
      chatId,
      requestId: authRequest.requestId,
    }, projectRoot);

    // Store feishu message ID for later card update
    if (cardResult) {
      authRequest.feishuMessageId = cardResult.messageId;
      authRequest.chatId = cardResult.chatId;
    }

    res.json({ requestId: authRequest.requestId });

    // Async: generate AI command explanation and update card
    // This runs after the response is sent, so it doesn't block the hook script
    if (cardResult && resolvedOptions.length > 0 && command) {
      generateCommandExplanation(toolName, command, resolvedOptions, cwd)
        .then(async (explanation) => {
          if (!explanation || !cardResult.messageId) return;

          // Only update if the request is still pending (user hasn't decided yet)
          const currentReq = authStore.get(authRequest.requestId);
          if (!currentReq || currentReq.status !== 'pending') return;

          await updateCardMessage(cardResult.messageId, {
            type: 'authorization_required',
            title: authTitle,
            content: `工具: **${toolName}**`,
            command,
            sessionId: session_id,
            options: resolvedOptions,
            chatId,
            requestId: authRequest.requestId,
            commandSummary: explanation.summary,
            optionExplanations: explanation.options,
          });

          log('info', 'auth_card_updated_with_explanation', {
            requestId: authRequest.requestId,
            summary: explanation.summary,
          });
        })
        .catch((error) => {
          log('warn', 'explain_update_failed', {
            requestId: authRequest.requestId,
            error: String(error),
          });
        });
    }
  } catch (error) {
    log('error', 'hook_pre_tool_error', { error: String(error) });
    res.status(500).json({ error: 'Failed to create auth request' });
  }
});

/**
 * GET /api/hook/auth-poll
 * Polled by the hook script to check authorization decision status.
 */
hookRouter.get('/auth-poll', (req, res) => {
  const requestId = req.query.requestId as string;

  if (!requestId) {
    res.status(400).json({ error: 'requestId is required' });
    return;
  }

  const authRequest = authStore.get(requestId);
  if (!authRequest) {
    res.json({ status: 'expired' });
    return;
  }

  switch (authRequest.status) {
    case 'pending':
      res.json({ status: 'pending' });
      break;
    case 'resolved':
      res.json({
        status: 'resolved',
        decision: authRequest.decision,
        reason: authRequest.decisionReason,
      });
      break;
    case 'expired':
      res.json({ status: 'expired' });
      break;
  }
});

/**
 * POST /api/hook/notification
 * Generic notification endpoint
 */
hookRouter.post('/notification', async (req, res) => {
  try {
    const { message, cwd, project_dir, session_id } = req.body;
    const projectRoot = project_dir || cwd;

    // Resolve project group if projectRoot is provided
    let chatId: string | undefined;
    if (projectRoot) {
      try {
        chatId = await getOrCreateProjectGroup(projectRoot);
      } catch {
        // Fall back to default target
      }
    }

    const tag = buildTitleTag(cwd, session_id);
    const title = tag ? `🔔 ${tag} 通知` : '🔔 Claude Code 通知';

    await sendWithRetry({
      type: 'task_complete',
      title,
      content: message || 'Claude Code notification',
      sessionId: session_id,
      chatId,
    }, projectRoot);

    res.json({ success: true });
  } catch (error) {
    log('error', 'hook_notification_error', { error: String(error) });
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

/**
 * POST /api/hook/authorization
 * Called when Claude Code needs user authorization (Notification hook event)
 */
hookRouter.post('/authorization', async (req, res) => {
  try {
    const body = req.body;
    console.log('📨 Authorization request received:', JSON.stringify(body, null, 2));

    // Extract useful info from the notification payload
    const title = body.title || '⚠️ Claude 需要你的操作';
    const message = body.message || body.body || '';
    const sessionId = body.session_id || 'unknown';

    await sendCardMessage({
      type: 'authorization_required',
      title,
      content: message || '请在终端中确认操作',
      sessionId,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Hook authorization error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});
