import { feishuClient } from './client.js';
import type { RawSummary } from '../types/summary.js';
import { getChineseAuthOption } from '../types/summary.js';
import type { OptionExplanation } from '../services/command-explain.js';
import { markChatInvalid } from './group.js';
import { log } from '../utils/log.js';

export type MessageType =
  | 'task_complete'
  | 'authorization_required'
  | 'sensitive_command'
  | 'authorization_resolved'
  | 'task_started'
  | 'session_choice';

interface SessionButton {
  label: string;
  value: string;
}

export interface SendMessageOptions {
  type: MessageType;
  title: string;
  content?: string;
  sessionId?: string;
  command?: string;
  options?: string[];
  /** 动态指定群 ID，不传则使用环境变量 */
  chatId?: string;
  /** 授权请求 ID（按钮 value 中携带） - Phase3 */
  requestId?: string;
  /** AI 生成的命令解释摘要 - Phase3 */
  commandSummary?: string;
  /** AI 生成的每个选项的解释 - Phase3 */
  optionExplanations?: OptionExplanation[];
  /** 任务摘要数据 - Phase2 */
  summary?: RawSummary;
  /** Haiku 生成的一句话摘要 - Phase2 */
  haikuSummary?: string;
  /** 会话选择按钮（用于 session_choice 类型） - Phase2 */
  sessionButtons?: SessionButton[];
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

    console.log('[DEBUG] Feishu API response:', JSON.stringify(response, null, 2));

    if (response.code !== 0) {
      throw new Error(`Feishu API error ${response.code}: ${response.msg}`);
    }

    const messageId = response.data?.message_id || '';
    log('info', 'card_message_sent', { title: options.title, messageId, chatId: targetId });

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
    type, title, content, sessionId, command, options: authOptions,
    requestId, commandSummary, optionExplanations,
    summary, haikuSummary, sessionButtons,
  } = options;

  // Header color based on message type
  const headerColor: Record<MessageType, string> = {
    task_complete: 'green',
    authorization_required: 'orange',
    sensitive_command: 'red',
    authorization_resolved: 'grey',
    task_started: 'blue',
    session_choice: 'purple',
  };

  const elements: object[] = [];

  // AI command summary (Phase3 - displayed prominently above the command)
  if (commandSummary) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**解释**: ${commandSummary}`,
      },
    });
  }

  // Phase2: Task summary (rich card with tool stats and files)
  if (summary) {
    // Haiku 生成的摘要（如果有）
    if (haikuSummary) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**摘要**: ${haikuSummary}`,
        },
      });
    }

    // 操作统计
    const stats = summary.toolStats;
    const statsItems: string[] = [];
    if (stats.edit > 0) statsItems.push(`编辑 ${stats.edit} 文件`);
    if (stats.write > 0) statsItems.push(`创建 ${stats.write} 文件`);
    if (stats.bash > 0) statsItems.push(`执行 ${stats.bash} 命令`);
    if (stats.read > 0) statsItems.push(`读取 ${stats.read} 文件`);

    if (statsItems.length > 0) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**操作**: ${statsItems.join(' | ')}`,
        },
      });
    }

    // 文件列表
    const allFiles = [...summary.filesModified, ...summary.filesCreated];
    if (allFiles.length > 0) {
      const fileNames = allFiles
        .slice(0, 5)
        .map(f => `\`${f.split('/').pop()}\``)
        .join(', ');
      const extra = allFiles.length > 5 ? ` +${allFiles.length - 5} 更多` : '';
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**文件**: ${fileNames}${extra}`,
        },
      });
    }

    // 耗时
    if (summary.duration > 0) {
      const minutes = Math.floor(summary.duration / 60);
      const seconds = summary.duration % 60;
      const durationText = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**耗时**: ${durationText}`,
        },
      });
    }
  } else if (content) {
    // Simple content
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

  // Authorization buttons (Phase3 with explanations + Phase2 basic)
  if (type !== 'authorization_resolved' && authOptions && authOptions.length > 0) {
    // Build explanation map for quick lookup (Phase3)
    const explainMap = new Map<string, OptionExplanation>();
    if (optionExplanations) {
      for (const exp of optionExplanations) {
        explainMap.set(exp.option, exp);
      }
    }

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
          requestId, // Phase3: include requestId for auth tracking
        }),
      };
    });

    elements.push({
      tag: 'action',
      actions,
    });

    // Per-button explanations as grey note text below buttons (Phase3)
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

  // Session choice buttons (Phase2)
  if (sessionButtons && sessionButtons.length > 0) {
    const actions = sessionButtons.map((btn, index) => ({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: btn.label,
      },
      type: index === sessionButtons.length - 1 ? 'default' : (index === 0 ? 'primary' : 'default'),
      value: btn.value,
    }));

    elements.push({
      tag: 'action',
      actions,
    });
  }

  // Separator
  if (elements.length > 0) {
    elements.push({ tag: 'hr' });
  }

  // Session/branch info as note
  const noteItems: string[] = [];
  if (summary?.gitBranch) {
    noteItems.push(summary.gitBranch);
  }
  if (summary?.sessionShortId) {
    noteItems.push(`#${summary.sessionShortId}`);
  } else if (sessionId) {
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

  // Build header title (Phase2: rich header for task_complete)
  let headerTitle = title;
  if (summary && type === 'task_complete') {
    const branchPart = summary.gitBranch ? `[${summary.gitBranch}]` : '';
    const sessionPart = summary.sessionShortId ? `#${summary.sessionShortId}` : '';
    if (branchPart || sessionPart) {
      headerTitle = `✅ ${branchPart} / ${sessionPart}`;
    }
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true, // Phase3: 启用多人更新，确保卡片状态持久化
    },
    header: {
      title: {
        tag: 'plain_text',
        content: headerTitle,
      },
      template: headerColor[type] || 'blue',
    },
    elements,
  };
}
