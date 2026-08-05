import { describe, expect, it } from 'vitest';
import { DoubaoComplianceAnalyzer } from '../../server/providers/doubao';

describe('DoubaoComplianceAnalyzer', () => {
  it('uses the local guardrail when credentials are not configured', async () => {
    const analyzer = new DoubaoComplianceAnalyzer({});
    const result = await analyzer.analyze({ productId: 'serum', transcript: '这款产品保证立刻见效' });

    expect(result.source).toBe('local-fallback');
    expect(result.risk).toBe('blocked');
  });
});
