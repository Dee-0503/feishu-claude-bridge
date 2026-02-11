import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { alertScheduler, isWorkingHours } from '../services/voice-alert.js';

describe('voice-alert', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    alertScheduler.clearAll();
  });

  describe('isWorkingHours', () => {
    it('should return true during working hours (weekday 10:00)', () => {
      // 2026-02-11 (周三) 10:00 CST
      vi.setSystemTime(new Date('2026-02-11T10:00:00+08:00'));

      const result = isWorkingHours({
        enabled: true,
        timezone: 'Asia/Shanghai',
        weekdays: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 18,
      });

      expect(result).toBe(true);
    });

    it('should return false outside working hours (weekday 20:00)', () => {
      // 2026-02-11 (周三) 20:00 CST
      vi.setSystemTime(new Date('2026-02-11T20:00:00+08:00'));

      const result = isWorkingHours({
        enabled: true,
        timezone: 'Asia/Shanghai',
        weekdays: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 18,
      });

      expect(result).toBe(false);
    });

    it('should return false on weekend (Saturday)', () => {
      // 2026-02-14 (周六) 10:00 CST
      vi.setSystemTime(new Date('2026-02-14T10:00:00+08:00'));

      const result = isWorkingHours({
        enabled: true,
        timezone: 'Asia/Shanghai',
        weekdays: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 18,
      });

      expect(result).toBe(false);
    });

    it('should return true when working hours check is disabled', () => {
      // 2026-02-14 (周六) 20:00 CST - 非工作时间
      vi.setSystemTime(new Date('2026-02-14T20:00:00+08:00'));

      const result = isWorkingHours({
        enabled: false, // 禁用检查
        timezone: 'Asia/Shanghai',
        weekdays: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 18,
      });

      expect(result).toBe(true);
    });

    it('should handle different timezones (UTC)', () => {
      // 2026-02-11 10:00 UTC = 18:00 CST (工作时间结束)
      vi.setSystemTime(new Date('2026-02-11T10:00:00Z'));

      const result = isWorkingHours({
        enabled: true,
        timezone: 'UTC',
        weekdays: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 18,
      });

      expect(result).toBe(true); // UTC 10:00 在 9-18 范围内
    });
  });

  describe('AlertScheduler', () => {
    it('should schedule an alert and track pending count', () => {
      // 设置工作时间
      vi.setSystemTime(new Date('2026-02-11T10:00:00+08:00'));

      alertScheduler.scheduleAlert('msg_123', {
        chatId: 'chat_123',
        sessionId: 'sess_123',
        type: 'authorization',
        delayMinutes: 5,
      });

      // 检查提醒已安排
      expect(alertScheduler.getPendingCount()).toBe(1);

      // Note: 实际发送需要真实飞书环境，此处仅测试调度逻辑
    });

    it('should cancel alert when user responds', () => {
      vi.setSystemTime(new Date('2026-02-11T10:00:00+08:00'));

      alertScheduler.scheduleAlert('msg_123', {
        chatId: 'chat_123',
        sessionId: 'sess_123',
        type: 'authorization',
        delayMinutes: 5,
      });

      expect(alertScheduler.getPendingCount()).toBe(1);

      // 用户在 2 分钟后响应
      vi.advanceTimersByTime(2 * 60 * 1000);
      alertScheduler.cancelAlert('msg_123');

      expect(alertScheduler.getPendingCount()).toBe(0);

      // 再快进 5 分钟，不应触发
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(alertScheduler.getPendingCount()).toBe(0);
    });

    it('should not schedule alert outside working hours', () => {
      // 周六晚上
      vi.setSystemTime(new Date('2026-02-14T20:00:00+08:00'));

      alertScheduler.scheduleAlert('msg_123', {
        chatId: 'chat_123',
        sessionId: 'sess_123',
        type: 'authorization',
        delayMinutes: 5,
      });

      // 不应创建提醒
      expect(alertScheduler.getPendingCount()).toBe(0);
    });

    it('should clear all pending alerts on clearAll()', () => {
      vi.setSystemTime(new Date('2026-02-11T10:00:00+08:00'));

      alertScheduler.scheduleAlert('msg_1', {
        chatId: 'chat_1',
        sessionId: 'sess_1',
        type: 'authorization',
        delayMinutes: 5,
      });

      alertScheduler.scheduleAlert('msg_2', {
        chatId: 'chat_2',
        sessionId: 'sess_2',
        type: 'task_complete',
        delayMinutes: 10,
      });

      expect(alertScheduler.getPendingCount()).toBe(2);

      alertScheduler.clearAll();

      expect(alertScheduler.getPendingCount()).toBe(0);
    });

    it('should replace existing alert with same messageId', () => {
      vi.setSystemTime(new Date('2026-02-11T10:00:00+08:00'));

      alertScheduler.scheduleAlert('msg_123', {
        chatId: 'chat_123',
        sessionId: 'sess_123',
        type: 'authorization',
        delayMinutes: 5,
      });

      expect(alertScheduler.getPendingCount()).toBe(1);

      // 重新安排相同 messageId 的提醒
      alertScheduler.scheduleAlert('msg_123', {
        chatId: 'chat_123',
        sessionId: 'sess_123',
        type: 'authorization',
        delayMinutes: 10, // 延迟时间变化
      });

      // 仍然只有 1 个提醒
      expect(alertScheduler.getPendingCount()).toBe(1);
    });
  });

  describe('Environment variable integration', () => {
    it('should use default working hours from env vars', () => {
      // 模拟环境变量
      vi.stubEnv('VOICE_ALERT_WORKING_HOURS_ENABLED', 'true');
      vi.stubEnv('VOICE_ALERT_TIMEZONE', 'Asia/Shanghai');
      vi.stubEnv('VOICE_ALERT_WEEKDAYS', '1,2,3,4,5');
      vi.stubEnv('VOICE_ALERT_START_HOUR', '9');
      vi.stubEnv('VOICE_ALERT_END_HOUR', '18');

      vi.setSystemTime(new Date('2026-02-11T10:00:00+08:00'));

      const result = isWorkingHours(); // 使用默认配置
      expect(result).toBe(true);
    });

    it('should disable working hours check when env var is false', () => {
      vi.stubEnv('VOICE_ALERT_WORKING_HOURS_ENABLED', 'false');

      // 周六晚上
      vi.setSystemTime(new Date('2026-02-14T20:00:00+08:00'));

      const result = isWorkingHours();
      expect(result).toBe(true); // 禁用后总是返回 true
    });
  });
});
