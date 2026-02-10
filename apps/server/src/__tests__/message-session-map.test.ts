import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const MAP_FILE = path.join(DATA_DIR, 'message-session-map.json');

let mod: typeof import('../services/message-session-map.js');

beforeEach(async () => {
  vi.resetModules();
  // Clean up map file
  try {
    if (fs.existsSync(MAP_FILE)) {
      fs.unlinkSync(MAP_FILE);
    }
  } catch {
    // ignore
  }
  mod = await import('../services/message-session-map.js');
});

afterEach(() => {
  try {
    if (fs.existsSync(MAP_FILE)) {
      fs.unlinkSync(MAP_FILE);
    }
  } catch {
    // ignore
  }
});

describe('message-session-map', () => {
  describe('registerMessageSession / getSessionByMessageId', () => {
    it('should register and retrieve a mapping', () => {
      mod.registerMessageSession('msg-1', 'sess-1', 'chat-1', '/project/a');

      const result = mod.getSessionByMessageId('msg-1');
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('sess-1');
      expect(result!.chatId).toBe('chat-1');
      expect(result!.projectPath).toBe('/project/a');
    });

    it('should return null for non-existent message', () => {
      expect(mod.getSessionByMessageId('non-existent')).toBeNull();
    });

    it('should register multiple mappings', () => {
      mod.registerMessageSession('msg-1', 'sess-1', 'chat-1');
      mod.registerMessageSession('msg-2', 'sess-2', 'chat-1');
      mod.registerMessageSession('msg-3', 'sess-1', 'chat-2');

      expect(mod.getSessionByMessageId('msg-1')!.sessionId).toBe('sess-1');
      expect(mod.getSessionByMessageId('msg-2')!.sessionId).toBe('sess-2');
      expect(mod.getSessionByMessageId('msg-3')!.sessionId).toBe('sess-1');
    });
  });

  describe('getActiveSessionsByChatId', () => {
    it('should return empty array for unknown chat', () => {
      expect(mod.getActiveSessionsByChatId('unknown')).toEqual([]);
    });

    it('should return sessions for a chat, sorted by most recent', () => {
      mod.registerMessageSession('msg-1', 'sess-1', 'chat-1', '/project');
      // Small delay to ensure different timestamps
      mod.registerMessageSession('msg-2', 'sess-2', 'chat-1', '/project');

      const sessions = mod.getActiveSessionsByChatId('chat-1');
      expect(sessions.length).toBe(2);
      // Most recent first
      expect(sessions[0].sessionId).toBe('sess-2');
      expect(sessions[1].sessionId).toBe('sess-1');
    });

    it('should not return sessions from other chats', () => {
      mod.registerMessageSession('msg-1', 'sess-1', 'chat-1');
      mod.registerMessageSession('msg-2', 'sess-2', 'chat-2');

      const sessions = mod.getActiveSessionsByChatId('chat-1');
      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe('sess-1');
    });

    it('should update existing session timestamp', async () => {
      mod.registerMessageSession('msg-1', 'sess-1', 'chat-1');
      mod.registerMessageSession('msg-2', 'sess-2', 'chat-1');

      // Wait to ensure different timestamp
      await new Promise(r => setTimeout(r, 10));

      // Re-register sess-1 with new message
      mod.registerMessageSession('msg-3', 'sess-1', 'chat-1');

      const sessions = mod.getActiveSessionsByChatId('chat-1');
      expect(sessions.length).toBe(2);
      // sess-1 should now be first (most recent)
      expect(sessions[0].sessionId).toBe('sess-1');
    });
  });

  describe('getLatestSessionByChatId', () => {
    it('should return null for unknown chat', () => {
      expect(mod.getLatestSessionByChatId('unknown')).toBeNull();
    });

    it('should return the most recent session', () => {
      mod.registerMessageSession('msg-1', 'sess-1', 'chat-1');
      mod.registerMessageSession('msg-2', 'sess-2', 'chat-1');

      const latest = mod.getLatestSessionByChatId('chat-1');
      expect(latest).not.toBeNull();
      expect(latest!.sessionId).toBe('sess-2');
    });
  });

  describe('storePendingText / retrievePendingText', () => {
    it('should store and retrieve text', () => {
      const key = mod.storePendingText('fix CSS issue');
      expect(key).toBeDefined();
      expect(key).toMatch(/^pending_/);

      const text = mod.retrievePendingText(key);
      expect(text).toBe('fix CSS issue');
    });

    it('should return null for non-existent key', () => {
      expect(mod.retrievePendingText('non-existent')).toBeNull();
    });

    it('should consume pending text (one-time read)', () => {
      const key = mod.storePendingText('hello');

      expect(mod.retrievePendingText(key)).toBe('hello');
      // Second retrieval should return null
      expect(mod.retrievePendingText(key)).toBeNull();
    });
  });

  describe('persistence', () => {
    it('should persist mappings to disk', () => {
      mod.registerMessageSession('msg-1', 'sess-1', 'chat-1', '/project');

      expect(fs.existsSync(MAP_FILE)).toBe(true);
      const data = JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'));
      expect(data.messageSession['msg-1']).toBeDefined();
      expect(data.messageSession['msg-1'].sessionId).toBe('sess-1');
    });

    it('should restore mappings from disk on init', async () => {
      // Write test data
      mod.registerMessageSession('msg-1', 'sess-1', 'chat-1');

      // Re-import module to test restore
      vi.resetModules();
      const mod2 = await import('../services/message-session-map.js');
      mod2.initMessageSessionMap();

      const result = mod2.getSessionByMessageId('msg-1');
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('sess-1');
    });
  });

  describe('initMessageSessionMap', () => {
    it('should not throw when map file does not exist', () => {
      expect(() => mod.initMessageSessionMap()).not.toThrow();
    });

    it('should not throw on corrupted file', () => {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(MAP_FILE, 'invalid json{{{');

      vi.resetModules();
      // Should not throw
      expect(async () => {
        const mod3 = await import('../services/message-session-map.js');
        mod3.initMessageSessionMap();
      }).not.toThrow();
    });
  });
});
