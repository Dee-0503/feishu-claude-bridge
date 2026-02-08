/**
 * 摘要服务
 * 动态选择最优性价比模型生成任务摘要
 */

import Anthropic from '@anthropic-ai/sdk';
import type { RawSummary } from '../types/summary.js';

let client: Anthropic | null = null;

/** 缓存的最优模型名，避免每次都请求定价 */
let cachedModel: string | null = null;
let cacheExpiry = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 小时

/** 摘要任务偏好的模型关键词，按优先级排序（便宜且够用） */
const PREFERRED_MODELS = [
  'gemini-2.5-flash',       // 极便宜
  'claude-haiku',           // 质量好性价比高
  'gemini-3-flash',         // flash 系列
  'gpt-4o-mini',            // 便宜
];

/** model_ratio 上限，超过的不考虑 */
const MAX_RATIO = 2;

interface PricingEntry {
  model_name: string;
  model_ratio: number;
  completion_ratio: number;
  supported_endpoint_types: string[];
}

/**
 * 获取 Anthropic 客户端（懒加载）
 */
function getClient(): Anthropic | null {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });
  }
  return client;
}

/**
 * 从定价 API 动态选择最优模型
 */
async function selectBestModel(): Promise<string> {
  const fallback = 'claude-haiku-4-5-20251001';

  // 如果手动指定了模型，直接用
  if (process.env.SUMMARY_MODEL) {
    return process.env.SUMMARY_MODEL;
  }

  // 检查缓存
  if (cachedModel && Date.now() < cacheExpiry) {
    return cachedModel;
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!baseUrl) {
    return fallback;
  }

  try {
    const pricingUrl = new URL('/api/pricing', baseUrl).toString();
    const response = await fetch(pricingUrl, { signal: AbortSignal.timeout(5000) });

    if (!response.ok) {
      console.error(`❌ Pricing API returned ${response.status}`);
      return fallback;
    }

    const data = await response.json() as { data?: PricingEntry[] };
    const models = data.data || data as unknown as PricingEntry[];

    if (!Array.isArray(models) || models.length === 0) {
      return fallback;
    }

    // 过滤：支持 anthropic 端点 + ratio 在预算内
    const candidates = models.filter(m =>
      m.supported_endpoint_types?.includes('anthropic') &&
      m.model_ratio <= MAX_RATIO &&
      m.model_ratio > 0
    );

    if (candidates.length === 0) {
      // 放宽条件，只看 ratio
      const allAnthropicModels = models.filter(m =>
        m.supported_endpoint_types?.includes('anthropic')
      );
      allAnthropicModels.sort((a, b) => a.model_ratio - b.model_ratio);
      if (allAnthropicModels.length > 0) {
        cachedModel = allAnthropicModels[0].model_name;
        cacheExpiry = Date.now() + CACHE_TTL;
        console.log(`📊 Selected model (cheapest available): ${cachedModel} (ratio: ${allAnthropicModels[0].model_ratio})`);
        return cachedModel;
      }
      return fallback;
    }

    // 优先匹配偏好列表
    for (const keyword of PREFERRED_MODELS) {
      const match = candidates.find(m =>
        m.model_name.includes(keyword)
      );
      if (match) {
        cachedModel = match.model_name;
        cacheExpiry = Date.now() + CACHE_TTL;
        console.log(`📊 Selected model (preferred): ${cachedModel} (ratio: ${match.model_ratio})`);
        return cachedModel;
      }
    }

    // 没有匹配偏好，选 ratio 最低的
    candidates.sort((a, b) => a.model_ratio - b.model_ratio);
    cachedModel = candidates[0].model_name;
    cacheExpiry = Date.now() + CACHE_TTL;
    console.log(`📊 Selected model (cheapest): ${cachedModel} (ratio: ${candidates[0].model_ratio})`);
    return cachedModel;
  } catch (error) {
    console.error('⚠️ Failed to fetch pricing, using fallback model:', error);
    return fallback;
  }
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

  return `你是工程师，向项目负责人做任务速报。根据以下信息生成一句话中文摘要（不超过50字）：

任务描述：${taskDescription.substring(0, 200)}
完成状态：${completionMessage.substring(0, 300)}
操作统计：${stats || '无操作记录'}
修改文件：${files || '无'}
耗时：${duration}秒

要求：
- 说清楚「做了什么」和「结果如何」，让负责人一眼知道进展
- 用动词开头（完成、修复、新增、重构、优化……）
- 如有异常或未完成部分，必须提及
- 不要包含项目名、路径或技术细节
- 直接输出摘要，不要任何前缀或解释`;
}

/**
 * 生成任务摘要
 * @returns 摘要文本，失败时返回空字符串
 */
export async function generateTaskSummary(summary: RawSummary): Promise<string> {
  const anthropic = getClient();

  if (!anthropic) {
    console.log('⚠️ ANTHROPIC_API_KEY not configured, skipping summary');
    return '';
  }

  const model = await selectBestModel();
  const prompt = buildSummaryPrompt(summary);

  try {
    console.log(`🤖 Generating summary with model: ${model}`);
    const response = await anthropic.messages.create({
      model,
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
      console.log(`✅ Summary generated (${model}): ${result}`);
      return result;
    }

    return '';
  } catch (error) {
    console.error(`❌ Summary generation failed (${model}):`, error);
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
