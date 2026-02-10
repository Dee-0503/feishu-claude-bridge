/**
 * 命令解释服务
 * 调用 AI 模型为敏感命令生成解释：每个授权选项的含义、风险、是否可逆
 *
 * 采用 Phase 1 的动态模型选择策略，优先选性价比模型
 */

import Anthropic from '@anthropic-ai/sdk';
import { log } from '../utils/log.js';

let client: Anthropic | null = null;

/** 缓存的最优模型名 */
let cachedModel: string | null = null;
let cacheExpiry = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 小时

/**
 * 命令解释需要一定推理能力，优先选中等模型
 * 太便宜的（如 gemini-flash）可能理解不了复杂命令的风险
 */
const PREFERRED_MODELS = [
  'claude-sonnet',             // 推理能力好，性价比不错
  'gpt-4o',                    // 能力强
  'claude-haiku',              // 质量可接受
  'gemini-2.5-flash',          // 备选
];

/** 解释任务允许的 model_ratio 上限，比摘要任务宽松 */
const MAX_RATIO = 5;

interface PricingEntry {
  model_name: string;
  model_ratio: number;
  completion_ratio: number;
  supported_endpoint_types: string[];
}

/** 每个授权选项的解释 */
export interface OptionExplanation {
  /** 原始选项文本 */
  option: string;
  /** 点击后会发生什么 */
  action: string;
  /** 风险和后果 */
  risk: string;
  /** 是否可逆/可弥补 */
  reversibility: string;
}

/** 整个命令的解释结果 */
export interface CommandExplanation {
  /** 命令的一句话中文解释 */
  summary: string;
  /** 每个授权选项的详细解释 */
  options: OptionExplanation[];
}

function getClient(): Anthropic | null {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });
  }
  return client;
}

async function selectBestModel(): Promise<string> {
  const fallback = 'claude-sonnet-4-5-20250929';

  if (process.env.EXPLAIN_MODEL) {
    return process.env.EXPLAIN_MODEL;
  }

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
      log('error', 'pricing_api_failed', { status: response.status });
      return fallback;
    }

    const data = await response.json() as { data?: PricingEntry[] };
    const models = data.data || data as unknown as PricingEntry[];

    if (!Array.isArray(models) || models.length === 0) {
      return fallback;
    }

    const candidates = models.filter(m =>
      m.supported_endpoint_types?.includes('anthropic') &&
      m.model_ratio <= MAX_RATIO &&
      m.model_ratio > 0
    );

    if (candidates.length === 0) {
      const allAnthropicModels = models.filter(m =>
        m.supported_endpoint_types?.includes('anthropic')
      );
      allAnthropicModels.sort((a, b) => a.model_ratio - b.model_ratio);
      if (allAnthropicModels.length > 0) {
        cachedModel = allAnthropicModels[0].model_name;
        cacheExpiry = Date.now() + CACHE_TTL;
        log('info', 'explain_model_selected', { model: cachedModel, reason: 'cheapest_available' });
        return cachedModel;
      }
      return fallback;
    }

    // 优先匹配偏好列表
    for (const keyword of PREFERRED_MODELS) {
      const match = candidates.find(m => m.model_name.includes(keyword));
      if (match) {
        cachedModel = match.model_name;
        cacheExpiry = Date.now() + CACHE_TTL;
        log('info', 'explain_model_selected', { model: cachedModel, ratio: match.model_ratio, reason: 'preferred' });
        return cachedModel;
      }
    }

    // 没有匹配偏好，选 ratio 最低的
    candidates.sort((a, b) => a.model_ratio - b.model_ratio);
    cachedModel = candidates[0].model_name;
    cacheExpiry = Date.now() + CACHE_TTL;
    log('info', 'explain_model_selected', { model: cachedModel, ratio: candidates[0].model_ratio, reason: 'cheapest' });
    return cachedModel;
  } catch (error) {
    log('warn', 'pricing_fetch_failed', { error: String(error) });
    return fallback;
  }
}

/**
 * 构建命令解释的 prompt
 */
export function buildExplainPrompt(
  tool: string,
  command: string,
  options: string[],
  cwd?: string,
): string {
  const optionList = options.map((opt, i) => `${i + 1}. "${opt}"`).join('\n');

  return `你是一位资深 DevOps 工程师，正在帮助一位不太熟悉命令行的项目负责人理解 Claude Code 即将执行的操作。

Claude Code 正在请求授权执行以下操作：
- 工具类型: ${tool}
- 命令: ${command}
${cwd ? `- 工作目录: ${cwd}` : ''}
- 授权选项:
${optionList}

请用简洁中文输出以下 JSON（不要代码块标记，直接输出 JSON）：

{
  "summary": "一句话解释这个命令要做什么（30字以内）",
  "options": [
    {
      "option": "原始选项文本",
      "action": "点击后会发生什么（20字以内）",
      "risk": "风险和后果（25字以内，无风险写'无'）",
      "reversibility": "可逆性：是否能弥补（15字以内）"
    }
  ]
}

要求：
- 每个选项都要解释，顺序与输入一致
- "risk"重点说明数据丢失、代码泄漏、破坏性操作等具体风险
- "reversibility"说明能否通过 git revert/reflog 等方式恢复
- 语言简明扼要，像给领导的备注
- 直接输出 JSON，不要任何前缀后缀`;
}

/**
 * 生成命令解释
 * @returns 解释结果，失败时返回 null
 */
export async function generateCommandExplanation(
  tool: string,
  command: string,
  options: string[],
  cwd?: string,
): Promise<CommandExplanation | null> {
  const anthropic = getClient();

  if (!anthropic) {
    log('warn', 'explain_skipped_no_api_key', {});
    return null;
  }

  if (!options || options.length === 0) {
    return null;
  }

  const model = await selectBestModel();
  const prompt = buildExplainPrompt(tool, command, options, cwd);

  try {
    log('info', 'explain_generating', { model, tool, command: command.substring(0, 80) });

    const response = await anthropic.messages.create({
      model,
      max_tokens: 500,
      messages: [
        { role: 'user', content: prompt },
      ],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      log('warn', 'explain_no_text_response', {});
      return null;
    }

    const text = content.text.trim();

    // 尝试解析 JSON（模型可能返回 ```json ... ```）
    const jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');

    try {
      const parsed = JSON.parse(jsonStr) as CommandExplanation;

      // 校验基本结构
      if (!parsed.summary || !Array.isArray(parsed.options)) {
        log('warn', 'explain_invalid_structure', { text: text.substring(0, 200) });
        return null;
      }

      log('info', 'explain_generated', { model, summary: parsed.summary });
      return parsed;
    } catch (parseError) {
      log('warn', 'explain_json_parse_failed', { text: text.substring(0, 200), error: String(parseError) });
      return null;
    }
  } catch (error) {
    log('error', 'explain_generation_failed', { model, error: String(error) });
    return null;
  }
}
