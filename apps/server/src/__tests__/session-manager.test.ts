import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// Mock feishu client
vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({ data: { message_id: 'mock-msg-id' } }),
        patch: vi.fn().mockResolvedValue({}),
      },
    },
  },
}));

// Mock group
vi.mock('../feishu/group.js', () => ({
  getOrCreateProjectGroup: vi.fn().mockResolvedValue('mock-chat-id'),
  getProjectPathByChatId: vi.fn().mockReturnValue('/project'),
  loadGroupMappings: vi.fn().mockReturnValue({}),
  saveGroupMapping: vi.fn(),
  extractProjectName: vi.fn().mockReturnValue('test'),
  getNormalizedProjectPath: vi.fn((p: string) => p),
}));

// Mock message-session-map
vi.mock('../services/message-session-map.js', () => ({
  registerMessageSession: vi.fn(),
  getActiveSessionsByChatId: vi.fn().mockReturnValue([]),
  getLatestSessionByChatId: vi.fn().mockReturnValue(null),
  storePendingText: vi.fn().mockReturnValue('pending_123'),
  retrievePendingText: vi.fn().mockReturnValue('stored text'),
  initMessageSessionMap: vi.fn(),
}));

import { registerMessageSession, getActiveSessionsByChatId, retrievePendingText } from '../services/message-session-map.js';

// Create mock process
function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.pid = 12345;
  return proc;
}

let sessionManager: typeof import('../services/session-manager.js');

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.FEISHU_TARGET_ID = 'test-target';
  process.env.SESSION_MAX_CONCURRENT = '5';
  sessionManager = await import('../services/session-manager.js');
});

describe('session-manager', () => {
  describe('dispatch', () => {
    it('should route new_task intent', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await sessionManager.dispatch({
        type: 'new_task',
        text: 'fix the bug',
        chatId: 'chat-1',
        projectPath: '/project/a',
      });

      // Should have called spawn
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = mockSpawn.mock.calls[0];
      expect(cmd).toBe('claude');
      expect(args).toContain('--print');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--permission-mode');
      expect(args).toContain('acceptEdits');
      expect(args).toContain('-p');
      expect(args).toContain('fix the bug');
      expect(args).toContain('--session-id');
      expect(opts.cwd).toBe('/project/a');
    });

    it('should route continue_session intent with --resume', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await sessionManager.dispatch({
        type: 'continue_session',
        text: 'also fix that',
        sessionId: 'existing-session-id',
        chatId: 'chat-1',
        projectPath: '/project/a',
      });

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('--resume');
      expect(args).toContain('existing-session-id');
      expect(args).toContain('-p');
      expect(args).toContain('also fix that');
    });

    it('should route choose_session intent - auto start when no active sessions', async () => {
      // No active sessions → should auto-start new session
      (getActiveSessionsByChatId as any).mockReturnValue([]);

      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await sessionManager.dispatch({
        type: 'choose_session',
        text: 'fix CSS',
        chatId: 'chat-1',
        projectPath: '/project/a',
        messageId: 'msg-1',
      });

      // Should spawn new session directly
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('startNewSession', () => {
    it('should spawn claude with --session-id and register mapping', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const sessionId = await sessionManager.startNewSession('/project', 'do something', 'chat-1');

      expect(sessionId).toBeDefined();
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

      // Should register mapping
      expect(registerMessageSession).toHaveBeenCalledWith(
        'mock-msg-id',
        sessionId,
        'chat-1',
        '/project',
      );

      // Verify spawn args
      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('--session-id');
      expect(args).toContain(sessionId);
      expect(args).not.toContain('--resume');
    });
  });

  describe('continueSession', () => {
    it('should spawn with --resume', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await sessionManager.continueSession('sess-abc', 'more work', 'chat-1', '/project');

      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('--resume');
      expect(args).toContain('sess-abc');
    });

    it('should queue message if session already running', async () => {
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();
      mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

      // Start first task
      await sessionManager.startNewSession('/project', 'task 1', 'chat-1');
      const sessionId = mockSpawn.mock.calls[0][1][mockSpawn.mock.calls[0][1].indexOf('--session-id') + 1];

      // Try to continue while first is running
      await sessionManager.continueSession(sessionId, 'task 2', 'chat-1', '/project');

      // Second spawn should NOT happen yet (queued)
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      // When first process exits, queued task should execute
      proc1.emit('exit', 0, null);

      // Wait for async processing
      await new Promise(r => setTimeout(r, 50));

      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });
  });

  describe('sendSessionChoiceCard', () => {
    it('should auto-start new session when no active sessions', async () => {
      (getActiveSessionsByChatId as any).mockReturnValue([]);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await sessionManager.sendSessionChoiceCard('/project', 'fix bug', 'chat-1', 'msg-1');

      // Should have spawned directly (no choice card)
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('should send choice card when active sessions exist', async () => {
      (getActiveSessionsByChatId as any).mockReturnValue([
        { sessionId: 'sess-1', lastActivity: Date.now() },
        { sessionId: 'sess-2', lastActivity: Date.now() - 60000 },
      ]);

      await sessionManager.sendSessionChoiceCard('/project', 'fix bug', 'chat-1', 'msg-1');

      // Should NOT spawn (sends choice card instead)
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('handleSessionChoice', () => {
    it('should start new session for new_session action', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await sessionManager.handleSessionChoice(
        { action: 'new_session', projectPath: '/project', pendingKey: 'key-1' },
        'chat-1',
      );

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('--session-id');
      expect(args).toContain('-p');
      expect(args).toContain('stored text');
    });

    it('should resume session for choose_session action', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await sessionManager.handleSessionChoice(
        { action: 'choose_session', sessionId: 'sess-1', projectPath: '/project', pendingKey: 'key-1' },
        'chat-1',
      );

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('--resume');
      expect(args).toContain('sess-1');
    });

    it('should handle expired pending text', async () => {
      (retrievePendingText as any).mockReturnValue(null);

      await sessionManager.handleSessionChoice(
        { action: 'new_session', projectPath: '/project', pendingKey: 'expired-key' },
        'chat-1',
      );

      // Should not spawn (text expired)
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('process lifecycle', () => {
    it('should handle normal exit and decrement running count', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await sessionManager.startNewSession('/project', 'task', 'chat-1');
      expect(sessionManager.getRunningCount()).toBe(1);

      proc.emit('exit', 0, null);

      expect(sessionManager.getRunningCount()).toBe(0);
    });

    it('should handle abnormal exit with error message', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      await sessionManager.startNewSession('/project', 'task', 'chat-1');
      expect(sessionManager.getRunningCount()).toBe(1);

      // Send stderr data before exit
      proc.stderr.emit('data', Buffer.from('something went wrong'));
      proc.emit('exit', 1, null);

      expect(sessionManager.getRunningCount()).toBe(0);
    });
  });

  describe('concurrency limit', () => {
    it('should reject when max concurrent reached', async () => {
      process.env.SESSION_MAX_CONCURRENT = '2';
      vi.resetModules();
      const localSessionManager = await import('../services/session-manager.js');

      const proc1 = createMockProcess();
      const proc2 = createMockProcess();
      const proc3 = createMockProcess();
      mockSpawn
        .mockReturnValueOnce(proc1)
        .mockReturnValueOnce(proc2)
        .mockReturnValueOnce(proc3);

      await localSessionManager.startNewSession('/project', 'task 1', 'chat-1');
      await localSessionManager.startNewSession('/project', 'task 2', 'chat-1');

      // Third should be rejected
      await localSessionManager.startNewSession('/project', 'task 3', 'chat-1');

      // Only 2 spawns (third rejected due to limit)
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });
  });

});
