import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const RULES_FILE = path.join(DATA_DIR, 'permission-rules.json');

let permissionRules: any;

beforeEach(async () => {
  vi.resetModules();
  // Clean up rules file
  try {
    if (fs.existsSync(RULES_FILE)) {
      fs.unlinkSync(RULES_FILE);
    }
  } catch {
    // ignore
  }
  const mod = await import('../store/permission-rules.js');
  permissionRules = mod.permissionRules;
});

afterEach(() => {
  try {
    if (fs.existsSync(RULES_FILE)) {
      fs.unlinkSync(RULES_FILE);
    }
  } catch {
    // ignore
  }
});

describe('PermissionRuleStore', () => {
  describe('addRule', () => {
    it('should add a rule and persist to file', () => {
      const rule = permissionRules.addRule({
        tool: 'Bash',
        commandPattern: 'git push**',
        scope: 'always',
      });

      expect(rule.id).toBeDefined();
      expect(rule.tool).toBe('Bash');
      expect(rule.commandPattern).toBe('git push**');
      expect(rule.scope).toBe('always');
      expect(rule.createdAt).toBeDefined();

      // Verify persistence
      expect(fs.existsSync(RULES_FILE)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
      expect(saved).toHaveLength(1);
      expect(saved[0].id).toBe(rule.id);
    });
  });

  describe('match', () => {
    it('should match exact tool', () => {
      permissionRules.addRule({
        tool: 'Bash',
        scope: 'always',
      });

      expect(permissionRules.match('Bash')).not.toBeNull();
      expect(permissionRules.match('Edit')).toBeNull();
    });

    it('should match command pattern with glob', () => {
      permissionRules.addRule({
        tool: 'Bash',
        commandPattern: 'git push**',
        scope: 'always',
      });

      expect(permissionRules.match('Bash', 'git push origin main')).not.toBeNull();
      expect(permissionRules.match('Bash', 'git push')).not.toBeNull();
      expect(permissionRules.match('Bash', 'git pull')).toBeNull();
    });

    it('should match project scope', () => {
      permissionRules.addRule({
        tool: 'Bash',
        commandPattern: 'npm publish**',
        projectPath: '/home/user/project-a',
        scope: 'project',
      });

      expect(permissionRules.match('Bash', 'npm publish', '/home/user/project-a')).not.toBeNull();
      expect(permissionRules.match('Bash', 'npm publish', '/home/user/project-a/sub')).not.toBeNull();
      expect(permissionRules.match('Bash', 'npm publish', '/home/user/project-b')).toBeNull();
    });

    it('should return null when no command matches pattern', () => {
      permissionRules.addRule({
        tool: 'Bash',
        commandPattern: 'docker**',
        scope: 'always',
      });

      expect(permissionRules.match('Bash', 'git push')).toBeNull();
    });
  });

  describe('removeRule', () => {
    it('should remove an existing rule', () => {
      const rule = permissionRules.addRule({
        tool: 'Bash',
        commandPattern: 'test**',
        scope: 'always',
      });

      expect(permissionRules.removeRule(rule.id)).toBe(true);
      expect(permissionRules.match('Bash', 'test command')).toBeNull();
    });

    it('should return false for non-existent rule', () => {
      expect(permissionRules.removeRule('non-existent')).toBe(false);
    });
  });
});
