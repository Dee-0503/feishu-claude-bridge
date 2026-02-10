import { describe, it, expect } from 'vitest';
import { buildExplainPrompt } from '../services/command-explain.js';

describe('Command Explanation', () => {
  describe('buildExplainPrompt', () => {
    it('should build a prompt with command and options', () => {
      const prompt = buildExplainPrompt(
        'Bash',
        'git push origin main',
        ['Yes', 'Yes, always', 'No'],
        '/Users/ceemac/my-project'
      );

      expect(prompt).toContain('git push origin main');
      expect(prompt).toContain('Bash');
      expect(prompt).toContain('/Users/ceemac/my-project');
      expect(prompt).toContain('"Yes"');
      expect(prompt).toContain('"Yes, always"');
      expect(prompt).toContain('"No"');
      expect(prompt).toContain('风险');
      expect(prompt).toContain('可逆');
      expect(prompt).toContain('JSON');
    });

    it('should work without cwd', () => {
      const prompt = buildExplainPrompt(
        'Bash',
        'rm -rf /tmp/build',
        ['Yes', 'No'],
      );

      expect(prompt).toContain('rm -rf /tmp/build');
      expect(prompt).not.toContain('工作目录');
    });

    it('should number options sequentially', () => {
      const prompt = buildExplainPrompt(
        'Bash',
        'docker push',
        ['Allow once', 'Allow for this session', 'Deny'],
      );

      expect(prompt).toContain('1. "Allow once"');
      expect(prompt).toContain('2. "Allow for this session"');
      expect(prompt).toContain('3. "Deny"');
    });
  });
});
