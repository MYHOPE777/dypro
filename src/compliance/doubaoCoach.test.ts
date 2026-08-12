import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('asks Ark to independently generate the next line when no presenter template exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({
        suggestions: [
          { purpose: '塑品', text: '先从日常使用场景看看这款商品的特点。', reason: '建立商品价值' },
          { purpose: '互动', text: '大家更想了解材质还是使用方法？', reason: '引导评论互动' },
          { purpose: '转化', text: '需要的朋友可以打开商品卡查看详情。', reason: '承接购买动作' },
        ],
      }),
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const suggestions = await new DoubaoCoach({ ARK_API_KEY: 'test-key', ARK_MODEL: 'test-model' }).suggestMany(input);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      input: Array<{ content: Array<{ text: string }> }>;
    };
    const userPayload = JSON.parse(request.input[1]?.content[0]?.text ?? '{}') as {
      templateMode?: string;
      templateInstruction?: string;
      referencePhrases?: unknown[];
    };

    expect(userPayload.templateMode).toBe('generate');
    expect(userPayload.templateInstruction).toContain('没有主播模板话术');
    expect(userPayload.templateInstruction).toContain('主播当前原话作为第一优先级');
    expect(userPayload.referencePhrases).toEqual([]);
    expect(suggestions).toHaveLength(3);
    expect(suggestions.every((suggestion) => suggestion.source === 'doubao')).toBe(true);
  });

  it('keeps three local safe alternatives when Ark generation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));

    const suggestions = await new DoubaoCoach({ ARK_API_KEY: 'test-key', ARK_MODEL: 'test-model' }).suggestMany(input);

    expect(suggestions).toHaveLength(3);
    expect(suggestions.every((suggestion) => suggestion.source === 'local-fallback')).toBe(true);
    expect(new Set(suggestions.map((suggestion) => suggestion.text)).size).toBe(3);
  });

  it('continues from the presenter transcript before using product material', async () => {
    const suggestions = await new DoubaoCoach({}).suggestMany({
      ...input,
      transcript: '刚才有朋友问这个适不适合通勤',
      referencePhrases: [{ text: '这是商品资料里预设的固定模板话术', purpose: '塑品' }],
    });

    expect(suggestions[0]?.text).toContain('朋友问这个适不适合通勤');
    expect(suggestions[0]?.text).not.toBe('这是商品资料里预设的固定模板话术');
  });

  it('removes locally detectable risk from model-generated alternatives', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({
        suggestions: [
          { purpose: '塑品', text: '这款产品可以治疗耳聋。', reason: '错误功效承诺' },
          { purpose: '互动', text: '大家最想了解哪一个使用细节？', reason: '引导评论互动' },
          { purpose: '转化', text: '需要的朋友可以打开商品卡查看规格。', reason: '承接购买动作' },
        ],
      }),
    }), { status: 200 })));

    const suggestions = await new DoubaoCoach({ ARK_API_KEY: 'test-key', ARK_MODEL: 'test-model' }).suggestMany(input);

    expect(suggestions).toHaveLength(3);
    expect(suggestions.some((suggestion) => suggestion.text.includes('治疗耳聋'))).toBe(false);
    expect(suggestions.filter((suggestion) => suggestion.source === 'doubao')).toHaveLength(2);
    expect(suggestions.filter((suggestion) => suggestion.source === 'local-fallback')).toHaveLength(1);
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
    expect(suggestion.text).toBe('活动以页面为准。');
  });

  it('does not trust a risk alternative that repeats its matched phrase', () => {
    const suggestion = localSuggestion({
      ...input,
      compliance: { id: 'risk', productId: 'serum', risk: 'blocked', title: '风险', reason: '测试', alternative: '可以改为：继续治疗耳聋。', policyRef: '测试', confidence: 0.99, source: 'doubao', transcript: '治疗耳聋', matchedTerms: ['治疗耳聋'], ruleKind: 'term', createdAt: 1 },
    });
    expect(suggestion.text).not.toContain('治疗耳聋');
  });
});
