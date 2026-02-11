import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { Router } from 'express';
import { sendTextMessage, sendCardMessage, updateCardMessage, type SendMessageOptions, type SendCardResult } from '../feishu/message.js';
import { getOrCreateProjectGroup } from '../feishu/group.js';
import { generateTaskSummary, generateDefaultSummary } from '../services/summary.js';
import { generateCommandExplanation } from '../services/command-explain.js';
import { registerMessageSession, getSessionRootMessage, setSessionRootMessage } from '../services/message-session-map.js';
import { alertScheduler } from '../services/voice-alert.js';
import { log } from '../utils/log.js';
import type { RawSummary, StopHookPayload, ToolStats } from '../types/summary.js';
import { authStore } from '../store/auth-store.js';
import { permissionRules } from '../store/permission-rules.js';

export const hookRouter = Router();

// Title tag helper (copied from phase3)
function buildTitleTag(cwd?: string, sessionId?: string): string {
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

  console.log('[DEBUG] Hook auth:', {
    received: secret,
    expected: expectedSecret,
    match: secret === expectedSecret
  });

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
    console.log('[DEBUG] Stop hook full body:', JSON.stringify(body, null, 2));
    const { session_id, summary, stop_reason, cwd, project_dir, message } = body;

    const projectRoot = project_dir || cwd || summary?.projectPath;

    console.log('📨 Stop hook received:', {
      session_id,
      stop_reason,
      hasSummary: !!summary,
      projectRoot,
    });

    // 获取或创建项目群
    let chatId: string | undefined;
    if (projectRoot) {
      try {
        chatId = await getOrCreateProjectGroup(projectRoot);
      } catch (error) {
        console.error('Failed to get/create project group:', error);
      }
    }

    // Build dynamic title
    const tag = buildTitleTag(projectRoot, session_id);
    const title = tag ? `✅ ${tag} 任务完成` : '✅ Claude Code 任务完成';

    // 查找该 session 的根消息 ID（用于线程回复）
    const rootMessageId = session_id ? getSessionRootMessage(session_id) : null;

    // 发送初始卡片（不含 Haiku 摘要）
    const result = await sendCardMessage({
      type: 'task_complete',
      title,
      sessionId: session_id,
      chatId,
      summary: summary || undefined,
      replyToMessageId: rootMessageId || undefined,
    });

    // 注册 message → session 映射 + 记录根消息
    if (result?.messageId && session_id) {
      registerMessageSession(result.messageId, session_id, result.chatId, summary?.projectPath);
      setSessionRootMessage(session_id, result.messageId);
    }

    // Phase4: 安排任务完成超时提醒（向群发送，与其他phase一致）
    if (result?.messageId && chatId && process.env.FEISHU_VOICE_ENABLED === 'true') {
      const delayMinutes = parseInt(process.env.VOICE_ALERT_TASK_COMPLETE_DELAY_MINUTES || '10');
      alertScheduler.scheduleAlert(result.messageId, {
        chatId,
        sessionId: session_id,
        type: 'task_complete',
        delayMinutes,
      });
    }

    // 异步生成 Haiku 摘要并更新卡片
    if (result?.messageId && summary) {
      generateHaikuSummaryAndUpdate(result.messageId, summary, session_id, chatId, projectRoot);
    } else if (result?.messageId && body.transcript_path) {
      // Claude Code Stop事件不直接提供summary，但提供transcript_path
      // 从transcript文件提取摘要数据
      extractSummaryFromTranscript(body.transcript_path, projectRoot)
        .then((extractedSummary) => {
          if (extractedSummary) {
            generateHaikuSummaryAndUpdate(result.messageId, extractedSummary, session_id, chatId, projectRoot);
          }
        })
        .catch((err) => {
          console.error('Failed to extract summary from transcript:', err);
        });
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
  chatId?: string,
  projectRoot?: string
): Promise<void> {
  try {
    const haikuSummary = await generateTaskSummary(summary);

    if (haikuSummary) {
      const tag = buildTitleTag(projectRoot || summary.projectPath, sessionId);
      const title = tag ? `✅ ${tag} 任务完成` : '✅ Claude Code 任务完成';

      await updateCardMessage(messageId, {
        type: 'task_complete',
        title,
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
 * 从 Claude Code transcript 文件提取摘要数据
 * transcript 是 JSONL 格式，每行一个JSON对象
 */
async function extractSummaryFromTranscript(
  transcriptPath: string,
  projectRoot?: string,
): Promise<RawSummary | null> {
  try {
    if (!fs.existsSync(transcriptPath)) {
      console.log('[transcript] File not found:', transcriptPath);
      return null;
    }

    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    if (lines.length === 0) return null;

    // 解析所有行
    const entries: any[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }

    // 提取用户的第一条消息作为任务描述
    const firstUserMsg = entries.find(e => e.type === 'human' || e.role === 'user');
    let taskDescription = '';
    if (firstUserMsg) {
      const msgContent = firstUserMsg.content || firstUserMsg.message?.content || '';
      if (typeof msgContent === 'string') {
        taskDescription = msgContent.substring(0, 200);
      } else if (Array.isArray(msgContent)) {
        const textPart = msgContent.find((p: any) => p.type === 'text');
        taskDescription = textPart?.text?.substring(0, 200) || '';
      }
    }

    // 提取最后一条助手消息作为完成消息
    const lastAssistantMsg = [...entries].reverse().find(e => e.type === 'assistant' || e.role === 'assistant');
    let completionMessage = '';
    if (lastAssistantMsg) {
      const msgContent = lastAssistantMsg.content || lastAssistantMsg.message?.content || '';
      if (typeof msgContent === 'string') {
        completionMessage = msgContent.substring(0, 200);
      } else if (Array.isArray(msgContent)) {
        const textParts = msgContent.filter((p: any) => p.type === 'text');
        completionMessage = textParts.map((p: any) => p.text).join(' ').substring(0, 200);
      }
    }

    // 统计工具使用
    const toolStats: ToolStats = { bash: 0, edit: 0, write: 0, read: 0, glob: 0, grep: 0, task: 0 };
    const filesModified = new Set<string>();
    const filesCreated = new Set<string>();

    for (const entry of entries) {
      const content = entry.content || entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_use') {
          const name = (block.name || '').toLowerCase();
          if (name in toolStats) {
            toolStats[name as keyof ToolStats]++;
          }
          // 跟踪文件修改
          const input = block.input || {};
          if (name === 'edit' && input.file_path) filesModified.add(input.file_path);
          if (name === 'write' && input.file_path) filesCreated.add(input.file_path);
        }
      }
    }

    // 计算持续时间
    const firstEntry = entries[0];
    const lastEntry = entries[entries.length - 1];
    const startTime = firstEntry?.timestamp ? new Date(firstEntry.timestamp).getTime() : Date.now();
    const endTime = lastEntry?.timestamp ? new Date(lastEntry.timestamp).getTime() : Date.now();
    const duration = Math.round((endTime - startTime) / 1000);

    const sessionId = path.basename(transcriptPath, '.jsonl');

    const summary: RawSummary = {
      projectPath: projectRoot || '',
      projectName: projectRoot ? path.basename(projectRoot) : '',
      gitBranch: '',
      sessionId,
      sessionShortId: sessionId.substring(0, 8),
      taskDescription,
      completionMessage,
      toolStats,
      filesModified: [...filesModified],
      filesCreated: [...filesCreated],
      duration,
      timestamp: new Date().toISOString(),
    };

    console.log('[transcript] Extracted summary:', {
      taskDescription: taskDescription.substring(0, 50),
      toolUses: Object.entries(toolStats).filter(([_, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(', '),
      filesModified: filesModified.size,
      filesCreated: filesCreated.size,
      duration,
    });

    return summary;
  } catch (error) {
    console.error('[transcript] Failed to extract summary:', error);
    return null;
  }
}

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

    // 获取或创建项目群
    let chatId: string | undefined;
    if (projectRoot) {
      try {
        chatId = await getOrCreateProjectGroup(projectRoot);
      } catch (error) {
        console.error('Failed to get/create project group:', error);
      }
    }

    // Build dynamic title
    const tag = buildTitleTag(cwd, session_id);
    const authTitle = tag ? `🔔 ${tag} 需要授权` : '🔔 Claude 需要授权';

    // AI command explanation (best-effort with timeout, don't block response if it fails)
    let commandSummary: string | undefined;
    let optionExplanations: import('../services/command-explain.js').OptionExplanation[] | undefined;
    try {
      const explainTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000));
      const explanation = await Promise.race([
        generateCommandExplanation(toolName, command || '', resolvedOptions, cwd),
        explainTimeout,
      ]);
      if (explanation) {
        commandSummary = explanation.summary;
        optionExplanations = explanation.options;
      }
    } catch (error) {
      log('warn', 'command_explain_failed', { error: String(error) });
    }

    // 查找该 session 的根消息 ID（用于线程回复）
    const rootMessageId = session_id ? getSessionRootMessage(session_id) : null;

    // Send Feishu authorization card
    const result = await sendWithRetry({
      type: 'authorization_required',
      title: authTitle,
      content: `工具: **${toolName}**`,
      command,
      sessionId: session_id,
      options: resolvedOptions,
      chatId,
      requestId: authRequest.requestId,
      commandSummary,
      optionExplanations,
      replyToMessageId: rootMessageId || undefined,
    }, projectRoot);

    // Store feishu message ID for later card update
    if (result) {
      authRequest.feishuMessageId = result.messageId;
      authRequest.chatId = result.chatId;
    }

    // 注册 message → session 映射 + 记录根消息
    if (result?.messageId && session_id) {
      registerMessageSession(result.messageId, session_id, result.chatId, cwd);
      setSessionRootMessage(session_id, result.messageId);
    }

    // Phase4: 安排授权请求超时提醒
    if (result?.messageId && chatId && process.env.FEISHU_VOICE_ENABLED === 'true') {
      const delayMinutes = parseInt(process.env.VOICE_ALERT_AUTHORIZATION_DELAY_MINUTES || '5');
      alertScheduler.scheduleAlert(result.messageId, {
        chatId,
        sessionId: session_id,
        type: 'authorization',
        delayMinutes,
      });
    }

    res.json({ success: true, requestId: authRequest.requestId });
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

    // 获取或创建项目群
    let chatId: string | undefined;
    if (projectRoot) {
      try {
        chatId = await getOrCreateProjectGroup(projectRoot);
      } catch (error) {
        console.error('Failed to get/create project group:', error);
      }
    }

    const tag = buildTitleTag(cwd, session_id);
    const title = tag ? `🔔 ${tag} 通知` : '🔔 Claude Code 通知';

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
 * Also handles generic notifications when called without options
 */
hookRouter.post('/authorization', async (req, res) => {
  try {
    const body = req.body;
    console.log('📨 Authorization request received:', JSON.stringify(body, null, 2));

    const message = body.message || body.body || '';
    const sessionId = body.session_id || 'unknown';
    const cwd = body.cwd;

    // Build dynamic title
    const tag = buildTitleTag(cwd, sessionId);

    // 区分普通通知和授权请求：没有 tool_name/tool 字段的是普通通知
    const isNotification = !body.tool_name && !body.tool;
    const title = body.title || (tag
      ? (isNotification ? `🔔 ${tag} 通知` : `⚠️ ${tag} 需要你的操作`)
      : (isNotification ? '🔔 Claude Code 通知' : '⚠️ Claude 需要你的操作'));

    // 获取或创建项目群
    let chatId: string | undefined;
    if (cwd) {
      try {
        chatId = await getOrCreateProjectGroup(cwd);
      } catch (error) {
        console.error('Failed to get/create project group:', error);
      }
    }

    // 查找该 session 的根消息 ID（用于线程回复）
    const rootMessageId = sessionId ? getSessionRootMessage(sessionId) : null;

    const result = await sendCardMessage({
      type: 'authorization_required',
      title,
      content: message || '请在终端中确认操作',
      sessionId,
      chatId,
      replyToMessageId: rootMessageId || undefined,
    });

    // 注册 message → session 映射 + 记录根消息
    if (result?.messageId && sessionId) {
      registerMessageSession(result.messageId, sessionId, result.chatId, cwd);
      setSessionRootMessage(sessionId, result.messageId);
    }

    // Phase4: 安排授权请求超时提醒
    if (result?.messageId && chatId && process.env.FEISHU_VOICE_ENABLED === 'true') {
      const delayMinutes = parseInt(process.env.VOICE_ALERT_AUTHORIZATION_DELAY_MINUTES || '5');
      alertScheduler.scheduleAlert(result.messageId, {
        chatId,
        sessionId,
        type: 'authorization',
        delayMinutes,
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Hook authorization error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

