/**
 * Session Manager 服务
 * 负责 spawn Claude CLI 进程、管理会话生命周期、并发控制
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import type { MessageIntent, ActiveSession } from '../types/session.js';
import { sendCardMessage, sendTextMessage } from '../feishu/message.js';
import {
  registerMessageSession,
  getActiveSessionsByChatId,
  storePendingText,
  retrievePendingText,
} from './message-session-map.js';

const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || 'claude';
const MAX_CONCURRENT = parseInt(process.env.SESSION_MAX_CONCURRENT || '5', 10);

/** 运行中的进程 */
const runningProcesses = new Map<string, ChildProcess>();

/** 每个 session 的消息队列（防止同一 session 并发 resume） */
const sessionQueues = new Map<string, Array<{ prompt: string; chatId: string; projectPath: string }>>();

/** 活跃会话信息 */
const activeSessions = new Map<string, ActiveSession>();

/**
 * 根据消息意图路由分发
 */
export async function dispatch(intent: MessageIntent): Promise<void> {
  switch (intent.type) {
    case 'new_task':
      await startNewSession(intent.projectPath, intent.text, intent.chatId);
      break;

    case 'continue_session':
      await continueSession(intent.sessionId, intent.text, intent.chatId, intent.projectPath);
      break;

    case 'choose_session':
      await sendSessionChoiceCard(intent.projectPath, intent.text, intent.chatId, intent.messageId);
      break;
  }
}

/**
 * 启动新 Claude 会话
 */
export async function startNewSession(
  projectPath: string,
  prompt: string,
  chatId: string,
): Promise<string> {
  const sessionId = randomUUID();

  // 发送"任务已开始"卡片
  const result = await sendCardMessage({
    type: 'task_started',
    title: '🚀 任务已开始',
    content: prompt.length > 200 ? prompt.substring(0, 200) + '...' : prompt,
    sessionId,
    chatId,
  });

  // 注册映射
  if (result?.messageId) {
    registerMessageSession(result.messageId, sessionId, chatId, projectPath);
  }

  // Spawn Claude 进程
  await spawnClaudeProcess({ projectPath, prompt, sessionId, chatId });

  return sessionId;
}

/**
 * 继续已有会话 (resume)
 */
export async function continueSession(
  sessionId: string,
  prompt: string,
  chatId: string,
  projectPath: string,
): Promise<void> {
  // 检查是否有进程正在运行
  if (runningProcesses.has(sessionId)) {
    // 加入队列
    const queue = sessionQueues.get(sessionId) || [];
    queue.push({ prompt, chatId, projectPath });
    sessionQueues.set(sessionId, queue);

    await sendTextMessage(`📋 消息已排队，等待当前任务完成后执行`, chatId);
    console.log(`📋 Queued message for session ${sessionId}, queue length: ${queue.length}`);
    return;
  }

  // 发送"追加需求已接收"卡片
  const result = await sendCardMessage({
    type: 'task_started',
    title: '📝 追加需求已接收',
    content: prompt.length > 200 ? prompt.substring(0, 200) + '...' : prompt,
    sessionId,
    chatId,
  });

  if (result?.messageId) {
    registerMessageSession(result.messageId, sessionId, chatId, projectPath);
  }

  // Resume Claude 进程
  await spawnClaudeProcess({ projectPath, prompt, sessionId, chatId, isResume: true });
}

/**
 * 发送会话选择卡片
 */
export async function sendSessionChoiceCard(
  projectPath: string,
  text: string,
  chatId: string,
  messageId: string,
): Promise<void> {
  const sessions = getActiveSessionsByChatId(chatId);

  // 如果没有活跃会话，直接启动新实例
  if (sessions.length === 0) {
    await startNewSession(projectPath, text, chatId);
    return;
  }

  // 暂存原始文本
  const pendingKey = storePendingText(text);

  // 构建会话选择按钮
  const sessionButtons = sessions.slice(0, 3).map((session, index) => {
    const timeAgo = getTimeAgo(session.lastActivity);
    const shortId = session.sessionId.substring(0, 4);
    const label = index === 0 ? `✅ #${shortId} - ${timeAgo} (最近)` : `📌 #${shortId} - ${timeAgo}`;

    return {
      label,
      value: JSON.stringify({
        action: 'choose_session',
        sessionId: session.sessionId,
        projectPath: session.projectPath || projectPath,
        pendingKey,
        chatId,
      }),
    };
  });

  // 添加"启动新实例"按钮
  sessionButtons.push({
    label: '🆕 启动新实例',
    value: JSON.stringify({
      action: 'new_session',
      projectPath,
      pendingKey,
      chatId,
    }),
  });

  await sendCardMessage({
    type: 'session_choice',
    title: '📋 请选择目标会话',
    content: `你的消息: "${text.length > 100 ? text.substring(0, 100) + '...' : text}"`,
    chatId,
    sessionButtons,
  });
}

/**
 * 处理用户点击会话选择按钮
 */
export async function handleSessionChoice(actionValue: {
  action: string;
  sessionId?: string;
  projectPath?: string;
  pendingKey: string;
}, chatId: string): Promise<void> {
  const text = retrievePendingText(actionValue.pendingKey);
  if (!text) {
    await sendTextMessage('⚠️ 消息已过期，请重新发送', chatId);
    return;
  }

  const projectPath = actionValue.projectPath || '';

  if (actionValue.action === 'new_session') {
    await startNewSession(projectPath, text, chatId);
  } else if (actionValue.action === 'choose_session' && actionValue.sessionId) {
    await continueSession(actionValue.sessionId, text, chatId, projectPath);
  }
}

/**
 * Spawn Claude CLI 进程
 */
async function spawnClaudeProcess(opts: {
  projectPath: string;
  prompt: string;
  sessionId: string;
  chatId: string;
  isResume?: boolean;
}): Promise<void> {
  const { projectPath, prompt, sessionId, chatId, isResume } = opts;

  // 检查并发限制
  if (runningProcesses.size >= MAX_CONCURRENT) {
    await sendTextMessage(`⚠️ 当前运行中的任务已达上限 (${MAX_CONCURRENT})，请稍后再试`, chatId);
    return;
  }

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--permission-mode', 'acceptEdits',
  ];

  if (isResume) {
    args.push('--resume', sessionId);
  } else {
    args.push('--session-id', sessionId);
  }

  args.push('-p', prompt);

  console.log(`🚀 Spawning Claude: ${CLAUDE_CLI} ${args.join(' ')} (cwd: ${projectPath})`);

  const child = spawn(CLAUDE_CLI, args, {
    cwd: projectPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 确保 Hook 系统能正确通知飞书
      FEISHU_BRIDGE_URL: process.env.FEISHU_BRIDGE_URL || `http://localhost:${process.env.PORT || 3000}`,
      HOOK_SECRET: process.env.HOOK_SECRET || '',
    },
  });

  runningProcesses.set(sessionId, child);
  activeSessions.set(sessionId, {
    sessionId,
    chatId,
    projectPath,
    lastActivity: Date.now(),
    running: true,
  });

  // 收集 stdout 输出
  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    stdout += chunk;

    // 解析 stream-json 输出，记录进度
    for (const line of chunk.split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant' && event.subtype === 'text') {
          // 更新活跃时间
          const session = activeSessions.get(sessionId);
          if (session) {
            session.lastActivity = Date.now();
          }
        }
      } catch {
        // 非 JSON 行，忽略
      }
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  child.on('error', (error) => {
    console.error(`❌ Claude process error (${sessionId}):`, error);
    runningProcesses.delete(sessionId);
    const session = activeSessions.get(sessionId);
    if (session) {
      session.running = false;
    }

    sendTextMessage(`❌ Claude 进程启动失败: ${error.message}`, chatId).catch(console.error);
  });

  child.on('exit', (code, signal) => {
    console.log(`🏁 Claude process exited (${sessionId}): code=${code}, signal=${signal}`);

    runningProcesses.delete(sessionId);
    const session = activeSessions.get(sessionId);
    if (session) {
      session.running = false;
      session.lastActivity = Date.now();
    }

    // 处理异常退出
    if (code !== 0 && code !== null) {
      const errorMsg = stderr.trim().split('\n').slice(-3).join('\n');
      sendTextMessage(
        `⚠️ Claude 进程异常退出 (code: ${code})${errorMsg ? `\n\`\`\`\n${errorMsg}\n\`\`\`` : ''}`,
        chatId,
      ).catch(console.error);
    }

    // 处理队列中的下一条消息
    processQueue(sessionId);
  });
}

/**
 * 处理会话消息队列
 */
function processQueue(sessionId: string): void {
  const queue = sessionQueues.get(sessionId);
  if (!queue || queue.length === 0) {
    sessionQueues.delete(sessionId);
    return;
  }

  const next = queue.shift()!;
  if (queue.length === 0) {
    sessionQueues.delete(sessionId);
  }

  console.log(`📤 Processing queued message for session ${sessionId}`);
  continueSession(sessionId, next.prompt, next.chatId, next.projectPath).catch(console.error);
}

/**
 * 获取人类可读的时间差
 */
function getTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;

  return `${Math.floor(hours / 24)}天前`;
}

/**
 * 获取运行中的进程数
 */
export function getRunningCount(): number {
  return runningProcesses.size;
}
