/**
 * message_id → session_id 映射服务
 * 内存 Map + 文件持久化 + TTL 自动清理
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const MAP_FILE = path.join(DATA_DIR, 'message-session-map.json');

/** TTL: 24 小时 */
const TTL_MS = 24 * 60 * 60 * 1000;

/** 清理间隔: 1 小时 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

interface MapEntry {
  sessionId: string;
  chatId: string;
  projectPath?: string;
  createdAt: number;
}

/** 内存映射 */
const messageSessionMap = new Map<string, MapEntry>();

/** chat_id → 最近活跃的 session_id 列表 (按时间倒序) */
const chatSessionMap = new Map<string, Array<{ sessionId: string; projectPath?: string; lastActivity: number }>>();

/** 暂存的原始文本 (用于选择卡片场景) */
const pendingTextMap = new Map<string, { text: string; createdAt: number }>();

/**
 * 初始化：从文件恢复映射
 */
export function initMessageSessionMap(): void {
  try {
    if (fs.existsSync(MAP_FILE)) {
      const data = JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'));
      const now = Date.now();

      if (data.messageSession) {
        for (const [key, entry] of Object.entries(data.messageSession)) {
          const e = entry as MapEntry;
          if (now - e.createdAt < TTL_MS) {
            messageSessionMap.set(key, e);
          }
        }
      }

      if (data.chatSession) {
        for (const [chatId, sessions] of Object.entries(data.chatSession)) {
          const validSessions = (sessions as Array<{ sessionId: string; projectPath?: string; lastActivity: number }>)
            .filter(s => now - s.lastActivity < TTL_MS);
          if (validSessions.length > 0) {
            chatSessionMap.set(chatId, validSessions);
          }
        }
      }

      console.log(`📂 Restored ${messageSessionMap.size} message-session mappings`);
    }
  } catch (error) {
    console.error('Failed to restore message-session map:', error);
  }

  // 启动定时清理
  setInterval(cleanup, CLEANUP_INTERVAL_MS);
}

/**
 * 注册 message_id → session_id 映射
 */
export function registerMessageSession(
  messageId: string,
  sessionId: string,
  chatId: string,
  projectPath?: string,
): void {
  const entry: MapEntry = {
    sessionId,
    chatId,
    projectPath,
    createdAt: Date.now(),
  };

  messageSessionMap.set(messageId, entry);

  // 更新 chat → session 映射
  updateChatSession(chatId, sessionId, projectPath);

  // 异步持久化
  persistToDisk();
}

/**
 * 通过 message_id 查询 session_id
 */
export function getSessionByMessageId(messageId: string): MapEntry | null {
  const entry = messageSessionMap.get(messageId);
  if (!entry) return null;

  // 检查 TTL
  if (Date.now() - entry.createdAt > TTL_MS) {
    messageSessionMap.delete(messageId);
    return null;
  }

  return entry;
}

/**
 * 获取某个群最近活跃的会话列表
 */
export function getActiveSessionsByChatId(chatId: string): Array<{ sessionId: string; projectPath?: string; lastActivity: number }> {
  const sessions = chatSessionMap.get(chatId);
  if (!sessions) return [];

  const now = Date.now();
  return sessions
    .filter(s => now - s.lastActivity < TTL_MS)
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, 10); // 最多返回 10 条
}

/**
 * 获取某个群最近的一个 session
 */
export function getLatestSessionByChatId(chatId: string): { sessionId: string; projectPath?: string } | null {
  const sessions = getActiveSessionsByChatId(chatId);
  return sessions.length > 0 ? sessions[0] : null;
}

/**
 * 暂存用户发送的原始文本（用于选择卡片场景）
 * 返回暂存 key
 */
export function storePendingText(text: string): string {
  const key = `pending_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  pendingTextMap.set(key, { text, createdAt: Date.now() });
  return key;
}

/**
 * 取出暂存的文本
 */
export function retrievePendingText(key: string): string | null {
  const entry = pendingTextMap.get(key);
  if (!entry) return null;

  // 10 分钟过期
  if (Date.now() - entry.createdAt > 10 * 60 * 1000) {
    pendingTextMap.delete(key);
    return null;
  }

  pendingTextMap.delete(key);
  return entry.text;
}

/**
 * 更新 chat → session 映射
 */
function updateChatSession(chatId: string, sessionId: string, projectPath?: string): void {
  const sessions = chatSessionMap.get(chatId) || [];

  // 如果已存在该 session，更新时间
  const existing = sessions.find(s => s.sessionId === sessionId);
  if (existing) {
    existing.lastActivity = Date.now();
    existing.projectPath = projectPath;
  } else {
    sessions.unshift({ sessionId, projectPath, lastActivity: Date.now() });
  }

  // 保持最多 20 条
  if (sessions.length > 20) {
    sessions.length = 20;
  }

  chatSessionMap.set(chatId, sessions);
}

/**
 * 持久化到磁盘
 */
function persistToDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const data = {
      messageSession: Object.fromEntries(messageSessionMap),
      chatSession: Object.fromEntries(chatSessionMap),
    };

    fs.writeFileSync(MAP_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Failed to persist message-session map:', error);
  }
}

/**
 * 清理过期条目
 */
function cleanup(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, entry] of messageSessionMap) {
    if (now - entry.createdAt > TTL_MS) {
      messageSessionMap.delete(key);
      cleaned++;
    }
  }

  for (const [chatId, sessions] of chatSessionMap) {
    const valid = sessions.filter(s => now - s.lastActivity < TTL_MS);
    if (valid.length === 0) {
      chatSessionMap.delete(chatId);
    } else if (valid.length !== sessions.length) {
      chatSessionMap.set(chatId, valid);
    }
  }

  // 清理暂存文本
  for (const [key, entry] of pendingTextMap) {
    if (now - entry.createdAt > 10 * 60 * 1000) {
      pendingTextMap.delete(key);
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired message-session mappings`);
    persistToDisk();
  }
}
