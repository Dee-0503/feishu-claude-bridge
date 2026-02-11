import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FeishuMessageEvent } from '../types/feishu-event.js';

// Mock feishu client
vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({ data: { message_id: 'mock-msg-id' } }),
        reply: vi.fn().mockResolvedValue({ data: { message_id: 'mock-msg-id' } }),
        patch: vi.fn().mockResolvedValue({}),
      },
      chat: {
        create: vi.fn().mockResolvedValue({ data: { chat_id: 'mock-chat-id' } }),
      },
    },
  },
}));

// Mock group
vi.mock('../feishu/group.js', () => ({
  getProjectPathByChatId: vi.fn(),
  getOrCreateProjectGroup: vi.fn().mockResolvedValue('mock-chat-id'),
  loadGroupMappings: vi.fn().mockReturnValue({}),
  saveGroupMapping: vi.fn(),
  extractProjectName: vi.fn().mockReturnValue('test-project'),
  getNormalizedProjectPath: vi.fn((p: string) => p),
}));

// Mock session manager
vi.mock('../services/session-manager.js', () => ({
  dispatch: vi.fn().mockResolvedValue(undefined),
  handleSessionChoice: vi.fn().mockResolvedValue(undefined),
}));

// Mock message-session-map
vi.mock('../services/message-session-map.js', () => ({
  getSessionByMessageId: vi.fn(),
  registerMessageSession: vi.fn(),
  initMessageSessionMap: vi.fn(),
  getActiveSessionsByChatId: vi.fn().mockReturnValue([]),
  getLatestSessionByChatId: vi.fn().mockReturnValue(null),
  storePendingText: vi.fn().mockReturnValue('pending_key'),
  retrievePendingText: vi.fn().mockReturnValue('test text'),
}));

import { getProjectPathByChatId } from '../feishu/group.js';
import { dispatch, handleSessionChoice } from '../services/session-manager.js';
import { getSessionByMessageId } from '../services/message-session-map.js';

// Need to dynamically import feishuRouter after mocks are set up
let feishuRouter: any;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.FEISHU_TARGET_ID = 'test-target';
  process.env.FEISHU_BOT_OPEN_ID = 'bot-open-id';

  // Reset processed events cache
  vi.resetModules();
  const routerMod = await import('../routes/feishu.js');
  feishuRouter = routerMod.feishuRouter;
});

// Helper to create Express app with feishu router
async function createApp() {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/feishu', feishuRouter);
  return app;
}

function buildMessageEvent(overrides: Partial<FeishuMessageEvent> = {}): any {
  return {
    header: {
      event_id: `evt_${Date.now()}_${Math.random()}`,
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: { open_id: 'user-open-id' },
        sender_type: 'user',
        ...overrides.sender,
      },
      message: {
        message_id: 'test-msg-id',
        chat_id: 'test-chat-id',
        message_type: 'text',
        content: JSON.stringify({ text: 'Hello Claude' }),
        ...overrides.message,
      },
    },
  };
}

describe('feishu webhook', () => {
  describe('URL verification', () => {
    it('should respond to challenge', async () => {
      const app = await createApp();
      const http = await import('http');
      const server = http.createServer(app);
      await new Promise<void>(r => server.listen(0, r));
      const addr = server.address() as any;

      const res = await fetch(`http://localhost:${addr.port}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: 'test-challenge' }),
      });

      const body = await res.json();
      expect(body.challenge).toBe('test-challenge');

      await new Promise<void>(r => server.close(() => r()));
    });
  });

  describe('verification token', () => {
    it('should reject when token is set but missing in event', async () => {
      process.env.FEISHU_VERIFICATION_TOKEN = 'secret-token';

      vi.resetModules();
      const { feishuRouter: freshRouter } = await import('../routes/feishu.js');
      const express = (await import('express')).default;
      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use('/api/feishu', freshRouter);

      const http = await import('http');
      const server = http.createServer(freshApp);
      await new Promise<void>(r => server.listen(0, r));
      const addr = server.address() as any;

      const event = buildMessageEvent();
      const res = await fetch(`http://localhost:${addr.port}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      expect(res.status).toBe(403);

      await new Promise<void>(r => server.close(() => r()));
      delete process.env.FEISHU_VERIFICATION_TOKEN;
    });

    it('should reject when token does not match', async () => {
      process.env.FEISHU_VERIFICATION_TOKEN = 'secret-token';

      vi.resetModules();
      const { feishuRouter: freshRouter } = await import('../routes/feishu.js');
      const express = (await import('express')).default;
      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use('/api/feishu', freshRouter);

      const http = await import('http');
      const server = http.createServer(freshApp);
      await new Promise<void>(r => server.listen(0, r));
      const addr = server.address() as any;

      const event = buildMessageEvent();
      event.header.token = 'wrong-token';

      const res = await fetch(`http://localhost:${addr.port}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      expect(res.status).toBe(403);

      await new Promise<void>(r => server.close(() => r()));
      delete process.env.FEISHU_VERIFICATION_TOKEN;
    });

    it('should accept when token matches', async () => {
      process.env.FEISHU_VERIFICATION_TOKEN = 'secret-token';

      vi.resetModules();
      const { feishuRouter: freshRouter } = await import('../routes/feishu.js');
      const express = (await import('express')).default;
      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use('/api/feishu', freshRouter);

      const http = await import('http');
      const server = http.createServer(freshApp);
      await new Promise<void>(r => server.listen(0, r));
      const addr = server.address() as any;

      (getProjectPathByChatId as any).mockReturnValue('/project/path');

      const event = buildMessageEvent();
      event.header.token = 'secret-token';
      event.event.message.mentions = [
        { key: '@_user_1', id: { open_id: 'bot-open-id' }, name: 'Claude' },
      ];
      event.event.message.content = JSON.stringify({ text: '@_user_1 hello' });

      const res = await fetch(`http://localhost:${addr.port}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      expect(res.status).toBe(200);

      await new Promise(r => setTimeout(r, 100));
      expect(dispatch).toHaveBeenCalled();

      await new Promise<void>(r => server.close(() => r()));
      delete process.env.FEISHU_VERIFICATION_TOKEN;
    });

    it('should skip verification when token is not configured', async () => {
      delete process.env.FEISHU_VERIFICATION_TOKEN;

      const app = await createApp();
      const http = await import('http');
      const server = http.createServer(app);
      await new Promise<void>(r => server.listen(0, r));
      const addr = server.address() as any;

      (getProjectPathByChatId as any).mockReturnValue('/project/path');

      const event = buildMessageEvent();
      event.event.message.mentions = [
        { key: '@_user_1', id: { open_id: 'bot-open-id' }, name: 'Claude' },
      ];
      event.event.message.content = JSON.stringify({ text: '@_user_1 hello' });

      const res = await fetch(`http://localhost:${addr.port}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      expect(res.status).toBe(200);

      await new Promise(r => setTimeout(r, 100));
      expect(dispatch).toHaveBeenCalled();

      await new Promise<void>(r => server.close(() => r()));
    });
  });

  describe('event dedup', () => {
    it('should process same event_id only once', async () => {
      const app = await createApp();
      const http = await import('http');
      const server = http.createServer(app);
      await new Promise<void>(r => server.listen(0, r));
      const addr = server.address() as any;
      const baseUrl = `http://localhost:${addr.port}`;

      (getProjectPathByChatId as any).mockReturnValue('/project/path');

      const event = buildMessageEvent();
      event.event.message.mentions = [
        { key: '@_user_1', id: { open_id: 'bot-open-id' }, name: 'Claude' },
      ];
      event.event.message.content = JSON.stringify({ text: '@_user_1 hello' });

      // Send same event twice
      await fetch(`${baseUrl}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      // Small delay for async processing
      await new Promise(r => setTimeout(r, 100));

      await fetch(`${baseUrl}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      await new Promise(r => setTimeout(r, 100));

      // dispatch should only be called once
      expect(dispatch).toHaveBeenCalledTimes(1);

      await new Promise<void>(r => server.close(() => r()));
    });
  });

  describe('message intent classification', () => {
    let app: any;
    let server: any;
    let baseUrl: string;

    beforeEach(async () => {
      app = await createApp();
      const http = await import('http');
      server = http.createServer(app);
      await new Promise<void>(r => server.listen(0, r));
      const addr = server.address() as any;
      baseUrl = `http://localhost:${addr.port}`;
      (getProjectPathByChatId as any).mockReturnValue('/project/path');
    });

    afterEach(async () => {
      await new Promise<void>(r => server.close(() => r()));
    });

    it('should classify @bot message as new_task', async () => {
      const event = buildMessageEvent({
        message: {
          message_id: 'msg-1',
          chat_id: 'chat-1',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 fix the bug' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'bot-open-id' }, name: 'Claude' }],
        },
      } as any);

      await fetch(`${baseUrl}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      await new Promise(r => setTimeout(r, 100));

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'new_task',
          text: 'fix the bug',
        }),
      );
    });

    it('should classify reply message as continue_session', async () => {
      (getSessionByMessageId as any).mockReturnValue({
        sessionId: 'existing-session',
        chatId: 'chat-1',
        projectPath: '/project/path',
      });

      const event = buildMessageEvent({
        message: {
          message_id: 'msg-2',
          parent_id: 'parent-msg-id',
          chat_id: 'chat-1',
          message_type: 'text',
          content: JSON.stringify({ text: 'also fix this' }),
        },
      } as any);

      await fetch(`${baseUrl}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      await new Promise(r => setTimeout(r, 100));

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'continue_session',
          sessionId: 'existing-session',
          text: 'also fix this',
        }),
      );
    });

    it('should classify plain message as choose_session', async () => {
      const event = buildMessageEvent({
        message: {
          message_id: 'msg-3',
          chat_id: 'chat-1',
          message_type: 'text',
          content: JSON.stringify({ text: 'fix the CSS' }),
        },
      } as any);

      await fetch(`${baseUrl}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      await new Promise(r => setTimeout(r, 100));

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'choose_session',
          text: 'fix the CSS',
        }),
      );
    });

    it('should ignore bot own messages', async () => {
      const event = buildMessageEvent({
        sender: {
          sender_id: { open_id: 'bot-open-id' },
          sender_type: 'user',
        },
      } as any);

      await fetch(`${baseUrl}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      await new Promise(r => setTimeout(r, 100));

      expect(dispatch).not.toHaveBeenCalled();
    });

    it('should ignore non-text messages', async () => {
      const event = buildMessageEvent({
        message: {
          message_id: 'msg-4',
          chat_id: 'chat-1',
          message_type: 'image',
          content: '{}',
        },
      } as any);

      await fetch(`${baseUrl}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      await new Promise(r => setTimeout(r, 100));

      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('card action', () => {
    it('should handle session choice action', async () => {
      const app = await createApp();
      const http = await import('http');
      const server = http.createServer(app);
      await new Promise<void>(r => server.listen(0, r));
      const addr = server.address() as any;

      const res = await fetch(`http://localhost:${addr.port}/api/feishu/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          header: { event_id: 'evt-card-1', event_type: 'card.action.trigger' },
          event: {
            operator: { open_id: 'user-1' },
            action: {
              value: JSON.stringify({
                action: 'choose_session',
                sessionId: 'sess-1',
                projectPath: '/project',
                pendingKey: 'key-1',
                chatId: 'chat-1',
              }),
              tag: 'button',
            },
          },
        }),
      });

      expect(res.ok).toBe(true);

      await new Promise(r => setTimeout(r, 100));

      expect(handleSessionChoice).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'choose_session',
          sessionId: 'sess-1',
        }),
        'chat-1',
      );

      await new Promise<void>(r => server.close(() => r()));
    });
  });
});
