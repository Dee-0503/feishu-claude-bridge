import { feishuClient } from './client.js';

export type MessageType = 'task_complete' | 'authorization_required' | 'sensitive_command';

interface SendMessageOptions {
  type: MessageType;
  title: string;
  content: string;
  sessionId?: string;
  command?: string;
  options?: string[];
}

/**
 * Send a text message to the configured target
 */
export async function sendTextMessage(text: string): Promise<void> {
  const targetType = process.env.FEISHU_TARGET_TYPE || 'open_id';
  const targetId = process.env.FEISHU_TARGET_ID;

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
 */
export async function sendCardMessage(options: SendMessageOptions): Promise<void> {
  const targetType = process.env.FEISHU_TARGET_TYPE || 'open_id';
  const targetId = process.env.FEISHU_TARGET_ID;

  if (!targetId) {
    console.error('❌ FEISHU_TARGET_ID not configured');
    return;
  }

  const card = buildCard(options);

  try {
    await feishuClient.im.message.create({
      params: {
        receive_id_type: targetType as 'open_id' | 'chat_id' | 'user_id',
      },
      data: {
        receive_id: targetId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    console.log('✅ Card message sent:', options.title);
  } catch (error) {
    console.error('❌ Failed to send card message:', error);
    throw error;
  }
}

function buildCard(options: SendMessageOptions): object {
  const { type, title, content, sessionId, command, options: authOptions } = options;

  // Header color based on message type
  const headerColor = {
    task_complete: 'green',
    authorization_required: 'orange',
    sensitive_command: 'red',
  }[type];

  const elements: object[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content,
      },
    },
  ];

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
    const actions = authOptions.map((opt, index) => ({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: opt,
      },
      type: index === authOptions.length - 1 ? 'danger' : 'primary',
      value: JSON.stringify({
        action: opt,
        index,
        sessionId,
      }),
    }));

    elements.push({
      tag: 'action',
      actions,
    });
  }

  // Add session info as note
  if (sessionId) {
    elements.push({
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `Session: ${sessionId}`,
        },
      ],
    });
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: title,
      },
      template: headerColor,
    },
    elements,
  };
}
