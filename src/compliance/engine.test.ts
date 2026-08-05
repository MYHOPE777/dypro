import { describe, expect, it } from 'vitest';
import { analyzeTranscript } from './engine';

describe('analyzeTranscript', () => {
  it('flags an absolute efficacy claim and gives the host a product-safe replacement', async () => {
    const result = await analyzeTranscript({
      productId: 'serum',
      product: { id: 'serum', name: '轻透焕亮精华', category: '护肤', price: '¥129', compliantPhrases: [] },
      transcript: '这款精华用了三天保证你脸上的斑全部消失，不满意全额赔付',
    });

    expect(result.risk).toBe('blocked');
    expect(result.title).toContain('绝对化');
    expect(result.reason).toContain('保证');
    expect(result.alternative).toContain('个体体验');
    expect(result.policyRef).toBeTruthy();
  });

  it('keeps local fallback wording aligned with the selected non-skincare product', async () => {
    const result = await analyzeTranscript({
      productId: 'headphones',
      product: { id: 'headphones', name: '云感降噪耳机', category: '数码', price: '¥299', compliantPhrases: [] },
      transcript: '这款耳机保证戴上就完全没有噪音',
    });

    expect(result.risk).toBe('blocked');
    expect(result.alternative).toContain('云感降噪耳机');
    expect(result.alternative).not.toContain('肤感');
  });
});
