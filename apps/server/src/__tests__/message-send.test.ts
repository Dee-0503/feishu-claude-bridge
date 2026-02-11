import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track markChatInvalid calls
const mockMarkChatInvalid = vi.fn();

// Mock feishu client
const mockMessageCreate = vi.fn();
const mockMessagePatch = vi.fn();

vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    im: {
      message: {
        create: (...args: unknown[]) => mockMessageCreate(...args),
        reply: (...args: unknown[]) => mockMessageCreate(...args),
        patch: (...args: unknown[]) => mockMessagePatch(...args),
      },
    },
  },
}));

vi.mock('../feishu/group.js', () => ({
  markChatInvalid: (...args: unknown[]) => mockMarkChatInvalid(...args),
}));

vi.mock('../utils/log.js', () => ({
  log: vi.fn(),
}));

describe('sendCardMessage error handling', () => {
  let sendCardMessage: typeof import('../feishu/message.js').sendCardMessage;

  beforeEach(async () => {
    vi.resetModules();
    mockMessageCreate.mockReset();
    mockMessagePatch.mockReset();
    mockMarkChatInvalid.mockReset();

    const mod = await import('../feishu/message.js');
    sendCardMessage = mod.sendCardMessage;
  });

  it('should throw when API returns code 230005 (群已解散)', async () => {
    mockMessageCreate.mockResolvedValue({
      code: 230005,
      msg: 'chat is dissolved',
      data: {},
    });

    await expect(
      sendCardMessage({
        type: 'task_complete',
        title: '测试',
        chatId: 'oc_dead_chat',
      }),
    ).rejects.toThrow('Feishu API error 230005');
  });

  it('should throw when API returns code 230006 (receive_id 无效)', async () => {
    mockMessageCreate.mockResolvedValue({
      code: 230006,
      msg: 'receive_id is invalid',
      data: {},
    });

    await expect(
      sendCardMessage({
        type: 'task_complete',
        title: '测试',
        chatId: 'oc_invalid',
      }),
    ).rejects.toThrow('Feishu API error 230006');
  });

  it('should call markChatInvalid when group send fails with 230005', async () => {
    mockMessageCreate.mockResolvedValue({
      code: 230005,
      msg: 'chat is dissolved',
      data: {},
    });

    await expect(
      sendCardMessage({
        type: 'task_complete',
        title: '测试',
        chatId: 'oc_dead_chat',
      }),
    ).rejects.toThrow();

    expect(mockMarkChatInvalid).toHaveBeenCalledWith('oc_dead_chat');
  });

  it('should call markChatInvalid when SDK throws AxiosError (HTTP 400)', async () => {
    mockMessageCreate.mockRejectedValue(new Error('Request failed with status code 400'));

    await expect(
      sendCardMessage({
        type: 'task_complete',
        title: '测试',
        chatId: 'oc_fake_id',
      }),
    ).rejects.toThrow('Request failed with status code 400');

    expect(mockMarkChatInvalid).toHaveBeenCalledWith('oc_fake_id');
  });

  it('should NOT call markChatInvalid for non-group (open_id) sends', async () => {
    mockMessageCreate.mockResolvedValue({
      code: 99999,
      msg: 'some other error',
      data: {},
    });

    process.env.FEISHU_TARGET_TYPE = 'open_id';
    process.env.FEISHU_TARGET_ID = 'ou_user123';

    await expect(
      sendCardMessage({
        type: 'task_complete',
        title: '测试',
        // no chatId → uses open_id
      }),
    ).rejects.toThrow('Feishu API error 99999');

    expect(mockMarkChatInvalid).not.toHaveBeenCalled();

    delete process.env.FEISHU_TARGET_TYPE;
    delete process.env.FEISHU_TARGET_ID;
  });

  it('should succeed when API returns code 0', async () => {
    mockMessageCreate.mockResolvedValue({
      code: 0,
      msg: 'success',
      data: { message_id: 'msg-123' },
    });

    const result = await sendCardMessage({
      type: 'task_complete',
      title: '测试',
      chatId: 'oc_good_chat',
    });

    expect(result).toEqual({ messageId: 'msg-123', chatId: 'oc_good_chat' });
    expect(mockMarkChatInvalid).not.toHaveBeenCalled();
  });
});

describe('sendTextMessage error handling', () => {
  let sendTextMessage: typeof import('../feishu/message.js').sendTextMessage;

  beforeEach(async () => {
    vi.resetModules();
    mockMessageCreate.mockReset();
    mockMarkChatInvalid.mockReset();

    const mod = await import('../feishu/message.js');
    sendTextMessage = mod.sendTextMessage;
  });

  it('should call markChatInvalid when group text send fails', async () => {
    mockMessageCreate.mockResolvedValue({
      code: 230006,
      msg: 'receive_id is invalid',
      data: {},
    });

    await expect(
      sendTextMessage('hello', 'oc_bad_chat'),
    ).rejects.toThrow('Feishu API error 230006');

    expect(mockMarkChatInvalid).toHaveBeenCalledWith('oc_bad_chat');
  });
});

describe('updateCardMessage error handling', () => {
  let updateCardMessage: typeof import('../feishu/message.js').updateCardMessage;

  beforeEach(async () => {
    vi.resetModules();
    mockMessagePatch.mockReset();

    const mod = await import('../feishu/message.js');
    updateCardMessage = mod.updateCardMessage;
  });

  it('should throw when patch API returns non-zero code', async () => {
    mockMessagePatch.mockResolvedValue({
      code: 230005,
      msg: 'chat is dissolved',
    });

    await expect(
      updateCardMessage('msg-123', {
        type: 'task_complete',
        title: '测试',
      }),
    ).rejects.toThrow('Feishu API error 230005');
  });
});
