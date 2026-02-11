/**
 * 飞书群管理服务
 * 负责项目群的自动创建和映射管理
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { feishuClient } from './client.js';
import type { GroupInfo, GroupMappings } from '../types/summary.js';
import { log } from '../utils/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const MAPPINGS_FILE = path.join(DATA_DIR, 'project-groups.json');

/**
 * 已知无效的群 chatId 集合 (Phase3)
 * 只有发消息失败时才会加入，避免主动验证带来的误判
 */
const invalidChatIds = new Set<string>();

/**
 * 标记一个群为无效（由消息发送失败时调用） (Phase3)
 */
export function markChatInvalid(chatId: string): void {
  invalidChatIds.add(chatId);
  log('warn', 'group_marked_invalid', { chatId });
}

/**
 * 加载项目群映射
 */
export function loadGroupMappings(): GroupMappings {
  try {
    if (fs.existsSync(MAPPINGS_FILE)) {
      const data = fs.readFileSync(MAPPINGS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Failed to load group mappings:', error);
  }
  return {};
}

/**
 * 保存项目群映射
 */
export function saveGroupMapping(projectPath: string, info: GroupInfo): void {
  try {
    // 确保目录存在
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const mappings = loadGroupMappings();
    mappings[projectPath] = info;
    fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(mappings, null, 2));
    console.log(`✅ Saved group mapping: ${projectPath} -> ${info.chatId}`);
  } catch (error) {
    console.error('Failed to save group mapping:', error);
    throw error;
  }
}

/**
 * 从项目路径提取项目名
 * 直接使用最后的目录名（包括worktree分支名）
 */
export function extractProjectName(projectPath: string): string {
  // 直接使用最后一级目录名
  // 例如：/path/to/feishu-claude-bridge-worktrees/integration → integration
  return path.basename(projectPath);
}

/**
 * 获取项目的规范化路径
 * 不做任何归一化，每个目录独立映射（包括worktree分支）
 */
export function getNormalizedProjectPath(projectPath: string): string {
  // 直接返回原始路径，不做归一化
  // 这样每个worktree分支都有独立的群
  return projectPath;
}

/**
 * 创建飞书群
 */
export async function createGroup(projectName: string): Promise<string> {
  const targetUserId = process.env.FEISHU_TARGET_ID;

  if (!targetUserId) {
    throw new Error('FEISHU_TARGET_ID not configured');
  }

  try {
    const response = await feishuClient.im.chat.create({
      params: {
        user_id_type: 'open_id',
      },
      data: {
        name: `🤖 ${projectName}`,
        description: `Claude Code 项目通知群 - ${projectName}`,
        user_id_list: [targetUserId],
        chat_mode: 'group',
        chat_type: 'private',
      },
    });

    const chatId = response.data?.chat_id;
    if (!chatId) {
      throw new Error('Failed to get chat_id from response');
    }

    console.log(`✅ Created Feishu group: ${projectName} (${chatId})`);
    return chatId;
  } catch (error) {
    console.error('Failed to create Feishu group:', error);
    throw error;
  }
}

/**
 * 获取或创建项目对应的群
 */
export async function getOrCreateProjectGroup(projectPath: string): Promise<string> {
  // 规范化路径（worktree 归到主项目）
  const normalizedPath = getNormalizedProjectPath(projectPath);
  const projectName = extractProjectName(projectPath);

  // 检查是否已有映射
  const mappings = loadGroupMappings();
  const existing = mappings[normalizedPath];

  if (existing) {
    console.log(`📍 Using existing group for ${projectName}: ${existing.chatId}`);
    return existing.chatId;
  }

  // 创建新群
  console.log(`🆕 Creating new group for project: ${projectName}`);
  const chatId = await createGroup(projectName);

  // 保存映射
  saveGroupMapping(normalizedPath, {
    chatId,
    projectName,
    projectPath: normalizedPath,
    createdAt: new Date().toISOString(),
  });

  return chatId;
}

/**
 * 根据群 ID 反查项目路径
 */
export function getProjectPathByChatId(chatId: string): string | null {
  const mappings = loadGroupMappings();
  for (const [projectPath, info] of Object.entries(mappings)) {
    if (info.chatId === chatId) {
      return projectPath;
    }
  }
  return null;
}
