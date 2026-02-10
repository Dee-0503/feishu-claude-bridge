/**
 * 集成测试补充
 * 覆盖: "始终允许"规则写入、permission rule 自动放行、
 *        AI 解释异步更新、auth 过期、Feishu challenge、HOOK_SECRET 认证
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.join(__dirname, '../../data/permission-rules.json');

// Mock feishu client
vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { message_id: 'integ-msg-id' } }),
        patch: vi.fn().mockResolvedValue({ code: 0, msg: 'success' }),
      },
      chat: {
        create: vi.fn().mockResolvedValue({ data: { chat_id: 'integ-chat-id' } }),
      },
    },
  },
}));

vi.mock('../feishu/group.js', () => ({
  getOrCreateProjectGroup: vi.fn().mockResolvedValue('integ-chat-id'),
  getNormalizedProjectPath: vi.fn((p: string) => p),
  markChatInvalid: vi.fn(),
}));

// Mock command explanation to control its behavior
vi.mock('../services/command-explain.js', () => ({
  generateCommandExplanation: vi.fn().mockResolvedValue(null),
  buildExplainPrompt: vi.fn(),
}));

let app: express.Express;
let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('AUTH_TTL_MS', '1000'); // 1s TTL for expiry tests
  delete process.env.HOOK_SECRET;
  delete process.env.FEISHU_VERIFICATION_TOKEN;

  // Clean up permission rules from previous tests
  try { if (fs.existsSync(RULES_FILE)) fs.unlinkSync(RULES_FILE); } catch { /* ignore */ }

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
  try { if (fs.existsSync(RULES_FILE)) fs.unlinkSync(RULES_FILE); } catch { /* ignore */ }
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

function createAuthRequest(overrides: any = {}) {
  return fetchJson(`${baseUrl}/api/hook/pre-tool`, {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'test-session',
      tool: 'Bash',
      tool_input: { command: 'git push origin main' },
      options: ['Yes', 'Yes, always', "Yes, don't ask again for this project", 'No'],
      cwd: '/test/project',
      ...overrides,
    }),
  });
}

function clickButton(requestId: string, action: string, sessionId = 'test-session') {
  return fetchJson(`${baseUrl}/api/feishu/webhook`, {
    method: 'POST',
    body: JSON.stringify({
      header: { event_type: 'card.action.trigger' },
      event: {
        action: {
          value: JSON.stringify({ requestId, action, sessionId }),
        },
      },
    }),
  });
}

describe('Integration: "Always Allow" Rule Creation', () => {
  it('should create a permission rule when user clicks "Yes, always"', async () => {
    const createRes = await createAuthRequest();
    const { requestId } = createRes.body;

    // Click "Yes, always"
    await clickButton(requestId, 'Yes, always');

    // Verify the auth was resolved
    const pollRes = await fetchJson(`${baseUrl}/api/hook/auth-poll?requestId=${requestId}`);
    expect(pollRes.body.status).toBe('resolved');
    expect(pollRes.body.decision).toBe('allow');

    // Now create another request with the same command pattern —
    // it should be auto-allowed by the rule
    const createRes2 = await createAuthRequest({
      tool_input: { command: 'git push origin develop' }, // same pattern: git push**
    });

    // The server should return an immediate decision (no requestId)
    expect(createRes2.body.decision).toBe('allow');
    expect(createRes2.body.requestId).toBeNull();
    expect(createRes2.body.reason).toContain('规则');
  });

  it('should create project-scoped rule for "don\'t ask again for this project"', async () => {
    const createRes = await createAuthRequest({
      tool_input: { command: 'npm publish' },
      cwd: '/home/user/project-a',
    });
    const { requestId } = createRes.body;

    await clickButton(requestId, "Yes, don't ask again for this project");

    // Same command, same project: should be auto-allowed
    const sameProjectRes = await createAuthRequest({
      tool_input: { command: 'npm publish --tag beta' },
      cwd: '/home/user/project-a',
    });
    expect(sameProjectRes.body.decision).toBe('allow');

    // Same command, different project: should NOT be auto-allowed
    const diffProjectRes = await createAuthRequest({
      tool_input: { command: 'npm publish' },
      cwd: '/home/user/project-b',
    });
    expect(diffProjectRes.body.requestId).toBeDefined();
    expect(diffProjectRes.body.requestId).not.toBeNull();
  });
});

describe('Integration: Auth Request Expiration', () => {
  it('should expire pending request after TTL', async () => {
    const createRes = await createAuthRequest();
    const { requestId } = createRes.body;

    // Poll immediately — pending
    const poll1 = await fetchJson(`${baseUrl}/api/hook/auth-poll?requestId=${requestId}`);
    expect(poll1.body.status).toBe('pending');

    // Wait for TTL (1000ms) + buffer
    await new Promise((r) => setTimeout(r, 1200));

    // Poll again — expired
    const poll2 = await fetchJson(`${baseUrl}/api/hook/auth-poll?requestId=${requestId}`);
    expect(poll2.body.status).toBe('expired');
  });

  it('should reject button click on expired request', async () => {
    const createRes = await createAuthRequest();
    const { requestId } = createRes.body;

    // Wait for TTL (1000ms) + buffer
    await new Promise((r) => setTimeout(r, 1200));

    // Click button after expiry
    const clickRes = await clickButton(requestId, 'Yes');
    expect(clickRes.status).toBe(200); // endpoint still returns 200

    // Decision should not change to allow
    const pollRes = await fetchJson(`${baseUrl}/api/hook/auth-poll?requestId=${requestId}`);
    expect(pollRes.body.status).toBe('expired');
  });
});

describe('Integration: Feishu Webhook Edge Cases', () => {
  it('should handle Feishu URL verification challenge', async () => {
    const res = await fetchJson(`${baseUrl}/api/feishu/webhook`, {
      method: 'POST',
      body: JSON.stringify({ challenge: 'my-challenge-token' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('my-challenge-token');
  });

  it('should handle unknown event types gracefully', async () => {
    const res = await fetchJson(`${baseUrl}/api/feishu/webhook`, {
      method: 'POST',
      body: JSON.stringify({
        header: { event_type: 'some.unknown.event' },
        event: {},
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should handle card action with missing requestId', async () => {
    const res = await fetchJson(`${baseUrl}/api/feishu/webhook`, {
      method: 'POST',
      body: JSON.stringify({
        header: { event_type: 'card.action.trigger' },
        event: {
          action: {
            value: JSON.stringify({ action: 'Yes', sessionId: 'test' }), // no requestId
          },
        },
      }),
    });
    expect(res.status).toBe(200); // should not crash
  });

  it('should handle card action with invalid JSON value', async () => {
    const res = await fetchJson(`${baseUrl}/api/feishu/webhook`, {
      method: 'POST',
      body: JSON.stringify({
        header: { event_type: 'card.action.trigger' },
        event: {
          action: {
            value: 'not-json',
          },
        },
      }),
    });
    expect(res.status).toBe(200); // should not crash
  });
});

describe('Integration: HOOK_SECRET Authentication', () => {
  it('should reject hook requests without correct secret', async () => {
    // Set hook secret
    process.env.HOOK_SECRET = 'test-secret';

    // Request without header
    const res1 = await fetchJson(`${baseUrl}/api/hook/pre-tool`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'test',
        tool: 'Bash',
        tool_input: { command: 'git push' },
        options: ['Yes', 'No'],
      }),
    });
    expect(res1.status).toBe(401);

    // Request with wrong header
    const res2 = await fetch(`${baseUrl}/api/hook/pre-tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hook-Secret': 'wrong-secret',
      },
      body: JSON.stringify({
        session_id: 'test',
        tool: 'Bash',
        tool_input: { command: 'git push' },
        options: ['Yes', 'No'],
      }),
    });
    expect(res2.status).toBe(401);

    // Request with correct header
    const res3 = await fetch(`${baseUrl}/api/hook/pre-tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hook-Secret': 'test-secret',
      },
      body: JSON.stringify({
        session_id: 'test',
        tool: 'Bash',
        tool_input: { command: 'git push' },
        options: ['Yes', 'No'],
      }),
    });
    expect(res3.status).toBe(200);

    delete process.env.HOOK_SECRET;
  });
});

describe('Integration: Non-Bash Tool Authorization', () => {
  it('should handle Edit tool authorization', async () => {
    const createRes = await fetchJson(`${baseUrl}/api/hook/pre-tool`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'test-session',
        tool: 'Edit',
        tool_input: { file_path: '/etc/passwd', old_string: 'root', new_string: 'hacked' },
        options: ['Yes', 'No'],
        cwd: '/test/project',
      }),
    });
    expect(createRes.status).toBe(200);
    expect(createRes.body.requestId).toBeDefined();

    const { requestId } = createRes.body;

    // Resolve it
    await clickButton(requestId, 'No');

    const pollRes = await fetchJson(`${baseUrl}/api/hook/auth-poll?requestId=${requestId}`);
    expect(pollRes.body.status).toBe('resolved');
    expect(pollRes.body.decision).toBe('deny');
  });
});
