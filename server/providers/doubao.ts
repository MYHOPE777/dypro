import type { ComplianceAnalyzer, AnalysisInput } from '../../src/compliance/engine';
import { analyzeTranscript } from '../../src/compliance/engine';
import type { ComplianceResult, KnowledgeEvidence } from '../../src/shared/types';
import { createKnowledgeBase, type ComplianceKnowledgeBase } from '../knowledgeBase';

type DoubaoConfig = { apiKey: string; endpointId: string; baseUrl: string; timeoutMs: number };
const severity = { safe: 0, warning: 1, blocked: 2 } as const;

function getConfig(env: NodeJS.ProcessEnv = process.env): DoubaoConfig | null {
  if (!env.DOUBAO_API_KEY || !env.DOUBAO_ENDPOINT_ID) return null;
  return {
    apiKey: env.DOUBAO_API_KEY,
    endpointId: env.DOUBAO_ENDPOINT_ID,
    baseUrl: env.DOUBAO_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    timeoutMs: Number.isFinite(Number(env.DOUBAO_TIMEOUT_MS)) && Number(env.DOUBAO_TIMEOUT_MS) > 0 ? Number(env.DOUBAO_TIMEOUT_MS) : 2_500,
  };
}

const SYSTEM_PROMPT = `你是抖音电商直播合规审核员。结合当前商品和主播原话，判断是否存在平台直播违规风险。
只输出 JSON，不要 Markdown：{"risk":"safe|warning|blocked","title":"短标题","reason":"具体原因","alternative":"主播可以立即照读的合规替代表达","policyRef":"规则类别","confidence":0到1}。
blocked 用于医疗功效、绝对化承诺、虚假或不可证明的结果保证；warning 用于极限词、紧迫性和需要核验的宣传；没有明显风险才用 safe。替代表达不能保留原违规承诺。`;

function parseJson(content: string): Record<string, unknown> {
  const normalized = content.replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim();
  const start = normalized.indexOf('{');
  const end = normalized.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('豆包返回内容不是 JSON');
  return JSON.parse(normalized.slice(start, end + 1)) as Record<string, unknown>;
}

function fromDoubao(input: AnalysisInput, payload: Record<string, unknown>, knowledgeEvidence: KnowledgeEvidence[]): ComplianceResult {
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
    ...(knowledgeEvidence.length > 0 ? { knowledgeEvidence } : {}),
  };
}

export class DoubaoComplianceAnalyzer implements ComplianceAnalyzer {
  private readonly config: DoubaoConfig | null;
  private readonly knowledgeBase: ComplianceKnowledgeBase;

  constructor(env: NodeJS.ProcessEnv = process.env, knowledgeBase: ComplianceKnowledgeBase = createKnowledgeBase(env)) {
    this.config = getConfig(env);
    this.knowledgeBase = knowledgeBase;
  }

  async analyze(input: AnalysisInput): Promise<ComplianceResult> {
    const localResult = await analyzeTranscript(input);
    if (!this.config) return localResult;
    try {
      const knowledgeEvidence = await this.knowledgeBase.retrieve({
        roomId: input.roomId ?? 'room-default',
        transcript: input.transcript,
        product: input.product ?? { id: input.productId, name: input.productId, category: '其他', price: '价格待确认', compliantPhrases: [] },
        activeRules: input.customRules ?? [],
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      let body: { choices?: Array<{ message?: { content?: string } }> };
      try {
        const response = await fetch(this.config.baseUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.endpointId,
            temperature: 0.1,
            max_tokens: 500,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: `当前商品：${JSON.stringify(input.product ?? { id: input.productId })}\n主播原话：${input.transcript}\n\n方舟知识库召回证据（仅作核验参考，规则库事实优先）：${JSON.stringify(knowledgeEvidence)}` },
            ],
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`豆包接口返回 ${response.status}`);
        body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      } finally {
        clearTimeout(timer);
      }
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error('豆包返回为空');
      const doubaoResult = fromDoubao(input, parseJson(content), knowledgeEvidence);
      return severity[doubaoResult.risk] >= severity[localResult.risk] ? doubaoResult : localResult;
    } catch (error) {
      return {
        ...localResult,
        reason: `${localResult.reason} 豆包暂时不可用，已切换本地规则兜底。`,
      };
    }
  }
}
