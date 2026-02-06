import { feishuClient } from './client.js';
import type { RawSummary } from '../types/summary.js';
import { getChineseAuthOption } from '../types/summary.js';

export type MessageType = 'task_complete' | 'authorization_required' | 'sensitive_command';

interface SendMessageOptions {
  type: MessageType;
  title: string;
  content?: string;
  sessionId?: string;
  command?: string;
  options?: string[];
  /** 动态指定群 ID，不传则使用环境变量 */
  chatId?: string;
  /** 任务摘要数据 */
  summary?: RawSummary;
  /** Haiku 生成的一句话摘要 */
  haikuSummary?: string;
}

interface SendCardResult {
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
    console.error('❌ FEISHU_TARGET_ID not configured');
    return;
  }

  try {
    await feishuClient.im.message.create({
      params: {
        receive_id_type: targetType as 'open_id' | 'chat_id' | 'user_id',
      },
      data: {
        receive_id: targetId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    console.log('✅ Message sent:', text.substring(0, 50));
  } catch (error) {
    console.error('❌ Failed to send message:', error);
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
    console.error('❌ FEISHU_TARGET_ID not configured');
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

    const messageId = response.data?.message_id || '';
    console.log('✅ Card message sent:', options.title, messageId);

    return {
      messageId,
      chatId: targetId,
    };
  } catch (error) {
    console.error('❌ Failed to send card message:', error);
    throw error;
  }
}

/**
 * Update an existing card message (for adding Haiku summary)
 */
export async function updateCardMessage(
  messageId: string,
  options: SendMessageOptions
): Promise<void> {
  const card = buildCard(options);

  try {
    await feishuClient.im.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify(card),
      },
    });
    console.log('✅ Card message updated:', messageId);
  } catch (error) {
    console.error('❌ Failed to update card message:', error);
    throw error;
  }
}

function buildCard(options: SendMessageOptions): object {
  const { type, title, content, sessionId, command, options: authOptions, summary, haikuSummary } = options;

  // Header color based on message type
  const headerColor = {
    task_complete: 'green',
    authorization_required: 'orange',
    sensitive_command: 'red',
  }[type];

  const elements: object[] = [];

  // If we have a summary, build rich card
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
    // Legacy mode: simple content
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content,
      },
    });
  }

  // Add command info if present
  if (command) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**命令**: \`${command}\``,
      },
    });
  }

  // Add authorization buttons if options provided
  if (authOptions && authOptions.length > 0) {
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
        }),
      };
    });

    elements.push({
      tag: 'action',
      actions,
    });
  }

  // Add separator before note
  if (elements.length > 0) {
    elements.push({ tag: 'hr' });
  }

  // Add session/branch info as note
  const noteItems: string[] = [];
  if (summary?.gitBranch) {
    noteItems.push(summary.gitBranch);
  }
  if (summary?.sessionShortId) {
    noteItems.push(`#${summary.sessionShortId}`);
  } else if (sessionId) {
    noteItems.push(`#${sessionId.substring(0, 4)}`);
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

  // Build header title
  let headerTitle = title;
  if (summary && type === 'task_complete') {
    // 格式: ✅ [分支名] / #会话短码
    const branchPart = summary.gitBranch ? `[${summary.gitBranch}]` : '';
    const sessionPart = summary.sessionShortId ? `#${summary.sessionShortId}` : '';
    if (branchPart || sessionPart) {
      headerTitle = `✅ ${branchPart} / ${sessionPart}`;
    }
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: headerTitle,
      },
      template: headerColor,
    },
    elements,
  };
}
