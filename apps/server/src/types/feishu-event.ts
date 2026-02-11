/** 飞书消息事件结构 */
export interface FeishuMessageEvent {
  sender: {
    sender_id: { open_id: string };
    sender_type: string;
  };
  message: {
    message_id: string;
    parent_id?: string;
    chat_id: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: { open_id: string };
      name: string;
    }>;
  };
}

/** 飞书卡片动作事件 */
export interface FeishuCardActionEvent {
  operator: {
    open_id: string;
  };
  action: {
    value: string;
    tag: string;
  };
  context?: {
    open_message_id?: string;
    open_chat_id?: string;
  };
}

/** 解析后的飞书消息 */
export interface ParsedFeishuMessage {
  rawText: string;
  cleanText: string;
  isBotMentioned: boolean;
  isReply: boolean;
  parentMessageId?: string;
  chatId: string;
  messageId: string;
  senderOpenId: string;
}
