/**
 * 任务摘要相关类型定义
 */

/** 工具使用统计 */
export interface ToolStats {
  bash: number;
  edit: number;
  write: number;
  read: number;
  glob: number;
  grep: number;
  task: number;
}

/** 从 transcript 提取的原始摘要数据 */
export interface RawSummary {
  projectPath: string;
  projectName: string;
  gitBranch: string;
  sessionId: string;
  sessionShortId: string;
  taskDescription: string;
  completionMessage: string;
  toolStats: ToolStats;
  filesModified: string[];
  filesCreated: string[];
  duration: number; // 秒
  timestamp: string;
}

/** 完整的任务摘要（含 Haiku 生成的摘要） */
export interface TaskSummary extends RawSummary {
  /** Haiku 生成的一句话摘要 */
  summary?: string;
}

/** 项目群信息 */
export interface GroupInfo {
  chatId: string;
  projectName: string;
  projectPath: string;
  createdAt: string;
  /** Phase4: 管理员用户ID（用于接收语音提醒） */
  adminUserId?: string;
  /** Phase4: 是否启用语音提醒 */
  enableVoiceAlert?: boolean;
}

/** 项目群映射存储结构 */
export type GroupMappings = Record<string, GroupInfo>;

/** Hook stop 事件的 payload */
export interface StopHookPayload {
  session_id: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
  hook_event_name?: string;
  stop_reason?: string;
  cwd?: string;
  project_dir?: string;
  message?: string;
  // 从 notify.js 提取的摘要
  summary?: RawSummary;
  timestamp?: string;
}

/** 授权选项映射 */
export const AUTH_OPTION_MAP: Record<string, string> = {
  'yes': '允许',
  'no': '拒绝',
  'yes, always': '始终允许',
  'yes, and don\'t ask again': '始终允许',
  'yes, and don\'t ask again for this session': '本会话始终允许',
  'yes, and don\'t ask again for this project': '本项目始终允许',
  "yes, don't ask again for this project": '本项目始终允许',
  "yes, don't ask again": '始终允许',
  'yes, always allow': '始终允许',
  'allow': '允许',
  'deny': '拒绝',
  'allow once': '仅本次允许',
  'allow for this session': '本会话允许',
  'allow always': '始终允许',
};

/** 获取中文授权选项 */
export function getChineseAuthOption(option: string): string {
  const lower = option.toLowerCase().trim();
  return AUTH_OPTION_MAP[lower] || option;
}
