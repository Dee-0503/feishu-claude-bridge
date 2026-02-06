import { Router } from 'express';
import { sendTextMessage, sendCardMessage } from '../feishu/message.js';

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
 * Called when Claude Code stops (task complete or waiting for input)
 */
hookRouter.post('/stop', async (req, res) => {
  try {
    const { session_id, cwd, message } = req.body;

    await sendCardMessage({
      type: 'task_complete',
      title: '✅ Claude Code 任务完成',
      content: message || '任务已完成，等待下一步指令',
      sessionId: session_id,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Hook stop error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

/**
 * POST /api/hook/pre-tool
 * Called before a tool is executed (for sensitive commands)
 */
hookRouter.post('/pre-tool', async (req, res) => {
  try {
    const { session_id, tool, tool_input, options } = req.body;

    // Extract command for Bash tool
    const command = tool === 'Bash' ? tool_input?.command : JSON.stringify(tool_input);

    await sendCardMessage({
      type: options ? 'authorization_required' : 'sensitive_command',
      title: options ? '⚠️ Claude 需要授权' : '🔔 敏感命令执行',
      content: `工具: **${tool}**`,
      command,
      sessionId: session_id,
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
    const { message } = req.body;

    await sendTextMessage(message || 'Claude Code notification');

    res.json({ success: true });
  } catch (error) {
    console.error('Hook notification error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});
