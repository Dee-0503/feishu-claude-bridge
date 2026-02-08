import { Router } from 'express';
import { sendTextMessage, sendCardMessage, updateCardMessage } from '../feishu/message.js';
import { getOrCreateProjectGroup } from '../feishu/group.js';
import { generateTaskSummary, generateDefaultSummary } from '../services/summary.js';
import type { RawSummary, StopHookPayload } from '../types/summary.js';

export const hookRouter = Router();

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
        // 继续使用默认目标
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

    // 异步生成 Haiku 摘要并更新卡片
    if (result?.messageId && summary) {
      generateHaikuSummaryAndUpdate(result.messageId, summary, session_id, chatId);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Hook stop error:', error);
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
    // 不影响主流程
  }
}

/**
 * POST /api/hook/pre-tool
 * Called before a tool is executed (for sensitive commands)
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

    await sendCardMessage({
      type: options ? 'authorization_required' : 'sensitive_command',
      title: options ? '⚠️ Claude 需要授权' : '🔔 敏感命令执行',
      content: `工具: **${tool}**`,
      command,
      sessionId: session_id,
      chatId,
      options: options || undefined,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Hook pre-tool error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
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
    console.error('Hook notification error:', error);
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

    await sendCardMessage({
      type: 'authorization_required',
      title,
      content: message || '请在终端中确认操作',
      sessionId,
      chatId,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Hook authorization error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});
