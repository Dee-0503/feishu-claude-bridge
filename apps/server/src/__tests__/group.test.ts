import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// Mock feishu client — createGroup calls feishuClient.im.chat.create
vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    im: {
      chat: {
        create: vi.fn().mockResolvedValue({
          data: { chat_id: 'new-chat-id' },
        }),
      },
    },
  },
}));

// Mock log to suppress output
vi.mock('../utils/log.js', () => ({
  log: vi.fn(),
}));

// We need to mock fs to control loadGroupMappings / saveGroupMapping
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
  };
});

const mockedFs = vi.mocked(fs);

describe('group utilities', () => {
  describe('extractProjectName', () => {
    let extractProjectName: typeof import('../feishu/group.js').extractProjectName;

    beforeEach(async () => {
      vi.resetModules();
      const mod = await import('../feishu/group.js');
      extractProjectName = mod.extractProjectName;
    });

    it('should return basename for worktree path', () => {
      expect(
        extractProjectName('/Users/ceemac/my_product/feishu-claude-bridge-worktrees/phase2')
      ).toBe('phase2');
    });

    it('should return basename for non-worktree path', () => {
      expect(
        extractProjectName('/Users/ceemac/my_product/my-project')
      ).toBe('my-project');
    });

    it('should return basename for nested worktree paths', () => {
      expect(
        extractProjectName('/home/user/some-project-worktrees/feature-branch')
      ).toBe('feature-branch');
    });
  });

  describe('getNormalizedProjectPath', () => {
    let getNormalizedProjectPath: typeof import('../feishu/group.js').getNormalizedProjectPath;

    beforeEach(async () => {
      vi.resetModules();
      const mod = await import('../feishu/group.js');
      getNormalizedProjectPath = mod.getNormalizedProjectPath;
    });

    it('should return worktree path unchanged', () => {
      expect(
        getNormalizedProjectPath('/Users/ceemac/my_product/feishu-claude-bridge-worktrees/phase3')
      ).toBe('/Users/ceemac/my_product/feishu-claude-bridge-worktrees/phase3');
    });

    it('should return same path for non-worktree path', () => {
      expect(
        getNormalizedProjectPath('/Users/ceemac/my_product/my-project')
      ).toBe('/Users/ceemac/my_product/my-project');
    });
  });
});

describe('getOrCreateProjectGroup', () => {
  beforeEach(() => {
    vi.resetModules();
    mockedFs.existsSync.mockReset();
    mockedFs.readFileSync.mockReset();
    mockedFs.writeFileSync.mockReset();
    mockedFs.mkdirSync.mockReset();
    process.env.FEISHU_TARGET_ID = 'test-user-id';
  });

  it('should return existing chatId when mapping exists', async () => {
    const mappings = {
      '/projects/my-app': {
        chatId: 'existing-chat-id',
        projectName: 'my-app',
        projectPath: '/projects/my-app',
        createdAt: '2024-01-01',
      },
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(mappings));

    const { getOrCreateProjectGroup } = await import('../feishu/group.js');
    const chatId = await getOrCreateProjectGroup('/projects/my-app');
    expect(chatId).toBe('existing-chat-id');
  });

  it('should create new group when no mapping exists', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const { getOrCreateProjectGroup } = await import('../feishu/group.js');
    const chatId = await getOrCreateProjectGroup('/projects/new-app');
    expect(chatId).toBe('new-chat-id');
    // Should have saved the mapping
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
  });

  it('should recreate group after markChatInvalid (旧群被删)', async () => {
    const mappings = {
      '/projects/my-app': {
        chatId: 'old-deleted-chat-id',
        projectName: 'my-app',
        projectPath: '/projects/my-app',
        createdAt: '2024-01-01',
      },
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(mappings));

    const { getOrCreateProjectGroup, markChatInvalid } = await import('../feishu/group.js');

    // First call: mapping exists → returns existing
    const chatId1 = await getOrCreateProjectGroup('/projects/my-app');
    expect(chatId1).toBe('old-deleted-chat-id');

    // Simulate: message send failed → mark chat invalid
    markChatInvalid('old-deleted-chat-id');

    // Second call: mapping exists but chatId is invalid → creates new group
    const chatId2 = await getOrCreateProjectGroup('/projects/my-app');
    expect(chatId2).toBe('new-chat-id');
    expect(chatId2).not.toBe('old-deleted-chat-id');
  });

  it('should treat different worktree dirs as separate groups', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const { getOrCreateProjectGroup } = await import('../feishu/group.js');

    await getOrCreateProjectGroup('/projects/worktrees/phase1');
    await getOrCreateProjectGroup('/projects/worktrees/phase3');

    // writeFileSync should be called twice — once per distinct group
    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(2);
  });
});
