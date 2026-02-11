import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock feishu client
vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({
          code: 0,
          msg: 'success',
          data: { message_id: 'mock-msg-id' },
        }),
        patch: vi.fn().mockResolvedValue({
          code: 0,
          msg: 'success',
        }),
      },
    },
  },
}));

import { sendCardMessage, sendTextMessage, updateCardMessage } from '../feishu/message.js';
import { feishuClient } from '../feishu/client.js';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FEISHU_TARGET_TYPE = 'chat_id';
  process.env.FEISHU_TARGET_ID = 'default-chat-id';
});

describe('message.ts', () => {
  describe('sendTextMessage', () => {
    it('should send text to default target', async () => {
      await sendTextMessage('hello');

      expect(feishuClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'default-chat-id',
          msg_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
      });
    });

    it('should send text to specific chatId', async () => {
      await sendTextMessage('hello', 'specific-chat');

      expect(feishuClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'specific-chat',
          msg_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
      });
    });

    it('should not send if no target configured', async () => {
      delete process.env.FEISHU_TARGET_ID;
      await sendTextMessage('hello');
      expect(feishuClient.im.message.create).not.toHaveBeenCalled();
    });
  });

  describe('sendCardMessage', () => {
    it('should return messageId and chatId', async () => {
      const result = await sendCardMessage({
        type: 'task_complete',
        title: 'Test',
        content: 'Test content',
      });

      expect(result).not.toBeNull();
      expect(result!.messageId).toBe('mock-msg-id');
      expect(result!.chatId).toBe('default-chat-id');
    });

    it('should return null when no target configured', async () => {
      delete process.env.FEISHU_TARGET_ID;
      const result = await sendCardMessage({
        type: 'task_complete',
        title: 'Test',
      });
      expect(result).toBeNull();
    });

    it('should use chatId override', async () => {
      await sendCardMessage({
        type: 'task_started',
        title: 'Test',
        chatId: 'override-chat',
      });

      expect(feishuClient.im.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { receive_id_type: 'chat_id' },
          data: expect.objectContaining({
            receive_id: 'override-chat',
          }),
        }),
      );
    });

    it('should build task_started card with blue header', async () => {
      await sendCardMessage({
        type: 'task_started',
        title: '🚀 任务已开始',
        content: 'Fix CSS issue',
        sessionId: 'test-sess',
      });

      const call = (feishuClient.im.message.create as any).mock.calls[0][0];
      const card = JSON.parse(call.data.content);
      expect(card.header.template).toBe('blue');
      expect(card.header.title.content).toBe('🚀 任务已开始');
    });

    it('should build session_choice card with purple header and buttons', async () => {
      await sendCardMessage({
        type: 'session_choice',
        title: '📋 请选择目标会话',
        content: '你的消息: "fix bug"',
        sessionButtons: [
          { label: '✅ #a3f2 - 刚刚', value: JSON.stringify({ action: 'choose_session', sessionId: 'sess-1' }) },
          { label: '🆕 启动新实例', value: JSON.stringify({ action: 'new_session' }) },
        ],
      });

      const call = (feishuClient.im.message.create as any).mock.calls[0][0];
      const card = JSON.parse(call.data.content);
      expect(card.header.template).toBe('purple');

      // Find action element with buttons
      const actionElement = card.elements.find((e: any) => e.tag === 'action');
      expect(actionElement).toBeDefined();
      expect(actionElement.actions).toHaveLength(2);
      expect(actionElement.actions[0].text.content).toBe('✅ #a3f2 - 刚刚');
      expect(actionElement.actions[0].type).toBe('primary'); // first button
      expect(actionElement.actions[1].text.content).toBe('🆕 启动新实例');
    });

    it('should build task_complete card with green header', async () => {
      await sendCardMessage({
        type: 'task_complete',
        title: '✅ Claude Code 任务完成',
        content: 'Done',
        sessionId: 'sess-123',
      });

      const call = (feishuClient.im.message.create as any).mock.calls[0][0];
      const card = JSON.parse(call.data.content);
      expect(card.header.template).toBe('green');
    });

    it('should build authorization_required card with orange header and auth buttons', async () => {
      await sendCardMessage({
        type: 'authorization_required',
        title: '⚠️ Claude 需要授权',
        content: '工具: **Bash**',
        command: 'git push origin main',
        sessionId: 'sess-1',
        options: ['Yes', 'No'],
      });

      const call = (feishuClient.im.message.create as any).mock.calls[0][0];
      const card = JSON.parse(call.data.content);
      expect(card.header.template).toBe('orange');

      // Find action element
      const actionElement = card.elements.find((e: any) => e.tag === 'action');
      expect(actionElement).toBeDefined();
      expect(actionElement.actions).toHaveLength(2);

      // Yes button should be primary
      expect(actionElement.actions[0].type).toBe('primary');
      // No button should be danger
      expect(actionElement.actions[1].type).toBe('danger');
    });

    it('should include session note', async () => {
      await sendCardMessage({
        type: 'task_started',
        title: 'Test',
        sessionId: 'abcd1234-5678',
      });

      const call = (feishuClient.im.message.create as any).mock.calls[0][0];
      const card = JSON.parse(call.data.content);

      const noteElement = card.elements.find((e: any) => e.tag === 'note');
      expect(noteElement).toBeDefined();
      expect(noteElement.elements[0].content).toContain('#abcd');
    });

    it('should build rich card with summary data', async () => {
      await sendCardMessage({
        type: 'task_complete',
        title: '✅ Claude Code 任务完成',
        sessionId: 'sess-1',
        summary: {
          projectPath: '/project',
          projectName: 'test',
          gitBranch: 'main',
          sessionId: 'sess-1',
          sessionShortId: 'a3f2',
          taskDescription: 'Fix bug',
          completionMessage: 'Done',
          toolStats: { bash: 2, edit: 3, write: 1, read: 5, glob: 0, grep: 0, task: 0 },
          filesModified: ['src/app.ts', 'src/index.ts'],
          filesCreated: ['src/new.ts'],
          duration: 125,
          timestamp: new Date().toISOString(),
        },
        haikuSummary: '修复了主页 CSS 样式问题',
      });

      const call = (feishuClient.im.message.create as any).mock.calls[0][0];
      const card = JSON.parse(call.data.content);

      // Header should use branch info
      expect(card.header.title.content).toContain('[main]');
      expect(card.header.title.content).toContain('#a3f2');

      // Should have summary content
      const texts = card.elements
        .filter((e: any) => e.tag === 'div')
        .map((e: any) => e.text.content);

      expect(texts.some((t: string) => t.includes('修复了主页'))).toBe(true);
      expect(texts.some((t: string) => t.includes('编辑 3 文件'))).toBe(true);
      expect(texts.some((t: string) => t.includes('app.ts'))).toBe(true);
      expect(texts.some((t: string) => t.includes('2分5秒'))).toBe(true);
    });
  });

  describe('updateCardMessage', () => {
    it('should update an existing card', async () => {
      await updateCardMessage('msg-123', {
        type: 'task_complete',
        title: 'Updated',
        content: 'Updated content',
      });

      expect(feishuClient.im.message.patch).toHaveBeenCalledWith({
        path: { message_id: 'msg-123' },
        data: { content: expect.any(String) },
      });
    });
  });
});
