import { describe, it, expect } from 'vitest';
import { AUTH_OPTION_MAP, getChineseAuthOption } from '../types/summary.js';

describe('summary types', () => {
  describe('AUTH_OPTION_MAP', () => {
    it('should have mappings for common options', () => {
      expect(AUTH_OPTION_MAP['yes']).toBe('允许');
      expect(AUTH_OPTION_MAP['no']).toBe('拒绝');
      expect(AUTH_OPTION_MAP['yes, always']).toBe('始终允许');
      expect(AUTH_OPTION_MAP["yes, don't ask again for this project"]).toBe('本项目始终允许');
      expect(AUTH_OPTION_MAP['allow']).toBe('允许');
      expect(AUTH_OPTION_MAP['deny']).toBe('拒绝');
    });
  });

  describe('getChineseAuthOption', () => {
    it('should return Chinese translation for known options', () => {
      expect(getChineseAuthOption('Yes')).toBe('允许');
      expect(getChineseAuthOption('No')).toBe('拒绝');
      expect(getChineseAuthOption('YES, ALWAYS')).toBe('始终允许');
    });

    it('should return original option for unknown options', () => {
      expect(getChineseAuthOption('Some Custom Option')).toBe('Some Custom Option');
    });

    it('should handle whitespace', () => {
      expect(getChineseAuthOption('  yes  ')).toBe('允许');
    });
  });
});
