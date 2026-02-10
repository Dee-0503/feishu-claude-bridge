import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import express from 'express';
import http from 'http';

// Mock feishu client
vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({
          code: 0,
          msg: 'success',
          data: { message_id: 'mock-msg-id' },
        }),
        patch: vi.fn().mockResolvedValue({ code: 0, msg: 'success' }),
      },
      chat: {
        create: vi.fn().mockResolvedValue({
          data: { chat_id: 'mock-chat-id' },
        }),
      },
    },
  },
}));

// Mock group to avoid file system access in tests
vi.mock('../feishu/group.js', () => ({
  getOrCreateProjectGroup: vi.fn().mockResolvedValue('mock-chat-id'),
  getNormalizedProjectPath: vi.fn((p: string) => p),
  markChatInvalid: vi.fn(),
}));

let app: express.Express;
let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('AUTH_TTL_MS', '60000');
  // Clear hook secret so middleware doesn't reject requests
  delete process.env.HOOK_SECRET;

  const { hookRouter } = await import('../routes/hook.js');
  const { feishuRouter } = await import('../routes/feishu.js');

  app = express();
  app.use(express.json());
  app.use('/api/hook', hookRouter);
  app.use('/api/feishu', feishuRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

async function fetchJson(url: string, options?: RequestInit) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: res.status, body: await res.json() };
}

describe('Integration: Full Authorization Flow', () => {
  it('should create auth request, poll pending, then resolve via webhook', async () => {
    // 1. Create auth request via pre-tool
    const createRes = await fetchJson(`${baseUrl}/api/hook/pre-tool`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'test-session',
        tool: 'Bash',
        tool_input: { command: 'git push origin main' },
        options: ['Yes', 'Yes, always', 'No'],
        cwd: '/test/project',
      }),
    });

    expect(createRes.status).toBe(200);
    expect(createRes.body.requestId).toBeDefined();
    const { requestId } = createRes.body;

    // 2. Poll - should be pending
    const pollRes1 = await fetchJson(`${baseUrl}/api/hook/auth-poll?requestId=${requestId}`);
    expect(pollRes1.status).toBe(200);
    expect(pollRes1.body.status).toBe('pending');

    // 3. Simulate Feishu card button click (webhook)
    const webhookRes = await fetchJson(`${baseUrl}/api/feishu/webhook`, {
      method: 'POST',
      body: JSON.stringify({
        header: {
          event_type: 'card.action.trigger',
        },
        event: {
          action: {
            value: JSON.stringify({
              requestId,
              action: 'Yes',
              sessionId: 'test-session',
            }),
          },
        },
      }),
    });

    expect(webhookRes.status).toBe(200);

    // 4. Poll again - should be resolved
    const pollRes2 = await fetchJson(`${baseUrl}/api/hook/auth-poll?requestId=${requestId}`);
    expect(pollRes2.status).toBe(200);
    expect(pollRes2.body.status).toBe('resolved');
    expect(pollRes2.body.decision).toBe('allow');
  });

  it('should handle duplicate card clicks', async () => {
    // Create auth request
    const createRes = await fetchJson(`${baseUrl}/api/hook/pre-tool`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'test-session',
        tool: 'Bash',
        tool_input: { command: 'rm -rf /' },
        options: ['Yes', 'No'],
        cwd: '/test/project',
      }),
    });
    const { requestId } = createRes.body;

    // First click
    await fetchJson(`${baseUrl}/api/feishu/webhook`, {
      method: 'POST',
      body: JSON.stringify({
        header: { event_type: 'card.action.trigger' },
        event: {
          action: {
            value: JSON.stringify({ requestId, action: 'Yes', sessionId: 'test-session' }),
          },
        },
      }),
    });

    // Second click (should be harmless)
    const secondRes = await fetchJson(`${baseUrl}/api/feishu/webhook`, {
      method: 'POST',
      body: JSON.stringify({
        header: { event_type: 'card.action.trigger' },
        event: {
          action: {
            value: JSON.stringify({ requestId, action: 'No', sessionId: 'test-session' }),
          },
        },
      }),
    });
    expect(secondRes.status).toBe(200);

    // Decision should still be allow (first click wins)
    const pollRes = await fetchJson(`${baseUrl}/api/hook/auth-poll?requestId=${requestId}`);
    expect(pollRes.body.decision).toBe('allow');
  });

  it('should return expired for non-existent requestId', async () => {
    const pollRes = await fetchJson(`${baseUrl}/api/hook/auth-poll?requestId=non-existent`);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('expired');
  });

  it('should handle deny decision', async () => {
    const createRes = await fetchJson(`${baseUrl}/api/hook/pre-tool`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'test-session',
        tool: 'Bash',
        tool_input: { command: 'rm -rf /' },
        options: ['Yes', 'No'],
        cwd: '/test/project',
      }),
    });
    const { requestId } = createRes.body;

    // Click deny
    await fetchJson(`${baseUrl}/api/feishu/webhook`, {
      method: 'POST',
      body: JSON.stringify({
        header: { event_type: 'card.action.trigger' },
        event: {
          action: {
            value: JSON.stringify({ requestId, action: 'No', sessionId: 'test-session' }),
          },
        },
      }),
    });

    const pollRes = await fetchJson(`${baseUrl}/api/hook/auth-poll?requestId=${requestId}`);
    expect(pollRes.body.status).toBe('resolved');
    expect(pollRes.body.decision).toBe('deny');
  });

  it('should reject webhook with invalid verification token', async () => {
    // Set verification token
    process.env.FEISHU_VERIFICATION_TOKEN = 'valid-token';

    const res = await fetchJson(`${baseUrl}/api/feishu/webhook`, {
      method: 'POST',
      body: JSON.stringify({
        header: {
          event_type: 'card.action.trigger',
          token: 'invalid-token',
        },
        event: {
          action: {
            value: JSON.stringify({ requestId: 'test', action: 'Yes' }),
          },
        },
      }),
    });

    expect(res.status).toBe(403);

    // Cleanup
    delete process.env.FEISHU_VERIFICATION_TOKEN;
  });
});
