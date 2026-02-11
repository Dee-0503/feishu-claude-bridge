/**
 * WebSocket Long Connection Client for Feishu Events.
 *
 * This module provides an alternative to HTTP webhooks for receiving Feishu events.
 * Benefits:
 * - No need for public IP or domain name
 * - No SSL certificate required
 * - Works behind firewalls (outbound connection)
 * - Ideal for local development and testing
 *
 * The WebSocket client connects to Feishu's servers and receives events
 * through the persistent connection, processing them with the same handlers
 * used by HTTP webhooks.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { handleCardAction, handleMessage } from './event-handlers.js';
import { log } from '../utils/log.js';

let wsClient: lark.WSClient | null = null;

/**
 * Start the WebSocket long connection client.
 * Registers event handlers and establishes connection to Feishu.
 */
export async function startWSClient(): Promise<void> {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN;

  if (!appId || !appSecret) {
    log('error', 'ws_client_missing_credentials', {});
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required for WebSocket mode');
  }

  log('info', 'ws_client_starting', { appId: appId.substring(0, 8) + '...' });

  // Create WebSocket client
  wsClient = new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  // Register event handlers
  // Both message events and card actions come through EventDispatcher in WebSocket mode
  const eventDispatcher = new lark.EventDispatcher({
    verificationToken: verificationToken || '',
    // Encrypt key is optional - only needed if you configure it in Feishu console
    encryptKey: process.env.FEISHU_ENCRYPT_KEY,
  }).register({
    // Message receive event
    'im.message.receive_v1': async (data: any) => {
      log('info', 'ws_event_received', { type: 'im.message.receive_v1' });
      await handleMessage(data);
    },
    // Card action event (button clicks)
    'card.action.trigger': async (data: any) => {
      log('info', 'ws_card_action_received', {
        tag: data.action?.tag,
        openMessageId: data.context?.open_message_id,
      });

      // WebSocket 模式：handleCardAction 返回卡片 JSON
      // 双重保险：同时调用 API 更新 + WebSocket 响应式更新
      const cardJson = await handleCardAction(data, { mode: 'websocket' });

      if (cardJson) {
        // 非模板卡片的响应式更新：需要 type:"raw" + data.card 包装
        // 否则飞书会把 config/header/elements 当模板变量解析，报 200672
        const response = {
          card: {
            type: 'raw',
            data: {
              card: cardJson,
            },
          },
        };

        log('info', 'ws_card_action_response', {
          openMessageId: data.context?.open_message_id,
          hasCard: true,
        });

        return response;
      }

      log('info', 'ws_card_action_response', {
        openMessageId: data.context?.open_message_id,
        hasCard: false,
      });

      return null;
    },
  });

  // Start the WebSocket client
  await wsClient.start({
    eventDispatcher,
  });

  log('info', 'ws_client_started', {});
}

/**
 * Stop the WebSocket client gracefully.
 * Called during server shutdown.
 */
export async function stopWSClient(): Promise<void> {
  if (!wsClient) {
    return;
  }

  log('info', 'ws_client_stopping', {});

  try {
    wsClient.close({ force: false });
  } catch (error) {
    log('warn', 'ws_client_stop_error', { error: String(error) });
  }

  wsClient = null;
  log('info', 'ws_client_stopped', {});
}

/**
 * Check if WebSocket client is currently running.
 */
export function isWSClientRunning(): boolean {
  return wsClient !== null;
}
