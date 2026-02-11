import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { EventEmitter } from 'events';

// Mock spawn
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// Mock feishu client
const mockCreate = vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { message_id: 'mock-msg-id' } });
const mockReply = vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { message_id: 'mock-msg-id' } });
vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    im: {
      message: {
        create: (...args: any[]) => mockCreate(...args),
        reply: (...args: any[]) => mockReply(...args),
        patch: vi.fn().mockResolvedValue({ code: 0, msg: 'success' }),
      },
      chat: {
        create: vi.fn().mockResolvedValue({ data: { chat_id: 'mock-chat-id' } }),
      },
    },
  },
}));

// Mock group - return project path for test chat
vi.mock('../feishu/group.js', () => ({
  getProjectPathByChatId: vi.fn().mockReturnValue('/test/project'),
  getOrCreateProjectGroup: vi.fn().mockResolvedValue('test-chat-id'),
  loadGroupMappings: vi.fn().mockReturnValue({}),
  saveGroupMapping: vi.fn(),
  extractProjectName: vi.fn().mockReturnValue('test-project'),
  getNormalizedProjectPath: vi.fn((p: string) => p),
  markChatInvalid: vi.fn(),
}));

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.pid = Math.floor(Math.random() * 10000);
  return proc;
}

let app: express.Express;
let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();

  process.env.FEISHU_TARGET_ID = 'test-target';
  process.env.FEISHU_TARGET_TYPE = 'chat_id';
  process.env.FEISHU_BOT_OPEN_ID = 'bot-open-id';
  delete process.env.HOOK_SECRET;

  const { hookRouter } = await import('../routes/hook.js');
  const { feishuRouter } = await import('../routes/feishu.js');
  const { initMessageSessionMap } = await import('../services/message-session-map.js');

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

describe('Integration: End-to-end flows', () => {
  describe('Hook → message mapping registration', () => {
    it('should register message-session mapping on /stop', async () => {
      const res = await fetchJson(`${baseUrl}/api/hook/stop`, {
        method: 'POST',
        body: JSON.stringify({
          session_id: 'test-session',
          summary: {
            projectPath: '/test/project',
            projectName: 'test',
            gitBranch: 'main',
            sessionId: 'test-session',
            sessionShortId: 'abcd',
            taskDescription: 'Fix bug',
            completionMessage: 'Done',
            toolStats: { bash: 0, edit: 1, write: 0, read: 0, glob: 0, grep: 0, task: 0 },
            filesModified: ['src/app.ts'],
            filesCreated: [],
            duration: 30,
            timestamp: new Date().toISOString(),
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Card message should have been sent
      expect(mockCreate).toHaveBeenCalled();
    });

    it('should register mapping on /pre-tool', async () => {
      const res = await fetchJson(`${baseUrl}/api/hook/pre-tool`, {
        method: 'POST',
        body: JSON.stringify({
          session_id: 'test-session',
          tool: 'Bash',
          tool_input: { command: 'git push' },
          cwd: '/test/project',
        }),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should register mapping on /authorization', async () => {
      const res = await fetchJson(`${baseUrl}/api/hook/authorization`, {
        method: 'POST',
        body: JSON.stringify({
          session_id: 'test-session',
          title: '需要授权',
          message: '确认操作',
          cwd: '/test/project',
        }),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('Webhook message → Claude spawn', () => {
    it('should spawn Claude for @bot message', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const res = await fetchJson(`${baseUrl}/api/feishu/webhook`, {
        method: 'POST',
        body: JSON.stringify({
          header: {
            event_id: 'evt-integration-1',
            event_type: 'im.message.receive_v1',
          },
          event: {
            sender: {
              sender_id: { open_id: 'user-1' },
              sender_type: 'user',
            },
            message: {
              message_id: 'msg-integration-1',
              chat_id: 'test-chat-id',
              message_type: 'text',
              content: JSON.stringify({ text: '@_user_1 fix the CSS' }),
              mentions: [
                { key: '@_user_1', id: { open_id: 'bot-open-id' }, name: 'Claude' },
              ],
            },
          },
        }),
      });

      expect(res.status).toBe(200);

      // Wait for async processing
      await new Promise(r => setTimeout(r, 200));

      // Should have spawned claude
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = mockSpawn.mock.calls[0];
      expect(cmd).toBe('claude');
      expect(args).toContain('fix the CSS');
      expect(args).toContain('--session-id');
    });

    it('should return immediate success for webhook (3s timeout compliance)', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const start = Date.now();
      const res = await fetchJson(`${baseUrl}/api/feishu/webhook`, {
        method: 'POST',
        body: JSON.stringify({
          header: {
            event_id: 'evt-timing-1',
            event_type: 'im.message.receive_v1',
          },
          event: {
            sender: { sender_id: { open_id: 'user-1' }, sender_type: 'user' },
            message: {
              message_id: 'msg-timing-1',
              chat_id: 'test-chat-id',
              message_type: 'text',
              content: JSON.stringify({ text: '@_user_1 do something slow' }),
              mentions: [{ key: '@_user_1', id: { open_id: 'bot-open-id' }, name: 'Claude' }],
            },
          },
        }),
      });

      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      // Should respond within 1 second (well under 3s limit)
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('URL verification', () => {
    it('should handle Feishu challenge', async () => {
      const res = await fetchJson(`${baseUrl}/api/feishu/webhook`, {
        method: 'POST',
        body: JSON.stringify({ challenge: 'my-challenge-token' }),
      });

      expect(res.status).toBe(200);
      expect(res.body.challenge).toBe('my-challenge-token');
    });
  });

  describe('Hook auth middleware', () => {
    it('should reject when HOOK_SECRET is set and header missing', async () => {
      process.env.HOOK_SECRET = 'secret123';

      // Need to re-import to pick up env change
      vi.resetModules();
      const { hookRouter: freshHook } = await import('../routes/hook.js');
      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use('/api/hook', freshHook);

      const freshServer = await new Promise<http.Server>((resolve) => {
        const s = freshApp.listen(0, () => resolve(s));
      });
      const addr = freshServer.address() as any;

      const res = await fetchJson(`http://localhost:${addr.port}/api/hook/stop`, {
        method: 'POST',
        body: JSON.stringify({ session_id: 'test' }),
      });

      expect(res.status).toBe(401);

      await new Promise<void>(r => freshServer.close(() => r()));
      delete process.env.HOOK_SECRET;
    });

    it('should accept when HOOK_SECRET matches', async () => {
      process.env.HOOK_SECRET = 'secret123';

      vi.resetModules();
      const { hookRouter: freshHook } = await import('../routes/hook.js');
      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use('/api/hook', freshHook);

      const freshServer = await new Promise<http.Server>((resolve) => {
        const s = freshApp.listen(0, () => resolve(s));
      });
      const addr = freshServer.address() as any;

      const res = await fetch(`http://localhost:${addr.port}/api/hook/notification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hook-secret': 'secret123',
        },
        body: JSON.stringify({ message: 'test' }),
      });

      expect(res.status).toBe(200);

      await new Promise<void>(r => freshServer.close(() => r()));
      delete process.env.HOOK_SECRET;
    });
  });
});
