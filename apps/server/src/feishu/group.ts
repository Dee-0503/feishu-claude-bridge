/**
 * 飞书群管理服务
 * 负责项目群的自动创建和映射管理
 * Migrated from phase1 with adaptations for phase3
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { feishuClient } from './client.js';
import type { GroupInfo, GroupMappings } from '../types/auth.js';
import { log } from '../utils/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const MAPPINGS_FILE = path.join(DATA_DIR, 'project-groups.json');

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
    log('error', 'group_mappings_load_failed', { error: String(error) });
  }
  return {};
}

/**
 * 保存项目群映射
 */
export function saveGroupMapping(projectPath: string, info: GroupInfo): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const mappings = loadGroupMappings();
    mappings[projectPath] = info;
    fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(mappings, null, 2));
    log('info', 'group_mapping_saved', { projectPath, chatId: info.chatId });
  } catch (error) {
    log('error', 'group_mapping_save_failed', { error: String(error) });
    throw error;
  }
}

/**
 * 从项目路径提取项目名（用于群名显示）
 * 直接用目录的 basename，不做 worktree 归一化
 */
export function extractProjectName(projectPath: string): string {
  return path.basename(projectPath);
}

/**
 * 获取项目的规范化路径
 * 直接透传，不做 worktree 归一化——每个 cwd 独立一个群
 */
export function getNormalizedProjectPath(projectPath: string): string {
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

    log('info', 'feishu_group_created', { projectName, chatId });
    return chatId;
  } catch (error) {
    log('error', 'feishu_group_create_failed', { projectName, error: String(error) });
    throw error;
  }
}

/**
 * 已知无效的群 chatId 集合
 * 只有发消息失败时才会加入，避免主动验证带来的误判
 */
const invalidChatIds = new Set<string>();

/**
 * 标记一个群为无效（由消息发送失败时调用）
 */
export function markChatInvalid(chatId: string): void {
  invalidChatIds.add(chatId);
  log('warn', 'group_marked_invalid', { chatId });
}

/**
 * 获取或创建项目对应的群
 */
export async function getOrCreateProjectGroup(projectPath: string): Promise<string> {
  const normalizedPath = getNormalizedProjectPath(projectPath);
  const projectName = extractProjectName(projectPath);

  log('info', 'group_lookup', { projectPath, normalizedPath });

  const mappings = loadGroupMappings();
  const existing = mappings[normalizedPath];

  if (existing && !invalidChatIds.has(existing.chatId)) {
    log('info', 'group_existing_found', { projectName, chatId: existing.chatId });
    return existing.chatId;
  }

  if (existing) {
    log('warn', 'group_chat_invalid', { projectName, chatId: existing.chatId });
  }

  log('info', 'group_creating_new', { projectName });
  const chatId = await createGroup(projectName);

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
