/** 消息路由分类 */
export type MessageIntent =
  | { type: 'new_task'; text: string; chatId: string; projectPath: string }
  | { type: 'continue_session'; text: string; sessionId: string; chatId: string; projectPath: string }
  | { type: 'choose_session'; text: string; chatId: string; projectPath: string; messageId: string };

/** 活跃会话信息 */
export interface ActiveSession {
  sessionId: string;
  chatId: string;
  projectPath: string;
  lastActivity: number;
  /** 是否有进程正在运行 */
  running: boolean;
}
