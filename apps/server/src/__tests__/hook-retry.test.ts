import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock sendCardMessage
const mockSendCardMessage = vi.fn();

vi.mock('../feishu/message.js', () => ({
  sendCardMessage: (...args: unknown[]) => mockSendCardMessage(...args),
}));

// Mock getOrCreateProjectGroup
const mockGetOrCreateProjectGroup = vi.fn();

vi.mock('../feishu/group.js', () => ({
  getOrCreateProjectGroup: (...args: unknown[]) => mockGetOrCreateProjectGroup(...args),
}));

vi.mock('../utils/log.js', () => ({
  log: vi.fn(),
}));

describe('sendWithRetry', () => {
  let sendWithRetry: typeof import('../routes/hook.js').sendWithRetry;

  beforeEach(async () => {
    vi.resetModules();
    mockSendCardMessage.mockReset();
    mockGetOrCreateProjectGroup.mockReset();

    const mod = await import('../routes/hook.js');
    sendWithRetry = mod.sendWithRetry;
  });

  it('should succeed on first attempt when send works', async () => {
    mockSendCardMessage.mockResolvedValue({ messageId: 'msg-1', chatId: 'oc_good' });

    const result = await sendWithRetry({
      type: 'task_complete',
      title: '测试',
      chatId: 'oc_good',
    }, '/projects/my-app');

    expect(result).toEqual({ messageId: 'msg-1', chatId: 'oc_good' });
    expect(mockSendCardMessage).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateProjectGroup).not.toHaveBeenCalled();
  });

  it('should recreate group and retry when group send fails', async () => {
    // First call fails (group dissolved)
    mockSendCardMessage
      .mockRejectedValueOnce(new Error('Feishu API error 230005: chat is dissolved'))
      .mockResolvedValueOnce({ messageId: 'msg-2', chatId: 'oc_new' });

    mockGetOrCreateProjectGroup.mockResolvedValue('oc_new');

    const result = await sendWithRetry({
      type: 'task_complete',
      title: '测试',
      chatId: 'oc_old_dead',
    }, '/projects/my-app');

    expect(result).toEqual({ messageId: 'msg-2', chatId: 'oc_new' });
    expect(mockSendCardMessage).toHaveBeenCalledTimes(2);
    expect(mockGetOrCreateProjectGroup).toHaveBeenCalledWith('/projects/my-app');

    // Second call should use the new chatId
    const secondCallArgs = mockSendCardMessage.mock.calls[1][0];
    expect(secondCallArgs.chatId).toBe('oc_new');
  });

  it('should throw when no projectRoot is provided (cannot retry)', async () => {
    mockSendCardMessage.mockRejectedValue(new Error('Feishu API error 230005'));

    await expect(
      sendWithRetry({
        type: 'task_complete',
        title: '测试',
        chatId: 'oc_dead',
      }), // no projectRoot
    ).rejects.toThrow('Feishu API error 230005');

    expect(mockGetOrCreateProjectGroup).not.toHaveBeenCalled();
  });

  it('should throw when no chatId in options (not a group send)', async () => {
    mockSendCardMessage.mockRejectedValue(new Error('some error'));

    await expect(
      sendWithRetry({
        type: 'task_complete',
        title: '测试',
        // no chatId
      }, '/projects/my-app'),
    ).rejects.toThrow('some error');

    expect(mockGetOrCreateProjectGroup).not.toHaveBeenCalled();
  });

  it('should throw if retry also fails', async () => {
    mockSendCardMessage
      .mockRejectedValueOnce(new Error('Feishu API error 230005'))
      .mockRejectedValueOnce(new Error('still failing'));

    mockGetOrCreateProjectGroup.mockResolvedValue('oc_new');

    await expect(
      sendWithRetry({
        type: 'task_complete',
        title: '测试',
        chatId: 'oc_dead',
      }, '/projects/my-app'),
    ).rejects.toThrow('still failing');
  });
});
