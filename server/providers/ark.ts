export type ArkConfig = {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  serviceTier: 'auto' | 'fast';
  knowledgeResourceId?: string;
};

export type ArkKnowledgeSearchStatus = {
  configured: boolean;
  available: boolean;
  label: string;
  detail: string;
  lastError?: string;
};

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
let knowledgeSearchLastError: string | undefined;
let knowledgeSearchLastSuccessAt: number | undefined;

function positiveTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function serviceTier(value: string | undefined): ArkConfig['serviceTier'] {
  return value?.trim().toLowerCase() === 'fast' ? 'fast' : 'auto';
}

export function getArkConfig(
  env: NodeJS.ProcessEnv = process.env,
  timeoutVariable = 'ARK_TIMEOUT_MS',
  fallbackTimeoutMs = 5_000,
): ArkConfig | null {
  const apiKey = env.ARK_API_KEY?.trim();
  const model = env.ARK_MODEL?.trim();
  if (!apiKey || !model) return null;
  const baseUrl = (env.ARK_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/u, '');
  const knowledgeResourceId = env.KNOWLEDGE_RESOURCE_ID?.trim() || undefined;
  return {
    apiKey,
    model,
    baseUrl,
    timeoutMs: positiveTimeout(env[timeoutVariable], fallbackTimeoutMs),
    serviceTier: serviceTier(env.ARK_SERVICE_TIER),
    knowledgeResourceId,
  };
}

export function getArkKnowledgeSearchStatus(env: NodeJS.ProcessEnv = process.env): ArkKnowledgeSearchStatus {
  const configured = Boolean(env.ARK_API_KEY?.trim() && env.ARK_MODEL?.trim() && env.KNOWLEDGE_RESOURCE_ID?.trim());
  const available = !configured || !knowledgeSearchLastError;
  return {
    configured,
    available,
    label: !configured ? '方舟私域知识库搜索未配置' : available ? '方舟私域知识库搜索已配置' : '方舟私域知识库搜索异常，已降级',
    detail: !configured
      ? '可选增强能力；本地规则和豆包合规判断不受影响。'
      : knowledgeSearchLastError
        ? `最近失败：${knowledgeSearchLastError}`
        : knowledgeSearchLastSuccessAt
          ? `最近调用成功 ${new Date(knowledgeSearchLastSuccessAt).toLocaleString('zh-CN', { hour12: false })}`
          : '通过 Responses API 的 knowledge_search 工具调用旗舰版知识库，首句时验证。',
    ...(configured && knowledgeSearchLastError ? { lastError: knowledgeSearchLastError } : {}),
  };
}

export function buildArkRequest(
  config: ArkConfig,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  useKnowledgeSearch = false,
): RequestInit {
  const knowledgeSearchEnabled = useKnowledgeSearch && Boolean(config.knowledgeResourceId);
  // 火山方舟在线推理（低延迟）的 Responses API 不支持 knowledge_search；保留知识库时回到 auto，避免整条语义链路失败。
  const requestServiceTier = knowledgeSearchEnabled ? 'auto' : config.serviceTier;
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    ...(knowledgeSearchEnabled ? { 'ark-beta-knowledge-search': 'true' } : {}),
  };
  return {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      service_tier: requestServiceTier,
      store: false,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
        { role: 'user', content: [{ type: 'input_text', text: userPrompt }] },
      ],
      thinking: { type: knowledgeSearchEnabled ? 'auto' : 'disabled' },
      text: { format: { type: 'json_object' } },
      max_output_tokens: maxTokens,
      ...(knowledgeSearchEnabled ? {
        tools: [{
          type: 'knowledge_search',
          knowledge_resource_id: config.knowledgeResourceId,
          limit: 10,
        }],
      } : {}),
    }),
  };
}

function errorCode(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function outputText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const value = body as {
    output_text?: unknown;
    output?: Array<{ type?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }>;
  };
  if (typeof value.output_text === 'string' && value.output_text.trim()) return value.output_text.trim();
  const responseParts = value.output?.flatMap((item) => item.content ?? []) ?? [];
  return responseParts
    .filter((item) => item.type === 'output_text' || item.type === 'text')
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .join('')
    .trim();
}

export async function requestArk(
  config: ArkConfig,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  useKnowledgeSearch = false,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const knowledgeSearchEnabled = useKnowledgeSearch && Boolean(config.knowledgeResourceId);
  try {
    const response = await fetch(`${config.baseUrl}/responses`, { ...buildArkRequest(config, systemPrompt, userPrompt, maxTokens, useKnowledgeSearch), signal: controller.signal });
    const raw = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const code = errorCode(body);
      const requestId = response.headers.get('x-request-id') || response.headers.get('x-client-request-id');
      if (config.serviceTier === 'fast' && (code === 'ModelNotOpen' || code === 'AccessDenied')) {
        // Fast 需要单独开通且只支持指定模型；不可用时按官方降级语义重试常规在线推理。
        return requestArk({ ...config, serviceTier: 'auto' }, systemPrompt, userPrompt, maxTokens, useKnowledgeSearch);
      }
      throw new Error(`火山方舟 Responses API 返回 ${response.status}${code ? ` (${code})` : ''}${requestId ? `（Request ID ${requestId}）` : ''}`);
    }
    const content = outputText(body);
    if (!content) throw new Error('火山方舟 Responses API 返回为空');
    if (knowledgeSearchEnabled) {
      knowledgeSearchLastError = undefined;
      knowledgeSearchLastSuccessAt = Date.now();
    }
    return content;
  } catch (error) {
    if (knowledgeSearchEnabled) knowledgeSearchLastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_ARK_BASE_URL = DEFAULT_BASE_URL;
