/**
 * 飞书群管理服务
 * 负责项目群的自动创建和映射管理
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { feishuClient } from './client.js';
import type { GroupInfo, GroupMappings } from '../types/summary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const MAPPINGS_FILE = path.join(DATA_DIR, 'project-groups.json');

// 机器人自己的 user_id（用于创建群时添加）
const BOT_USER_ID = process.env.FEISHU_BOT_USER_ID || '';

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
 */
export function extractProjectName(projectPath: string): string {
  // 处理 worktree 路径，提取真实项目名
  // 例如：/Users/ceemac/my_product/feishu-claude-bridge-worktrees/phase2
  // 应该返回：feishu-claude-bridge

  const baseName = path.basename(projectPath);

  // 检查是否是 worktree 目录
  if (projectPath.includes('-worktrees/')) {
    const match = projectPath.match(/\/([^/]+)-worktrees\//);
    if (match) {
      return match[1];
    }
  }

  return baseName;
}

/**
 * 获取项目的规范化路径（worktree 返回主项目路径）
 */
export function getNormalizedProjectPath(projectPath: string): string {
  // 如果是 worktree，返回主项目路径
  if (projectPath.includes('-worktrees/')) {
    const match = projectPath.match(/^(.+)-worktrees\/.+$/);
    if (match) {
      return match[1];
    }
  }
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
