/**
 * 测试发送消息到飞书群
 */
import 'dotenv/config';
import { sendTextMessage, sendCardMessage } from '../feishu/message.js';

async function main() {
  console.log('🧪 测试飞书消息发送...\n');

  // 测试 1: 发送文本消息
  console.log('1. 发送文本消息...');
  try {
    await sendTextMessage('🎉 Feishu Claude Bridge 测试成功！这是一条来自 Claude Code 的测试消息。');
    console.log('   ✅ 文本消息发送成功\n');
  } catch (error) {
    console.error('   ❌ 文本消息发送失败:', error);
  }

  // 测试 2: 发送任务完成卡片
  console.log('2. 发送任务完成卡片...');
  try {
    await sendCardMessage({
      type: 'task_complete',
      title: '✅ Claude Code 任务完成',
      content: '已完成代码审查，发现 3 个优化建议。',
      sessionId: 'test-session-001',
    });
    console.log('   ✅ 任务完成卡片发送成功\n');
  } catch (error) {
    console.error('   ❌ 任务完成卡片发送失败:', error);
  }

  // 测试 3: 发送授权请求卡片（带按钮）
  console.log('3. 发送授权请求卡片...');
  try {
    await sendCardMessage({
      type: 'authorization_required',
      title: '⚠️ Claude 需要授权',
      content: '即将执行敏感操作，请确认：',
      command: 'git push origin main',
      sessionId: 'test-session-002',
      options: ['允许', '仅本次', '拒绝'],
    });
    console.log('   ✅ 授权请求卡片发送成功\n');
  } catch (error) {
    console.error('   ❌ 授权请求卡片发送失败:', error);
  }

  console.log('🎉 测试完成！请检查飞书群是否收到消息。');
}

main().catch(console.error);
