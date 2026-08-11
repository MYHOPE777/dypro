import type { ComplianceResult, RiskProfile } from '../../src/shared/types';

export type SemanticReviewReason = 'strict' | 'semantic_trigger' | 'local_warning' | 'sample' | 'local_only' | 'local_blocked';

export type SemanticReviewDecision = {
  shouldReview: boolean;
  reason: SemanticReviewReason;
  sampleNumber: number;
};

export type SemanticReviewPolicyInput = {
  roomId?: string;
  productId: string;
  productCategory?: string;
  transcript: string;
  contextText?: string;
  riskProfile?: RiskProfile;
  localResult: ComplianceResult;
  speakerId?: string;
  localFastPath?: boolean;
};

const SEMANTIC_TRIGGER = /暗示|影射|相当于|就像|好比|发动机|汽油|血液|心脏|疏通|排毒|修复|替代药|不用吃药|不能明说|懂的都懂|那个部位|指标恢复|循环起来|从根上|彻底解决/iu;
const HIGH_RISK_CATEGORY = /保健|医疗|药|食品|减肥|美容|护肤|健康/iu;

/**
 * Owns only the decision to spend a model request. It does not interpret a result,
 * which keeps cost policy independent from the analyzer adapter.
 */
export class SemanticReviewPolicy {
  private readonly sampleCounts = new Map<string, number>();

  decide(input: SemanticReviewPolicyInput): SemanticReviewDecision {
    if (input.localResult.risk === 'blocked') return { shouldReview: false, reason: 'local_blocked', sampleNumber: 0 };
    // Keep ordinary, high-confidence local warnings on the fast path unless the
    // caller explicitly asks for strict review. Older callers do not pass a
    // risk profile, so treating every warning as strict would turn a local
    // reminder into an unnecessary remote request.
    if (!input.riskProfile) {
      if (input.localFastPath && input.localResult.risk === 'warning') return { shouldReview: false, reason: 'local_only', sampleNumber: 0 };
      return { shouldReview: true, reason: 'strict', sampleNumber: 0 };
    }
    if (input.riskProfile === 'strict') return { shouldReview: true, reason: 'strict', sampleNumber: 0 };

    const combined = `${input.transcript}\n${input.contextText ?? ''}`;
    if (SEMANTIC_TRIGGER.test(combined)) return { shouldReview: true, reason: 'semantic_trigger', sampleNumber: 0 };

    const highRiskWarning = input.localResult.risk === 'warning'
      && (!input.localFastPath || input.localResult.category === 'medical' || input.localResult.category === 'health' || input.localResult.category === 'context' || HIGH_RISK_CATEGORY.test(input.productCategory ?? ''));
    if (highRiskWarning) return { shouldReview: true, reason: 'local_warning', sampleNumber: 0 };

    const interval = input.riskProfile === 'optimized' ? 8 : 4;
    const key = `${input.roomId ?? ''}:${input.productId}:${input.speakerId ?? 'unknown'}`;
    const sampleNumber = (this.sampleCounts.get(key) ?? 0) + 1;
    this.sampleCounts.set(key, sampleNumber);
    if (sampleNumber % interval === 0) return { shouldReview: true, reason: 'sample', sampleNumber };
    return { shouldReview: false, reason: 'local_only', sampleNumber };
  }
}
