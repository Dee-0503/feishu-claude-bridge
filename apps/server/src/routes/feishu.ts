import { Router } from 'express';
import type { FeishuMessageEvent, FeishuCardActionEvent, ParsedFeishuMessage } from '../types/feishu-event.js';
import type { MessageIntent } from '../types/session.js';
import { getProjectPathByChatId } from '../feishu/group.js';
import { sendTextMessage } from '../feishu/message.js';
import { getSessionByMessageId } from '../services/message-session-map.js';
import { dispatch, handleSessionChoice } from '../services/session-manager.js';
import { alertScheduler } from '../services/voice-alert.js';
import { log } from '../utils/log.js';
import { handleCardAction as handleAuthCardAction } from '../feishu/event-handlers.js';

export const feishuRouter = Router();

/** 事件去重 Set（飞书可能重复推送） */
const processedEvents = new Set<string>();
const MAX_EVENT_CACHE = 1000;

/**
 * POST /api/feishu/webhook
 * Receives events from Feishu (message callbacks, card actions)
 * Supports two callback formats:
 *   1. Event Subscription: body has header.event_type + event payload
 *   2. Card Request URL: body has action at top level (no header/event)
 */
feishuRouter.post('/webhook', async (req, res) => {
  const body = req.body;

  // Feishu URL verification challenge
  if (body.challenge) {
    log('info', 'feishu_url_verification', {});
    res.json({ challenge: body.challenge });
    return;
  }

  // Webhook verification token 校验（与 phase3 对齐）
  const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN;
  if (verificationToken) {
    const token = body.header?.token;
    if (token !== verificationToken) {
      console.warn('⚠️ Invalid Feishu verification token');
      res.status(403).json({ error: 'Invalid verification token' });
      return;
    }
  }

  // 事件去重
  const eventId = body.header?.event_id;
  if (eventId) {
    if (processedEvents.has(eventId)) {
      console.log('🔄 Duplicate event, skipping:', eventId);
      res.json({ success: true });
      return;
    }
    processedEvents.add(eventId);

    // 防止内存泄漏
    if (processedEvents.size > MAX_EVENT_CACHE) {
      const firstKey = processedEvents.values().next().value!;
      processedEvents.delete(firstKey);
    }
  }

  // 立即响应（飞书有 3 秒超时）
  res.json({ success: true });

  // 异步处理事件
  const eventType = body.header?.event_type;
  log('info', 'feishu_event_received', { eventType });

  try {
    switch (eventType) {
      case 'im.message.receive_v1':
        await handleMessage(body.event);
        break;
      case 'card.action.trigger':
        await handleCardAction(body.event);
        break;
      default:
        console.log('Unknown event type:', eventType);
    }
  } catch (error) {
    console.error('❌ Error handling event:', error);
  }
});

/**
 * 处理消息事件
 */
async function handleMessage(event: FeishuMessageEvent): Promise<void> {
  // 解析消息
  const parsed = parseFeishuMessage(event);
  if (!parsed) return;

  console.log('📩 Parsed message:', {
    cleanText: parsed.cleanText,
    isBotMentioned: parsed.isBotMentioned,
    isReply: parsed.isReply,
    chatId: parsed.chatId,
  });

  // 忽略 bot 自己的消息
  const botOpenId = process.env.FEISHU_BOT_OPEN_ID;
  if (botOpenId && parsed.senderOpenId === botOpenId) {
    console.log('🤖 Ignoring bot\'s own message');
    return;
  }

  // Phase4: 如果用户回复了任务完成通知，取消电话提醒
  if (parsed.isReply && parsed.parentMessageId) {
    alertScheduler.cancelAlert(parsed.parentMessageId);
    log('info', 'voice_alert_cancel_by_reply', { messageId: parsed.parentMessageId });
  }

  // 忽略空消息
  if (!parsed.cleanText.trim()) {
    console.log('⚠️ Empty message, ignoring');
    return;
  }

  // 查找项目路径
  const projectPath = getProjectPathByChatId(parsed.chatId);
  if (!projectPath) {
    console.log('⚠️ No project mapping found for chat:', parsed.chatId);
    await sendTextMessage(
      '⚠️ 该群未绑定项目目录，无法执行任务。请先通过 Claude Code Hook 在该项目中触发一次通知以自动创建映射。',
      parsed.chatId,
    );
    return;
  }

  // 分类消息意图
  const intent = await classifyMessageIntent(parsed, projectPath);
  console.log('🎯 Message intent:', intent.type);

  // 路由分发
  try {
    await dispatch(intent);
  } catch (error) {
    console.error('❌ Error dispatching intent:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await sendTextMessage(`❌ 任务处理失败: ${errorMessage}`, parsed.chatId);
  }
}

/**
 * 解析飞书消息
 */
function parseFeishuMessage(event: FeishuMessageEvent): ParsedFeishuMessage | null {
  const { message, sender } = event;

  // 只处理文本消息
  if (message.message_type !== 'text') {
    console.log('⚠️ Non-text message, ignoring:', message.message_type);
    return null;
  }

  let rawText: string;
  try {
    const content = JSON.parse(message.content || '{}');
    rawText = content.text || '';
  } catch {
    console.error('Failed to parse message content');
    return null;
  }

  // 清理 @提及标记，提取纯文本
  let cleanText = rawText;
  const botOpenId = process.env.FEISHU_BOT_OPEN_ID;
  let isBotMentioned = false;

  if (message.mentions && message.mentions.length > 0) {
    for (const mention of message.mentions) {
      // 替换 @xxx 标记
      cleanText = cleanText.replace(mention.key, '').trim();

      // 检查是否 @了 bot
      if (botOpenId && mention.id.open_id === botOpenId) {
        isBotMentioned = true;
      }
    }
  }

  // 如果没有配置 bot open_id，通过 mentions 中的 name 检测
  if (!botOpenId && message.mentions?.some(m => m.name?.includes('Claude') || m.name?.includes('claude'))) {
    isBotMentioned = true;
  }

  return {
    rawText,
    cleanText: cleanText.trim(),
    isBotMentioned,
    isReply: !!message.parent_id,
    parentMessageId: message.parent_id,
    chatId: message.chat_id,
    messageId: message.message_id,
    senderOpenId: sender.sender_id.open_id,
  };
}

/**
 * 分类消息意图
 */
async function classifyMessageIntent(
  parsed: ParsedFeishuMessage,
  projectPath: string,
): Promise<MessageIntent> {
  // 1. 回复某条通知卡片 → continue_session
  if (parsed.isReply && parsed.parentMessageId) {
    const mapping = getSessionByMessageId(parsed.parentMessageId);
    if (mapping) {
      return {
        type: 'continue_session',
        text: parsed.cleanText,
        sessionId: mapping.sessionId,
        chatId: parsed.chatId,
        projectPath: mapping.projectPath || projectPath,
      };
    }
    // 回复了一条没有映射的消息，当作新任务处理
    console.log('⚠️ Reply to unknown message, treating as new task');
  }

  // 2. @bot → new_task
  if (parsed.isBotMentioned) {
    return {
      type: 'new_task',
      text: parsed.cleanText,
      chatId: parsed.chatId,
      projectPath,
    };
  }

  // 3. 直接消息（不@ 不回复）→ choose_session
  return {
    type: 'choose_session',
    text: parsed.cleanText,
    chatId: parsed.chatId,
    projectPath,
    messageId: parsed.messageId,
  };
}

/**
 * 处理卡片动作（按钮点击）
 */
async function handleCardAction(event: FeishuCardActionEvent): Promise<void> {
  const { action, operator } = event;

  let value: any;
  try {
    value = typeof action.value === 'string' ? JSON.parse(action.value) : action.value;
  } catch {
    console.error('Failed to parse card action value:', action.value);
    return;
  }

  console.log('🔘 Card action:', value);

  // Phase4: 用户点击卡片按钮，取消电话提醒
  const parentMessageId = event.context?.open_message_id;
  if (parentMessageId) {
    alertScheduler.cancelAlert(parentMessageId);
    log('info', 'voice_alert_cancel_by_action', { messageId: parentMessageId, action: value.action });
  }

  // 处理会话选择
  if (value.action === 'choose_session' || value.action === 'new_session') {
    // 需要从 value 中获取 chatId，或者从事件上下文获取
    // card.action.trigger 事件中 operator 有 open_id 但没有 chat_id
    // 通过 pendingKey 中暂存的信息获取
    const chatId = value.chatId || '';

    if (!chatId) {
      // 尝试从映射中查找
      console.warn('⚠️ Missing chatId in card action, cannot process');
      return;
    }

    await handleSessionChoice(value, chatId);
    return;
  }

  // Phase 3: 处理授权响应
  if (value.requestId) {
    console.log('📌 Authorization action (Phase 3):', value);
    await handleAuthCardAction(event, { mode: 'http' });
    return;
  }
}
