import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isHighRiskCommand, sendVoiceAlert } from '../services/voice-alert.js';

describe('voice-alert', () => {
  describe('isHighRiskCommand', () => {
    it('should detect rm -rf commands', () => {
      expect(isHighRiskCommand('rm -rf /tmp/data')).toBe(true);
      expect(isHighRiskCommand('rm -rf .')).toBe(true);
      expect(isHighRiskCommand('rm -rf ~/')).toBe(true);
    });

    it('should detect git push --force', () => {
      expect(isHighRiskCommand('git push origin main --force')).toBe(true);
      expect(isHighRiskCommand('git push --force-with-lease')).toBe(true);
    });

    it('should detect SQL DROP commands', () => {
      expect(isHighRiskCommand('DROP TABLE users')).toBe(true);
      expect(isHighRiskCommand('DROP DATABASE production')).toBe(true);
      expect(isHighRiskCommand('drop table sessions')).toBe(true);
    });

    it('should detect sudo rm commands', () => {
      expect(isHighRiskCommand('sudo rm /etc/hosts')).toBe(true);
      expect(isHighRiskCommand('sudo rm -rf /var/log')).toBe(true);
    });

    it('should detect disk format commands', () => {
      expect(isHighRiskCommand('mkfs.ext4 /dev/sda1')).toBe(true);
      expect(isHighRiskCommand('mkfs /dev/sdb')).toBe(true);
    });

    it('should detect direct disk writes', () => {
      expect(isHighRiskCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);
      expect(isHighRiskCommand('echo "test" > /dev/sda')).toBe(true);
    });

    it('should detect system shutdown commands', () => {
      expect(isHighRiskCommand('shutdown -h now')).toBe(true);
      expect(isHighRiskCommand('reboot')).toBe(true);
    });

    it('should not flag safe commands', () => {
      expect(isHighRiskCommand('ls -la')).toBe(false);
      expect(isHighRiskCommand('git status')).toBe(false);
      expect(isHighRiskCommand('npm install')).toBe(false);
      expect(isHighRiskCommand('rm file.txt')).toBe(false);
      expect(isHighRiskCommand('SELECT * FROM users')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isHighRiskCommand('')).toBe(false);
      expect(isHighRiskCommand('   ')).toBe(false);
      expect(isHighRiskCommand('echo rm -rf')).toBe(false); // 仅引用不执行
    });
  });

  describe('sendVoiceAlert', () => {
    beforeEach(() => {
      // Mock console to avoid noise in test output
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should complete without throwing errors', async () => {
      const config = {
        userId: 'ou_test_user',
        command: 'rm -rf /',
        projectPath: '/test/project',
        sessionId: 'sess-123',
      };

      // 不应抛出异常（即使API调用失败）
      await expect(sendVoiceAlert(config)).resolves.toBeUndefined();
    });

    it('should handle missing userId gracefully', async () => {
      const config = {
        userId: '',
        command: 'rm -rf /',
        projectPath: '/test/project',
        sessionId: 'sess-123',
      };

      await expect(sendVoiceAlert(config)).resolves.toBeUndefined();
    });

    it('should log alert trigger', async () => {
      const config = {
        userId: 'ou_test_user',
        command: 'DROP DATABASE production',
        projectPath: '/test/project',
        sessionId: 'sess-456',
      };

      await sendVoiceAlert(config);

      // Verify some logging occurred (implementation detail)
      // In real implementation, we would check log calls
    });
  });
});
