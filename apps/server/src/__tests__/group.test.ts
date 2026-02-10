import { describe, it, expect } from 'vitest';
import {
  extractProjectName,
  getNormalizedProjectPath,
} from '../feishu/group.js';

describe('group utilities', () => {
  describe('extractProjectName', () => {
    it('should extract project name from worktree path', () => {
      expect(
        extractProjectName('/Users/ceemac/my_product/feishu-claude-bridge-worktrees/phase2')
      ).toBe('feishu-claude-bridge');
    });

    it('should return basename for non-worktree path', () => {
      expect(
        extractProjectName('/Users/ceemac/my_product/my-project')
      ).toBe('my-project');
    });

    it('should handle nested worktree paths', () => {
      expect(
        extractProjectName('/home/user/some-project-worktrees/feature-branch')
      ).toBe('some-project');
    });
  });

  describe('getNormalizedProjectPath', () => {
    it('should normalize worktree path to main project path', () => {
      expect(
        getNormalizedProjectPath('/Users/ceemac/my_product/feishu-claude-bridge-worktrees/phase3')
      ).toBe('/Users/ceemac/my_product/feishu-claude-bridge');
    });

    it('should return same path for non-worktree path', () => {
      expect(
        getNormalizedProjectPath('/Users/ceemac/my_product/my-project')
      ).toBe('/Users/ceemac/my_product/my-project');
    });
  });
});
