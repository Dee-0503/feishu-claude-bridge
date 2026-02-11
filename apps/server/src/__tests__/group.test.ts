import { describe, it, expect } from 'vitest';
import {
  extractProjectName,
  getNormalizedProjectPath,
} from '../feishu/group.js';

describe('group utilities', () => {
  describe('extractProjectName', () => {
    it('should use basename for worktree path', () => {
      expect(
        extractProjectName('/Users/ceemac/my_product/feishu-claude-bridge-worktrees/phase2')
      ).toBe('phase2');
    });

    it('should return basename for non-worktree path', () => {
      expect(
        extractProjectName('/Users/ceemac/my_product/my-project')
      ).toBe('my-project');
    });

    it('should use basename for nested worktree paths', () => {
      expect(
        extractProjectName('/home/user/some-project-worktrees/feature-branch')
      ).toBe('feature-branch');
    });
  });

  describe('getNormalizedProjectPath', () => {
    it('should return path as-is (no normalization)', () => {
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
