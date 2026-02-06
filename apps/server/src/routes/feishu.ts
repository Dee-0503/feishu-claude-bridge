import { Router } from 'express';

export const feishuRouter = Router();

/**
 * POST /api/feishu/webhook
 * Receives events from Feishu (message callbacks, card actions)
 */
feishuRouter.post('/webhook', async (req, res) => {
  const body = req.body;

  // Feishu URL verification challenge
  if (body.challenge) {
    console.log('🔐 Feishu URL verification');
    res.json({ challenge: body.challenge });
    return;
  }

  // Handle events
  const eventType = body.header?.event_type;
  console.log('📨 Received Feishu event:', eventType);

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

  res.json({ success: true });
});

async function handleMessage(event: any): Promise<void> {
  const message = event.message;
  const content = JSON.parse(message.content || '{}');
  console.log('📩 Received message:', content.text);

  // TODO: Phase 2 - Forward message to local agent
}

async function handleCardAction(event: any): Promise<void> {
  const action = event.action;
  const value = JSON.parse(action.value || '{}');
  console.log('🔘 Card action:', value);

  // TODO: Phase 3 - Handle authorization response
}
