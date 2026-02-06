/**
 * Haiku 摘要服务
 * 使用 Claude Haiku 生成精炼的任务摘要
 */

import Anthropic from '@anthropic-ai/sdk';
import type { RawSummary } from '../types/summary.js';

let client: Anthropic | null = null;

/**
 * 获取 Anthropic 客户端（懒加载）
 */
function getClient(): Anthropic | null {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return client;
}

/**
 * 构建摘要生成的 prompt
 */
function buildSummaryPrompt(summary: RawSummary): string {
  const {
    taskDescription,
    completionMessage,
    toolStats,
    filesModified,
    filesCreated,
    duration
  } = summary;

  const files = [...filesModified, ...filesCreated]
    .map(f => f.split('/').pop())
    .slice(0, 5)
    .join(', ');

  const stats = [
    toolStats.edit > 0 ? `编辑${toolStats.edit}文件` : null,
    toolStats.write > 0 ? `创建${toolStats.write}文件` : null,
    toolStats.bash > 0 ? `执行${toolStats.bash}命令` : null,
  ].filter(Boolean).join(', ');

  return `根据以下任务信息，生成一句话中文摘要（不超过50字）：

任务描述：${taskDescription.substring(0, 200)}
完成状态：${completionMessage.substring(0, 300)}
操作统计：${stats || '无操作记录'}
修改文件：${files || '无'}
耗时：${duration}秒

要求：
- 简洁、准确、突出关键结果
- 使用动词开头（如"完成了..."、"修复了..."、"添加了..."）
- 不要包含项目名或路径
- 直接输出摘要，不要任何解释`;
}

/**
 * 生成任务摘要
 * @returns 摘要文本，失败时返回空字符串
 */
export async function generateTaskSummary(summary: RawSummary): Promise<string> {
  const anthropic = getClient();

  if (!anthropic) {
    console.log('⚠️ ANTHROPIC_API_KEY not configured, skipping Haiku summary');
    return '';
  }

  const prompt = buildSummaryPrompt(summary);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const content = response.content[0];
    if (content.type === 'text') {
      const result = content.text.trim();
      console.log(`✅ Haiku summary generated: ${result}`);
      return result;
    }

    return '';
  } catch (error) {
    console.error('❌ Haiku summary generation failed:', error);
    return '';
  }
}

/**
 * 生成默认摘要（规则提取，无 LLM）
 */
export function generateDefaultSummary(summary: RawSummary): string {
  const { toolStats, filesModified, filesCreated } = summary;

  const actions: string[] = [];

  if (toolStats.edit > 0) {
    actions.push(`编辑了 ${toolStats.edit} 个文件`);
  }
  if (toolStats.write > 0) {
    actions.push(`创建了 ${toolStats.write} 个文件`);
  }
  if (toolStats.bash > 0) {
    actions.push(`执行了 ${toolStats.bash} 个命令`);
  }

  if (actions.length === 0) {
    return '任务已完成';
  }

  const files = [...filesModified, ...filesCreated].slice(0, 3);
  const fileNames = files.map(f => f.split('/').pop()).join('、');

  if (fileNames) {
    return `${actions[0]}（${fileNames}）`;
  }

  return actions.join('，');
}
