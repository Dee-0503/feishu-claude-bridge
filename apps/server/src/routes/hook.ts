import path from 'path';
import { execSync } from 'child_process';
import { Router } from 'express';
import { sendTextMessage, sendCardMessage, updateCardMessage, type SendMessageOptions, type SendCardResult } from '../feishu/message.js';
import { getOrCreateProjectGroup, loadGroupMappings } from '../feishu/group.js';
import { generateTaskSummary, generateDefaultSummary } from '../services/summary.js';
import { registerMessageSession } from '../services/message-session-map.js';
import type { RawSummary, StopHookPayload } from '../types/summary.js';
import { log } from '../utils/log.js';
import { authStore } from '../store/auth-store.js';
import { isHighRiskCommand, sendVoiceAlert } from '../services/voice-alert.js';

export const hookRouter = Router();

/**
 * 获取项目管理员用户ID（Phase4：用于语音提醒）
 */
async function getAdminUserId(projectPath: string | undefined): Promise<string | null> {
  if (!projectPath) return null;

  try {
    const mappings = loadGroupMappings();
    const projectConfig = mappings[projectPath];
    return projectConfig?.adminUserId || null;
  } catch {
    return null;
  }
}

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
 * Called when Claude Code stops (task complete)
 */
hookRouter.post('/stop', async (req, res) => {
  try {
    const body = req.body as StopHookPayload;
    const { session_id, summary, stop_reason } = body;

    console.log('📨 Stop hook received:', {
      session_id,
      stop_reason,
      hasSummary: !!summary,
    });

    // 获取或创建项目群
    let chatId: string | undefined;
    if (summary?.projectPath) {
      try {
        chatId = await getOrCreateProjectGroup(summary.projectPath);
      } catch (error) {
        console.error('Failed to get/create project group:', error);
      }
    }

    // 发送初始卡片（不含 Haiku 摘要）
    const result = await sendCardMessage({
      type: 'task_complete',
      title: '✅ Claude Code 任务完成',
      sessionId: session_id,
      chatId,
      summary: summary || undefined,
    });

    // 注册 message → session 映射
    if (result?.messageId && session_id) {
      registerMessageSession(result.messageId, session_id, result.chatId, summary?.projectPath);
    }

    // 异步生成 Haiku 摘要并更新卡片
    if (result?.messageId && summary) {
      generateHaikuSummaryAndUpdate(result.messageId, summary, session_id, chatId);
    }

    res.json({ success: true });
  } catch (error) {
    log('error', 'hook_stop_error', { error: String(error) });
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

/**
 * 异步生成 Haiku 摘要并更新卡片
 */
async function generateHaikuSummaryAndUpdate(
  messageId: string,
  summary: RawSummary,
  sessionId: string,
  chatId?: string
): Promise<void> {
  try {
    const haikuSummary = await generateTaskSummary(summary);

    if (haikuSummary) {
      await updateCardMessage(messageId, {
        type: 'task_complete',
        title: '✅ Claude Code 任务完成',
        sessionId,
        chatId,
        summary,
        haikuSummary,
      });
    }
  } catch (error) {
    console.error('Failed to generate/update Haiku summary:', error);
  }
}

/**
 * POST /api/hook/pre-tool
 * Called before a tool is executed.
 * Creates an AuthRequest, sends a Feishu authorization card, and returns requestId.
 */
hookRouter.post('/pre-tool', async (req, res) => {
  try {
    const { session_id, tool, tool_input, options, cwd } = req.body;

    // 获取或创建项目群
    let chatId: string | undefined;
    if (cwd) {
      try {
        chatId = await getOrCreateProjectGroup(cwd);
      } catch (error) {
        console.error('Failed to get/create project group:', error);
      }
    }

    // Extract command for Bash tool
    const command = tool === 'Bash' ? tool_input?.command : JSON.stringify(tool_input);

    // Phase4: 检测高风险命令并触发语音提醒
    if (command && isHighRiskCommand(command)) {
      const adminUserId = await getAdminUserId(cwd);
      if (adminUserId && process.env.FEISHU_VOICE_ENABLED === 'true') {
        // 异步发送语音提醒，不阻塞主流程
        sendVoiceAlert({
          userId: adminUserId,
          command: tool || 'unknown',
          projectPath: cwd || 'unknown',
          sessionId: session_id || 'unknown',
        }).catch(err => log('error', 'voice_alert_send_failed', { error: String(err) }));
      }
    }

    const result = await sendCardMessage({
      type: options ? 'authorization_required' : 'sensitive_command',
      title: options ? '⚠️ Claude 需要授权' : '🔔 敏感命令执行',
      content: `工具: **${tool}**`,
      command,
      sessionId: session_id,
      chatId,
      options: options || undefined,
    });

    // 注册 message → session 映射
    if (result?.messageId && session_id) {
      registerMessageSession(result.messageId, session_id, result.chatId, cwd);
    }

    res.json({ success: true });
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
    const { message, cwd } = req.body;

    // 获取或创建项目群
    let chatId: string | undefined;
    if (cwd) {
      try {
        chatId = await getOrCreateProjectGroup(cwd);
      } catch (error) {
        console.error('Failed to get/create project group:', error);
      }
    }

    await sendTextMessage(message || 'Claude Code notification', chatId);

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

/**
 * POST /api/hook/authorization
 * Called when Claude Code needs user authorization (Notification hook event)
 */
hookRouter.post('/authorization', async (req, res) => {
  try {
    const body = req.body;
    console.log('📨 Authorization request received:', JSON.stringify(body, null, 2));

    const title = body.title || '⚠️ Claude 需要你的操作';
    const message = body.message || body.body || '';
    const sessionId = body.session_id || 'unknown';
    const cwd = body.cwd;

    // 获取或创建项目群
    let chatId: string | undefined;
    if (cwd) {
      try {
        chatId = await getOrCreateProjectGroup(cwd);
      } catch (error) {
        console.error('Failed to get/create project group:', error);
      }
    }

    const result = await sendCardMessage({
      type: 'authorization_required',
      title,
      content: message || '请在终端中确认操作',
      sessionId,
      chatId,
    });

    // 注册 message → session 映射
    if (result?.messageId && sessionId) {
      registerMessageSession(result.messageId, sessionId, result.chatId, cwd);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Hook authorization error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});
