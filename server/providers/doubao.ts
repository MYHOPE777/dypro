import type { ComplianceAnalyzer, AnalysisInput } from '../../src/compliance/engine';
import { analyzeTranscript } from '../../src/compliance/engine';
import type { ComplianceResult } from '../../src/shared/types';
import { getArkConfig, requestArk, type ArkConfig } from './ark';

const severity = { safe: 0, warning: 1, blocked: 2 } as const;

const SYSTEM_PROMPT = `你是抖音电商直播合规审核员。结合当前商品和主播原话，判断是否存在平台直播违规风险。
只输出 JSON，不要 Markdown：{"risk":"safe|warning|blocked","title":"短标题","reason":"具体原因","alternative":"主播可以立即照读的合规替代表达","policyRef":"规则类别","confidence":0到1}。
blocked 用于医疗功效、绝对化承诺、虚假或不可证明的结果保证；warning 用于极限词、紧迫性和需要核验的宣传；没有明显风险才用 safe。替代表达不能保留原违规承诺。`;

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

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.config = getArkConfig(env);
    const configuredMaxTokens = Number(env.ARK_COMPLIANCE_MAX_OUTPUT_TOKENS);
    this.maxOutputTokens = Number.isInteger(configuredMaxTokens) && configuredMaxTokens >= 160 && configuredMaxTokens <= 800 ? configuredMaxTokens : 320;
  }

  async analyze(input: AnalysisInput): Promise<ComplianceResult> {
    const localResult = await analyzeTranscript(input);
    // High-confidence local blocks are already actionable; do not spend the realtime budget waiting for a second opinion.
    if (!this.config || localResult.risk === 'blocked') return localResult;
    const compactRules = input.customRules?.slice(0, 20).map((rule) => ({
      name: rule.name,
      pattern: rule.pattern,
      risk: rule.risk,
      reason: rule.reason,
      alternative: rule.alternative,
      policyRef: rule.policyRef,
    })) ?? [];
    try {
      const content = await requestArk(
        this.config,
        SYSTEM_PROMPT,
        `当前商品：${JSON.stringify(input.product ?? { id: input.productId })}\n主播原话：${input.transcript}\n本直播间相关规则：${JSON.stringify(compactRules)}`,
        this.maxOutputTokens,
        true,
      );
      const doubaoResult = fromDoubao(input, parseArkJson(content));
      return severity[doubaoResult.risk] >= severity[localResult.risk] ? doubaoResult : localResult;
    } catch (error) {
      return {
        ...localResult,
        reason: `${localResult.reason} 豆包暂时不可用，已切换本地规则兜底。`,
      };
    }
  }
}
