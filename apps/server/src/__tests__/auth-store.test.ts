import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock environment before importing
vi.stubEnv('AUTH_TTL_MS', '5000');

// We need to reset the module for each test since authStore is a singleton
let authStore: any;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('AUTH_TTL_MS', '5000');
  const mod = await import('../store/auth-store.js');
  authStore = mod.authStore;
});

describe('AuthStore', () => {
  describe('create', () => {
    it('should create an auth request with generated UUID', () => {
      const req = authStore.create({
        sessionId: 'sess-1',
        tool: 'Bash',
        toolInput: { command: 'git push' },
        command: 'git push',
        options: ['Yes', 'No'],
      });

      expect(req.requestId).toBeDefined();
      expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(req.status).toBe('pending');
      expect(req.tool).toBe('Bash');
      expect(req.sessionId).toBe('sess-1');
      expect(req.createdAt).toBeGreaterThan(0);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent request', () => {
      expect(authStore.get('non-existent')).toBeUndefined();
    });

    it('should return the created request', () => {
      const created = authStore.create({
        sessionId: 'sess-1',
        tool: 'Bash',
        toolInput: { command: 'rm -rf /' },
        command: 'rm -rf /',
        options: ['Yes', 'No'],
      });

      const fetched = authStore.get(created.requestId);
      expect(fetched).toBeDefined();
      expect(fetched!.requestId).toBe(created.requestId);
      expect(fetched!.status).toBe('pending');
    });

    it('should mark expired requests', async () => {
      const created = authStore.create({
        sessionId: 'sess-1',
        tool: 'Bash',
        toolInput: {},
        command: 'test',
        options: [],
      });

      // Manually backdate the request
      created.createdAt = Date.now() - 10000; // 10 seconds ago (TTL is 5s)

      const fetched = authStore.get(created.requestId);
      expect(fetched!.status).toBe('expired');
    });
  });

  describe('resolve', () => {
    it('should resolve a pending request', () => {
      const created = authStore.create({
        sessionId: 'sess-1',
        tool: 'Bash',
        toolInput: {},
        command: 'git push',
        options: ['Yes', 'No'],
      });

      const resolved = authStore.resolve(created.requestId, 'allow', 'Yes');
      expect(resolved).toBeDefined();
      expect(resolved!.status).toBe('resolved');
      expect(resolved!.decision).toBe('allow');
      expect(resolved!.decisionReason).toBe('Yes');
      expect(resolved!.resolvedAt).toBeGreaterThan(0);
    });

    it('should return undefined for non-existent request', () => {
      expect(authStore.resolve('non-existent', 'allow', 'test')).toBeUndefined();
    });

    it('should be idempotent - second resolve returns already-resolved request without changing it', () => {
      const created = authStore.create({
        sessionId: 'sess-1',
        tool: 'Bash',
        toolInput: {},
        command: 'git push',
        options: ['Yes', 'No'],
      });

      const first = authStore.resolve(created.requestId, 'allow', 'Yes');
      const second = authStore.resolve(created.requestId, 'deny', 'No');

      // Second call should not change the decision
      expect(second!.decision).toBe('allow');
      expect(second!.decisionReason).toBe('Yes');
    });
  });

  describe('cleanup', () => {
    it('should remove old requests', () => {
      const created = authStore.create({
        sessionId: 'sess-1',
        tool: 'Bash',
        toolInput: {},
        command: 'test',
        options: [],
      });

      // Backdate far beyond 2x TTL
      created.createdAt = Date.now() - 20000;

      const cleaned = authStore.cleanup();
      expect(cleaned).toBe(1);
      expect(authStore.get(created.requestId)).toBeUndefined();
    });
  });
});
