/**
 * Phase 3: 远程授权相关类型定义
 */

/** 终端信息（用于日志/调试） */
export interface TerminalInfo {
  pid: number;
  cwd: string;
}

/** 授权请求 */
export interface AuthRequest {
  requestId: string;
  sessionId: string;
  tool: string;
  toolInput: any;
  command?: string;
  options: string[];
  cwd?: string;
  status: 'pending' | 'resolved' | 'expired';
  decision?: 'allow' | 'deny';
  decisionReason?: string;
  createdAt: number;
  resolvedAt?: number;
  feishuMessageId?: string;
  chatId?: string;
}

/** 权限规则（"始终允许"持久化） */
export interface PermissionRule {
  id: string;
  tool: string;
  commandPattern?: string;
  projectPath?: string;
  scope: 'always' | 'project';
  createdAt: string;
}

/** 项目群信息 */
export interface GroupInfo {
  chatId: string;
  projectName: string;
  projectPath: string;
  createdAt: string;
}

/** 项目群映射存储结构 */
export type GroupMappings = Record<string, GroupInfo>;

/** 授权选项中英文映射 */
export const AUTH_OPTION_MAP: Record<string, string> = {
  'yes': '允许',
  'no': '拒绝',
  'yes, always': '始终允许',
  "yes, don't ask again for this project": '本项目始终允许',
  "yes, don't ask again": '始终允许',
  'allow': '允许',
  'deny': '拒绝',
  'allow once': '仅本次允许',
  'allow for this session': '本会话允许',
};

/** 获取中文授权选项 */
export function getChineseAuthOption(option: string): string {
  const lower = option.toLowerCase().trim();
  return AUTH_OPTION_MAP[lower] || option;
}
