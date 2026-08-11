import { describe, expect, it } from 'vitest';
import { analyzeTranscript } from './engine';
import type { ComplianceRule } from '../shared/types';

describe('analyzeTranscript', () => {
  it('flags semantic appearance claims without relying on a listed sensitive word', async () => {
    const result = await analyzeTranscript({ productId: 'serum', transcript: '这款面霜用了之后毛孔看不见了，皮肤像婴儿一样' });

    expect(result.risk).toBe('blocked');
    expect(result.title).toContain('外观效果');
    expect(result.matchedTerms?.[0]).toContain('毛孔');
    expect(result.matchedTerms?.[0]).toContain('看不见');
  });

  it('flags universal suitability claims as a warning', async () => {
    const result = await analyzeTranscript({ productId: 'serum', transcript: '特别适合所有肤质，任何人都可以放心使用' });

    expect(result.risk).toBe('warning');
    expect(result.reason).toContain('所有人');
    expect(result.matchedTerms?.[0]).toContain('所有肤质');
  });

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

  it.each(['耳聋都可以治好', '治好耳聋', '耳聋能够根治'])('blocks cure claims that combine a medical condition with efficacy language: %s', async (transcript) => {
    const result = await analyzeTranscript({ productId: 'headphones', transcript });

    expect(result.risk).toBe('blocked');
    expect(result.title).toContain('医疗');
    expect(result.matchedTerms?.[0]).toBeTruthy();
  });

  it('allows a medical condition mention without a treatment claim', async () => {
    const result = await analyzeTranscript({ productId: 'headphones', transcript: '关注耳聋人士的日常佩戴体验，具体以产品页面为准' });

    expect(result.risk).toBe('safe');
  });

  it('never lets a custom safe rule downgrade a built-in blocked expression', async () => {
    const safeRule: ComplianceRule = {
      id: 'rule-safe', roomId: 'room-default', scope: 'room', name: '普通保证用语', matchType: 'contains', pattern: '保证',
      risk: 'safe', title: '内部白名单', reason: '内部认为可以使用', alternative: '继续介绍', policyRef: '内部规则',
      enabled: true, status: 'published', version: 1, createdBy: 'owner', createdAt: 1, updatedAt: 1,
    };
    const result = await analyzeTranscript({ productId: 'serum', transcript: '保证三天全部消失', customRules: [safeRule] });

    expect(result.risk).toBe('blocked');
    expect(result.title).toContain('绝对化');
  });

  it('chooses the highest-priority medical finding when one sentence matches several rules', async () => {
    const result = await analyzeTranscript({ productId: 'headphones', transcript: '全网最低价，而且耳聋都可以治好' });

    expect(result.risk).toBe('blocked');
    expect(result.category).toBe('medical');
    expect(result.ruleId).toBe('medical-condition-efficacy');
    expect(result.enforcement).toBe('block_phrase');
  });

  it.each([
    '不要说治疗耳聋，这不是商品功效',
    '比如有人说耳聋都可以治好，这是错误说法',
    '平台不允许宣传治疗糖尿病的效果',
  ])('downgrades negated, quoted, and educational medical wording to a caution: %s', async (transcript) => {
    const result = await analyzeTranscript({ productId: 'headphones', transcript });

    expect(result.risk).toBe('warning');
    expect(result.category).toBe('context');
    expect(result.ruleId).toBe('sensitive-claim-reference');
    expect(result.enforcement).toBe('warn');
  });

  it('does not block an ordinary guarantee that is not tied to an outcome', async () => {
    const result = await analyzeTranscript({ productId: 'mug', transcript: '这款保温杯保证品质，售后按页面规则执行' });

    expect(result.risk).toBe('safe');
    expect(result.enforcement).toBe('allow');
  });

  it('keeps outcome guarantees blocked while classifying extreme words as warnings', async () => {
    const blocked = await analyzeTranscript({ productId: 'serum', transcript: '保证三天见效' });
    const warning = await analyzeTranscript({ productId: 'serum', transcript: '今天是全网最低价' });

    expect(blocked).toMatchObject({ risk: 'blocked', category: 'guarantee', ruleKind: 'sentence', enforcement: 'block_phrase' });
    expect(warning).toMatchObject({ risk: 'warning', category: 'extreme', ruleKind: 'term', enforcement: 'warn' });
  });
});
