import { describe, expect, it } from 'vitest';
import type { ComplianceResult } from '../../src/shared/types';
import { SemanticReviewPolicy } from './semanticReviewPolicy';

const local = (risk: 'safe' | 'warning' | 'blocked', category: ComplianceResult['category'] = 'suitability'): ComplianceResult => ({
  id: `local-${risk}`,
  productId: 'serum',
  risk,
  title: '本地判断',
  reason: '测试',
  alternative: '安全表达',
  policyRef: '测试',
  confidence: 0.99,
  source: 'local-fallback',
  transcript: '测试文本',
  createdAt: 1,
  category,
});

describe('SemanticReviewPolicy', () => {
  it('reviews an ordinary warning even when the legacy fast path is enabled', () => {
    const decision = new SemanticReviewPolicy().decide({ productId: 'serum', transcript: '适合所有肤质', localResult: local('warning'), localFastPath: true });

    expect(decision).toMatchObject({ shouldReview: true, reason: 'semantic_review' });
  });

  it('does not let a legacy risk profile reduce warning coverage', () => {
    const policy = new SemanticReviewPolicy();
    for (const riskProfile of ['strict', 'balanced', 'optimized'] as const) {
      const decision = policy.decide({ productId: 'serum', transcript: '适合所有肤质', riskProfile, localResult: local('warning'), localFastPath: true });
      expect(decision).toMatchObject({ shouldReview: true, reason: 'semantic_review' });
    }
  });

  it('does not let a legacy risk profile reduce ordinary speech coverage', () => {
    const policy = new SemanticReviewPolicy();
    for (const riskProfile of ['strict', 'balanced', 'optimized'] as const) {
      const decision = policy.decide({ productId: 'serum', transcript: '这款面料触感柔软', riskProfile, localResult: local('safe'), localFastPath: true });
      expect(decision).toMatchObject({ shouldReview: true, reason: 'semantic_review' });
    }
  });

  it('does not re-review a deterministic local block', () => {
    const decision = new SemanticReviewPolicy().decide({ productId: 'serum', transcript: '保证立刻见效', riskProfile: 'optimized', localResult: local('blocked'), localFastPath: true });

    expect(decision).toMatchObject({ shouldReview: false, reason: 'local_blocked' });
  });

  it('reviews high-risk warnings in balanced mode', () => {
    const decision = new SemanticReviewPolicy().decide({ productId: 'supplement', productCategory: '保健食品', transcript: '这个产品非常适合大家', riskProfile: 'balanced', localResult: local('warning', 'health'), localFastPath: true });

    expect(decision).toMatchObject({ shouldReview: true, reason: 'semantic_review' });
  });

  it('reviews euphemistic context immediately in optimized mode', () => {
    const decision = new SemanticReviewPolicy().decide({ productId: 'supplement', transcript: '这个汽油要保持干净', contextText: '人的发动机每天都在工作', riskProfile: 'optimized', localResult: local('safe', 'context'), localFastPath: true });

    expect(decision).toMatchObject({ shouldReview: true, reason: 'semantic_trigger' });
  });

  it('turns product profile boundary concepts into semantic pre-review triggers', () => {
    const decision = new SemanticReviewPolicy().decide({ productId: 'cosmetic', productIndustry: '美妆个护', productCategory: '护肤品/化妆品', profileBoundaries: ['功效宣称需与备案或商品页面一致'], transcript: '这个功效特别明显', riskProfile: 'optimized', localResult: local('safe'), localFastPath: true });

    expect(decision).toMatchObject({ shouldReview: true, reason: 'semantic_trigger' });
  });
});
