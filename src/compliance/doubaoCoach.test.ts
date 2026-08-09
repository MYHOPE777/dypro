import { describe, expect, it } from 'vitest';
import { DoubaoCoach, localSuggestion } from '../../server/providers/doubaoCoach';
import { PRODUCTS } from '../shared/products';
import type { CoachInput } from '../../server/providers/doubaoCoach';

const input: CoachInput = {
  product: PRODUCTS[0],
  transcript: '这款精华适合日常护肤',
  compliance: null,
  stats: { speakingSeconds: 30, words: 24, blockedCount: 0, warningCount: 0, safeCount: 1 },
};

describe('DoubaoCoach', () => {
  it('returns a local, purpose-labelled suggestion when Ark is not configured', async () => {
    const suggestion = await new DoubaoCoach({}).suggest(input);

    expect(suggestion).toMatchObject({ source: 'local-fallback', purpose: '留人' });
    expect(suggestion.text.length).toBeGreaterThan(0);
  });

  it('always returns three distinct next-line alternatives', async () => {
    const suggestions = await new DoubaoCoach({}).suggestMany(input);

    expect(suggestions).toHaveLength(3);
    expect(new Set(suggestions.map((suggestion) => suggestion.text)).size).toBe(3);
    expect(suggestions.every((suggestion) => suggestion.purpose && suggestion.reason)).toBe(true);
  });

  it('prioritizes a safe conversion phrase after a compliance warning', () => {
    const suggestion = localSuggestion({
      ...input,
      transcript: '全网最低价，错过就后悔',
      compliance: {
        id: 'warning', productId: 'serum', risk: 'warning', title: '极限词', reason: '需要核验', alternative: '可以改为：活动以页面为准。', policyRef: '测试', confidence: 0.9, source: 'local-fallback', transcript: '全网最低价，错过就后悔', createdAt: Date.now(),
      },
    });

    expect(suggestion).toMatchObject({ purpose: '转化', source: 'local-fallback' });
  });
});
