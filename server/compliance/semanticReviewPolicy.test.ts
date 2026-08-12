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
  it('keeps an ordinary warning local when the legacy fast path is enabled', () => {
    const decision = new SemanticReviewPolicy().decide({ productId: 'serum', transcript: '适合所有肤质', localResult: local('warning'), localFastPath: true });

    expect(decision).toMatchObject({ shouldReview: false, reason: 'local_only' });
  });

  it('reviews high-risk warnings even in balanced mode', () => {
    const decision = new SemanticReviewPolicy().decide({ productId: 'supplement', productCategory: '保健食品', transcript: '这个产品非常适合大家', riskProfile: 'balanced', localResult: local('warning', 'health'), localFastPath: true });

    expect(decision).toMatchObject({ shouldReview: true, reason: 'local_warning' });
  });

  it('reviews euphemistic context immediately in optimized mode', () => {
    const decision = new SemanticReviewPolicy().decide({ productId: 'supplement', transcript: '这个汽油要保持干净', contextText: '人的发动机每天都在工作', riskProfile: 'optimized', localResult: local('safe', 'context'), localFastPath: true });

    expect(decision).toMatchObject({ shouldReview: true, reason: 'semantic_trigger' });
  });

  it('samples ordinary safe speech at the configured interval per room, product and speaker', () => {
    const policy = new SemanticReviewPolicy();
    const decisions = Array.from({ length: 8 }, (_, index) => policy.decide({ roomId: 'room-a', productId: 'serum', speakerId: 'speaker-1', transcript: `普通介绍${index}`, riskProfile: 'optimized', localResult: local('safe'), localFastPath: true }));

    expect(decisions.filter((decision) => decision.shouldReview).map((decision) => decision.sampleNumber)).toEqual([8]);
    expect(policy.decide({ roomId: 'room-a', productId: 'serum', speakerId: 'speaker-2', transcript: '另一个人说话', riskProfile: 'optimized', localResult: local('safe'), localFastPath: true }).sampleNumber).toBe(1);
  });

  it('samples high-risk industries more often while preserving the selected cost profile', () => {
    const policy = new SemanticReviewPolicy();
    const balanced = Array.from({ length: 2 }, (_, index) => policy.decide({ roomId: 'room-risk', productId: 'food', productIndustry: '食品饮料', productCategory: '食品/营养补充类', transcript: `普通介绍${index}`, riskProfile: 'balanced', localResult: local('safe'), localFastPath: true }));
    const optimized = Array.from({ length: 4 }, (_, index) => policy.decide({ roomId: 'room-risk-2', productId: 'food', productIndustry: '食品饮料', productCategory: '食品/营养补充类', transcript: `普通介绍${index}`, riskProfile: 'optimized', localResult: local('safe'), localFastPath: true }));

    expect(balanced.at(-1)).toMatchObject({ shouldReview: true, sampleNumber: 2 });
    expect(optimized.at(-1)).toMatchObject({ shouldReview: true, sampleNumber: 4 });
  });

  it('turns product profile boundary concepts into semantic pre-review triggers', () => {
    const decision = new SemanticReviewPolicy().decide({ productId: 'cosmetic', productIndustry: '美妆个护', productCategory: '护肤品/化妆品', profileBoundaries: ['功效宣称需与备案或商品页面一致'], transcript: '这个功效特别明显', riskProfile: 'optimized', localResult: local('safe'), localFastPath: true });

    expect(decision).toMatchObject({ shouldReview: true, reason: 'semantic_trigger' });
  });
});
