import type { ComplianceAnalyzer, AnalysisInput } from '../../src/compliance/engine';
import { analyzeTranscript } from '../../src/compliance/engine';
import type { ComplianceAnalysisTiming, ComplianceResult } from '../../src/shared/types';
import { getArkConfig, requestArk, type ArkConfig } from './ark';

const severity = { safe: 0, warning: 1, blocked: 2 } as const;

const SYSTEM_PROMPT = `你是抖音电商直播合规审核员。结合当前商品和主播原话判断平台直播违规风险。
只输出 JSON，不要 Markdown，字段顺序固定：{"risk":"safe|warning|blocked","title":"不超过12字","reason":"不超过45字的具体原因","alternative":"不超过60字、主播可立即照读且不保留违规承诺的替代表达","policyRef":"不超过20字的规则类别","confidence":0到1}。
blocked 用于医疗功效、绝对化承诺、虚假或不可证明的结果保证；warning 用于极限词、紧迫性和需要核验的宣传；没有明显风险才用 safe。`;

const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 128;

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function parseArkJson(content: string): Record<string, unknown> {
  const normalized = content.replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim();
  const start = normalized.indexOf('{');
  const end = normalized.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('豆包返回内容不是 JSON');
  return JSON.parse(normalized.slice(start, end + 1)) as Record<string, unknown>;
}

function fromDoubao(input: AnalysisInput, payload: Record<string, unknown>): ComplianceResult {
  const risk = payload.risk === 'blocked' || payload.risk === 'warning' ? payload.risk : 'safe';
  const text = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  const confidence = typeof payload.confidence === 'number' ? Math.max(0, Math.min(1, payload.confidence)) : 0.85;
  return {
    id: `doubao-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    productId: input.productId,
    risk,
    title: text(payload.title, risk === 'safe' ? '当前表达可继续' : '需要调整当前表达'),
    reason: text(payload.reason, '豆包未提供额外说明。'),
    alternative: text(payload.alternative, '可以改为：根据商品页面信息介绍材质、使用场景和活动规则。'),
    policyRef: text(payload.policyRef, '抖音电商直播合规规则'),
    confidence,
    source: 'doubao',
    transcript: input.transcript,
    createdAt: Date.now(),
  };
}

export class DoubaoComplianceAnalyzer implements ComplianceAnalyzer {
  private readonly config: ArkConfig | null;
  private readonly maxOutputTokens: number;
  private readonly localFastPath: boolean;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { expiresAt: number; result: ComplianceResult }>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.config = getArkConfig(env);
    const configuredMaxTokens = Number(env.ARK_COMPLIANCE_MAX_OUTPUT_TOKENS);
    this.maxOutputTokens = Number.isInteger(configuredMaxTokens) && configuredMaxTokens >= 160 && configuredMaxTokens <= 800 ? configuredMaxTokens : 200;
    this.localFastPath = env.ARK_LOCAL_FAST_PATH?.trim().toLowerCase() !== 'false';
    const configuredCacheTtl = Number(env.ARK_COMPLIANCE_CACHE_TTL_MS);
    this.cacheTtlMs = Number.isFinite(configuredCacheTtl) && configuredCacheTtl >= 0 ? configuredCacheTtl : DEFAULT_CACHE_TTL_MS;
  }

  async analyze(input: AnalysisInput): Promise<ComplianceResult> {
    const analyzerStartedAt = performance.now();
    const localStartedAt = performance.now();
    const localResult = await analyzeTranscript(input);
    const localGuardrailMs = elapsedMs(localStartedAt);
    // High-confidence local blocks are already actionable; do not spend the realtime budget waiting for a second opinion.
    // Local warnings from the built-in or published room rules are also actionable and avoid a model round trip.
    if (!this.config || localResult.risk === 'blocked' || (this.localFastPath && localResult.risk === 'warning')) {
      const path: ComplianceAnalysisTiming['path'] = !this.config || localResult.risk === 'blocked' ? 'local' : 'fallback';
      return { ...localResult, analysisTiming: { path, analyzerMs: elapsedMs(analyzerStartedAt), localGuardrailMs } };
    }
    const cacheStartedAt = performance.now();
    const cacheKey = this.cacheKey(input);
    const cached = this.cache.get(cacheKey);
    const cacheLookupMs = elapsedMs(cacheStartedAt);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        ...structuredClone(cached.result),
        analysisTiming: {
          path: 'cache',
          analyzerMs: elapsedMs(analyzerStartedAt),
          localGuardrailMs,
          cacheLookupMs,
        },
      };
    }
    if (cached) this.cache.delete(cacheKey);
    const compactRules = input.customRules?.slice(0, 20).map((rule) => ({
      name: rule.name.slice(0, 40),
      pattern: rule.pattern.slice(0, 100),
      risk: rule.risk,
      reason: rule.reason.slice(0, 120),
      alternative: rule.alternative.slice(0, 160),
      policyRef: rule.policyRef.slice(0, 40),
    })) ?? [];
    const product = input.product
      ? {
        id: input.product.id,
        name: input.product.name,
        category: input.product.category,
        price: input.product.price,
        compliantPhrases: input.product.compliantPhrases.slice(0, 3).map((phrase) => phrase.slice(0, 80)),
      }
      : { id: input.productId };
    try {
      const arkStartedAt = performance.now();
      const content = await requestArk(
        this.config,
        SYSTEM_PROMPT,
        `当前商品：${JSON.stringify(product)}\n主播原话：${input.transcript}\n本直播间相关规则：${JSON.stringify(compactRules)}`,
        this.maxOutputTokens,
        true,
      );
      const arkRequestMs = elapsedMs(arkStartedAt);
      const responseParseStartedAt = performance.now();
      const doubaoResult = fromDoubao(input, parseArkJson(content));
      const responseParseMs = elapsedMs(responseParseStartedAt);
      const result = severity[doubaoResult.risk] >= severity[localResult.risk] ? doubaoResult : localResult;
      const analysisTiming: ComplianceAnalysisTiming = {
        path: 'ark',
        analyzerMs: elapsedMs(analyzerStartedAt),
        localGuardrailMs,
        cacheLookupMs,
        arkRequestMs,
        responseParseMs,
      };
      if (this.cacheTtlMs > 0) {
        if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(cacheKey, { expiresAt: Date.now() + this.cacheTtlMs, result: structuredClone({ ...result, analysisTiming }) });
      }
      return { ...result, analysisTiming };
    } catch (error) {
      return {
        ...localResult,
        reason: `${localResult.reason} 豆包暂时不可用，已切换本地规则兜底。`,
        analysisTiming: {
          path: 'fallback',
          analyzerMs: elapsedMs(analyzerStartedAt),
          localGuardrailMs,
          cacheLookupMs,
        },
      };
    }
  }

  private cacheKey(input: AnalysisInput): string {
    return JSON.stringify({
      roomId: input.roomId ?? '',
      productId: input.productId,
      transcript: input.transcript.trim(),
      rules: input.customRules?.map((rule) => `${rule.id}:${rule.version}:${rule.enabled}:${rule.status}`).join('|') ?? '',
    });
  }
}
