import { Router } from 'express';
import { handleCardAction, handleMessage } from '../feishu/event-handlers.js';
import { log } from '../utils/log.js';

export const feishuRouter = Router();

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

  // --- Card Request URL format (no header, action at top level) ---
  if (body.action && !body.header) {
    log('info', 'feishu_card_callback_received', { tag: body.action?.tag });

    // Token verification for card callback
    const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN;
    if (verificationToken && body.token !== verificationToken) {
      log('warn', 'feishu_card_callback_invalid_token', {});
      res.status(403).json({ error: 'Invalid verification token' });
      return;
    }

    const cardJson = await handleCardAction(
      {
        action: body.action,
        operator: { user_id: { open_id: body.open_id } },
        context: {
          open_message_id: body.open_message_id,
          open_chat_id: body.open_chat_id,
        },
      },
      { mode: 'http' }
    );

    // Responsive update: return new card in response
    if (cardJson) {
      res.json({
        toast: {
          type: 'success',
          content: '处理成功',
        },
        card: cardJson,
      });
    } else {
      res.json({});
    }
    return;
  }

  // --- Event Subscription format (header + event) ---
  // Webhook signature verification
  const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN;
  if (verificationToken) {
    const token = body.header?.token;
    if (token !== verificationToken) {
      log('warn', 'feishu_webhook_invalid_token', {});
      res.status(403).json({ error: 'Invalid verification token' });
      return;
    }
  }

  // Handle events
  const eventType = body.header?.event_type;
  log('info', 'feishu_event_received', { eventType });

  switch (eventType) {
    case 'im.message.receive_v1':
      await handleMessage(body.event);
      break;
    case 'card.action.trigger': {
      const cardJson = await handleCardAction(body.event, { mode: 'http' });
      if (cardJson) {
        res.json({ card: cardJson });
        return;
      }
      break;
    }
    default:
      log('info', 'feishu_unknown_event', { eventType });
  }

  res.json({ success: true });
});
