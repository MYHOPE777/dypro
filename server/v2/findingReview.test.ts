import { describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT } from '../../src/shared/products';
import type { ComplianceFinding } from '../../src/shared/types';
import { FindingReviewModule } from './findingReview';

describe('FindingReviewModule', () => {
  it('keeps confirmation idempotent and resolves the product from the finding snapshot', () => {
    const finding = { id: 'finding-1', sessionId: 'session-1', roomId: 'room-1', segmentId: 'segment-1', productId: DEFAULT_PRODUCT.id, productName: DEFAULT_PRODUCT.name, product: DEFAULT_PRODUCT, result: { id: 'result-1', segmentId: 'segment-1', productId: DEFAULT_PRODUCT.id, risk: 'blocked' as const, title: '医疗功效', reason: '风险', alternative: '客观介绍', policyRef: '规则', confidence: 0.99, source: 'doubao' as const, transcript: '一定能治好', matchedTerms: ['一定'], ruleKind: 'term' as const, createdAt: 1 }, disposition: 'pending' as const, createdAt: 1, updatedAt: 1 } satisfies ComplianceFinding;
    const resolved = { ...finding, disposition: 'confirmed' as const, ruleId: 'rule-1', disposedBy: 'operator', disposedAt: 2 };
    const store = {
      getComplianceFinding: () => finding,
      listComplianceFindings: () => [finding],
      getRule: (id: string) => ({ id, roomId: 'room-1' } as never),
      resolveComplianceFinding: () => resolved,
    } as never;
    const rules = { confirmFinding: () => ({ id: 'rule-1' } as never) } as never;
    const packages = { confirmSemanticFinding: () => ({ id: 'unit-1' } as never) } as never;
    const module = new FindingReviewModule(store, rules, packages, () => [DEFAULT_PRODUCT], () => null, () => 2);
    expect(module.confirm('session-1', 'segment-1', 'operator')?.finding).toBe(resolved);
    expect(module.confirm('session-1', 'segment-1', 'operator')?.rule).toMatchObject({ id: 'rule-1' });
  });
});

