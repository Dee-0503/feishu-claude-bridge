import { feishuClient } from './client.js';
import { getChineseAuthOption } from '../types/auth.js';
import type { OptionExplanation } from '../services/command-explain.js';
import { markChatInvalid } from './group.js';
import { log } from '../utils/log.js';

export type MessageType =
  | 'task_complete'
  | 'authorization_required'
  | 'sensitive_command'
  | 'authorization_resolved';

export interface SendMessageOptions {
  type: MessageType;
  title: string;
  content?: string;
  sessionId?: string;
  command?: string;
  options?: string[];
  /** 动态指定群 ID，不传则使用环境变量 */
  chatId?: string;
  /** 授权请求 ID（按钮 value 中携带） */
  requestId?: string;
  /** AI 生成的命令解释摘要 */
  commandSummary?: string;
  /** AI 生成的每个选项的解释 */
  optionExplanations?: OptionExplanation[];
}

export interface SendCardResult {
  messageId: string;
  chatId: string;
}

/**
 * Send a text message to the configured target
 */
export async function sendTextMessage(text: string, chatId?: string): Promise<void> {
  const targetType = chatId ? 'chat_id' : (process.env.FEISHU_TARGET_TYPE || 'open_id');
  const targetId = chatId || process.env.FEISHU_TARGET_ID;

  if (!targetId) {
    log('error', 'feishu_target_not_configured', {});
    return;
  }

  try {
    const response = await feishuClient.im.message.create({
      params: {
        receive_id_type: targetType as 'open_id' | 'chat_id' | 'user_id',
      },
      data: {
        receive_id: targetId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu API error ${response.code}: ${response.msg}`);
    }

    log('info', 'text_message_sent', { text: text.substring(0, 50) });
  } catch (error) {
    if (targetType === 'chat_id' && chatId) {
      markChatInvalid(chatId);
    }
    log('error', 'text_message_send_failed', { error: String(error) });
    throw error;
  }
}

/**
 * Send an interactive card message with buttons
 * Returns the message ID for later updates
 */
export async function sendCardMessage(options: SendMessageOptions): Promise<SendCardResult | null> {
  const targetType = options.chatId ? 'chat_id' : (process.env.FEISHU_TARGET_TYPE || 'open_id');
  const targetId = options.chatId || process.env.FEISHU_TARGET_ID;

  if (!targetId) {
    log('error', 'feishu_target_not_configured', {});
    return null;
  }

  const card = buildCard(options);

  try {
    const response = await feishuClient.im.message.create({
      params: {
        receive_id_type: targetType as 'open_id' | 'chat_id' | 'user_id',
      },
      data: {
        receive_id: targetId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu API error ${response.code}: ${response.msg}`);
    }

    const messageId = response.data?.message_id || '';
    log('info', 'card_message_sent', { title: options.title, messageId });

    return { messageId, chatId: targetId };
  } catch (error) {
    if (targetType === 'chat_id' && options.chatId) {
      markChatInvalid(options.chatId);
    }
    log('error', 'feishu_card_send_failed', { title: options.title, error: String(error) });
    throw error;
  }
}

/**
 * Update an existing card message (e.g., after authorization decision)
 * For WebSocket mode: uses im.message.patch API for async updates
 * For HTTP mode: card is returned in callback response (responsive update)
 */
export async function updateCardMessage(
  messageId: string,
  options: SendMessageOptions
): Promise<void> {
  const card = buildCard(options);

  // 添加调试日志
  log('info', 'card_update_payload', {
    messageId,
    type: options.type,
    hasButtons: JSON.stringify(card).includes('"tag":"action"'),
    cardKeys: Object.keys(card),
  });

  try {
    // Use im.message.patch for WebSocket mode async updates
    const response = await feishuClient.im.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify(card),
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu API error ${response.code}: ${response.msg}`);
    }

    log('info', 'card_message_updated', { messageId });
  } catch (error: any) {
    log('error', 'card_message_update_failed', {
      messageId,
      error: String(error),
      errorData: error.response?.data,
    });
    throw error;
  }
}

export function buildCard(options: SendMessageOptions): object {
  const {
    type, title, content, sessionId, command,
    options: authOptions, requestId, commandSummary, optionExplanations,
  } = options;

  // Header color based on message type
  const headerColor: Record<MessageType, string> = {
    task_complete: 'green',
    authorization_required: 'orange',
    sensitive_command: 'red',
    authorization_resolved: 'grey',
  };

  const elements: object[] = [];

  // AI command summary (displayed prominently above the command)
  if (commandSummary) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**解释**: ${commandSummary}`,
      },
    });
  }

  // Content
  if (content) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content,
      },
    });
  }

  // Command info
  if (command) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**命令**: \`${command}\``,
      },
    });
  }

  // Authorization buttons with per-button explanations
  if (type !== 'authorization_resolved' && authOptions && authOptions.length > 0) {
    // Build explanation map for quick lookup
    const explainMap = new Map<string, OptionExplanation>();
    if (optionExplanations) {
      for (const exp of optionExplanations) {
        explainMap.set(exp.option, exp);
      }
    }

    // Render each option as: button row + hint note
    const actions = authOptions.map((opt, index) => {
      const chineseOpt = getChineseAuthOption(opt);
      const isReject = opt.toLowerCase().includes('no') || opt.toLowerCase().includes('deny');

      return {
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: chineseOpt,
        },
        type: isReject ? 'danger' : 'primary',
        value: JSON.stringify({
          action: opt,
          chineseAction: chineseOpt,
          index,
          sessionId,
          requestId,
        }),
      };
    });

    elements.push({
      tag: 'action',
      actions,
    });

    // Per-button explanations as grey note text below buttons
    if (optionExplanations && optionExplanations.length > 0) {
      const hintLines = authOptions.map(opt => {
        const exp = explainMap.get(opt);
        if (!exp) return null;
        const chineseOpt = getChineseAuthOption(opt);
        return `**${chineseOpt}**: ${exp.action} | 风险: ${exp.risk} | ${exp.reversibility}`;
      }).filter(Boolean);

      if (hintLines.length > 0) {
        elements.push({
          tag: 'note',
          elements: [
            {
              tag: 'lark_md',
              content: hintLines.join('\n'),
            },
          ],
        });
      }
    }
  }

  // Separator
  if (elements.length > 0) {
    elements.push({ tag: 'hr' });
  }

  // Session info as note
  const noteItems: string[] = [];
  if (sessionId) {
    noteItems.push(`#${sessionId.substring(0, 8)}`);
  }

  if (noteItems.length > 0) {
    elements.push({
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: noteItems.join(' | '),
        },
      ],
    });
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true, // 启用多人更新，确保卡片状态持久化
    },
    header: {
      title: {
        tag: 'plain_text',
        content: title,
      },
      template: headerColor[type] || 'blue',
    },
    elements,
  };
}
