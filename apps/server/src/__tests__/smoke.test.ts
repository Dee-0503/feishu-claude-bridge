/**
 * 冒烟测试
 * 真实启动 Express 服务（mock 飞书），验证所有端点可达、基本响应格式正确
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';

// Mock feishu client
vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { message_id: 'smoke-msg-id' } }),
        patch: vi.fn().mockResolvedValue({ code: 0, msg: 'success' }),
      },
      chat: {
        create: vi.fn().mockResolvedValue({ data: { chat_id: 'smoke-chat-id' } }),
      },
    },
  },
}));

vi.mock('../feishu/group.js', () => ({
  getOrCreateProjectGroup: vi.fn().mockResolvedValue('smoke-chat-id'),
  getNormalizedProjectPath: vi.fn((p: string) => p),
  markChatInvalid: vi.fn(),
}));

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  delete process.env.HOOK_SECRET;
  delete process.env.FEISHU_VERIFICATION_TOKEN;

  const { hookRouter } = await import('../routes/hook.js');
  const { feishuRouter } = await import('../routes/feishu.js');

  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
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

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  return { status: res.status, body: await res.json() as any };
}

describe('Smoke Tests', () => {
  it('GET /health returns ok', async () => {
    const res = await fetchJson(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('POST /api/hook/stop returns success', async () => {
    const res = await fetchJson(`${baseUrl}/api/hook/stop`, {
      method: 'POST',
      body: JSON.stringify({ session_id: 'smoke-sess', message: 'done' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /api/hook/pre-tool returns requestId', async () => {
    const res = await fetchJson(`${baseUrl}/api/hook/pre-tool`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'smoke-sess',
        tool: 'Bash',
        tool_input: { command: 'git push' },
        options: ['Yes', 'No'],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body.requestId).toBeDefined();
    expect(typeof res.body.requestId).toBe('string');
  });

  it('GET /api/hook/auth-poll returns status', async () => {
    // First create a request
    const createRes = await fetchJson(`${baseUrl}/api/hook/pre-tool`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'smoke-sess',
        tool: 'Bash',
        tool_input: { command: 'rm -rf /' },
        options: ['Yes', 'No'],
      }),
    });
    const { requestId } = createRes.body;

    const pollRes = await fetchJson(`${baseUrl}/api/hook/auth-poll?requestId=${requestId}`);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('pending');
  });

  it('GET /api/hook/auth-poll returns 400 without requestId', async () => {
    const res = await fetchJson(`${baseUrl}/api/hook/auth-poll`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('requestId');
  });

  it('POST /api/hook/notification returns success', async () => {
    const res = await fetchJson(`${baseUrl}/api/hook/notification`, {
      method: 'POST',
      body: JSON.stringify({ message: 'smoke test notification' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /api/feishu/webhook handles challenge', async () => {
    const res = await fetchJson(`${baseUrl}/api/feishu/webhook`, {
      method: 'POST',
      body: JSON.stringify({ challenge: 'smoke-challenge-token' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('smoke-challenge-token');
  });

  it('POST /api/feishu/webhook handles card action', async () => {
    // Create auth request first
    const createRes = await fetchJson(`${baseUrl}/api/hook/pre-tool`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'smoke-sess',
        tool: 'Bash',
        tool_input: { command: 'docker push' },
        options: ['Yes', 'No'],
      }),
    });
    const { requestId } = createRes.body;

    const res = await fetchJson(`${baseUrl}/api/feishu/webhook`, {
      method: 'POST',
      body: JSON.stringify({
        header: { event_type: 'card.action.trigger' },
        event: {
          action: {
            value: JSON.stringify({ requestId, action: 'Yes', sessionId: 'smoke-sess' }),
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('all endpoints respond within 1s', async () => {
    const start = Date.now();
    await fetchJson(`${baseUrl}/health`);
    await fetchJson(`${baseUrl}/api/hook/notification`, {
      method: 'POST',
      body: JSON.stringify({ message: 'perf test' }),
    });
    await fetchJson(`${baseUrl}/api/hook/auth-poll?requestId=nonexistent`);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});
