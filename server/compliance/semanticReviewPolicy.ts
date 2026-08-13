import type { ComplianceResult, RiskProfile } from '../../src/shared/types';

export type SemanticReviewReason = 'semantic_review' | 'semantic_trigger' | 'local_blocked';

export type SemanticReviewDecision = {
  shouldReview: boolean;
  reason: SemanticReviewReason;
  sampleNumber: number;
};

export type SemanticReviewPolicyInput = {
  roomId?: string;
  productId: string;
  productCategory?: string;
  productIndustry?: string;
  profileBoundaries?: string[];
  transcript: string;
  contextText?: string;
  riskProfile?: RiskProfile;
  localResult: ComplianceResult;
  speakerId?: string;
  localFastPath?: boolean;
};

const SEMANTIC_TRIGGER = /暗示|影射|相当于|就像|好比|发动机|汽油|血液|心脏|疏通|排毒|修复|替代药|不用吃药|不能明说|懂的都懂|那个部位|指标恢复|循环起来|从根上|彻底解决/iu;
const PROFILE_BOUNDARY_TRIGGER = /治疗|治愈|疾病|药物|医疗|功效|减肥|减重|发育|过敏|绝对安全|所有人|绝对|永久|保证|排名|第一|最低|权威|认证|资质|鉴定|对比|稀缺|促销|续航|降噪|不卡|兼容|检测|备案|保温|耐用|售后/giu;

function profileTriggers(boundaries: string[]): string[] {
  return [...new Set(boundaries.flatMap((boundary) => boundary.match(PROFILE_BOUNDARY_TRIGGER) ?? []).map((item) => item.trim()).filter((item) => item.length >= 2))];
}

/**
 * Owns only the decision to spend a model request. It does not interpret a result,
 * which keeps cost policy independent from the analyzer adapter.
 */
export class SemanticReviewPolicy {
  decide(input: SemanticReviewPolicyInput): SemanticReviewDecision {
    if (input.localResult.risk === 'blocked') return { shouldReview: false, reason: 'local_blocked', sampleNumber: 0 };
    const combined = `${input.transcript}\n${input.contextText ?? ''}`;
    const hasSemanticSignal = SEMANTIC_TRIGGER.test(combined)
      || Boolean(input.profileBoundaries && profileTriggers(input.profileBoundaries).some((trigger) => combined.includes(trigger)));

    // A local safe result means that no deterministic rule matched; it does not
    // prove that a sentence is semantically safe. Warnings are also uncertain.
    // Both must be reviewed by Doubao whenever credentials are available.
    return { shouldReview: true, reason: hasSemanticSignal ? 'semantic_trigger' : 'semantic_review', sampleNumber: 0 };
  }
}
