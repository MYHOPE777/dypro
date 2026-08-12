import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTS } from '../../src/shared/products';
import { DoubaoProductComplianceProfiler, localProductComplianceProfile } from './productComplianceProfiler';

afterEach(() => vi.unstubAllGlobals());

describe('product compliance profiler', () => {
  it('creates an immediate local profile with Douyin live-commerce as the default ruleset', () => {
    const profile = localProductComplianceProfile(PRODUCTS[0], 123);

    expect(profile).toMatchObject({ industry: '美妆个护', category: '护肤品/化妆品', platformRuleset: 'douyin-ecommerce-live', source: 'local-fallback', status: 'needs_review', updatedAt: 123 });
    expect(profile.riskBoundaries).toContain('不得将化妆品宣传为医疗或疾病治疗手段');
  });

  it('uses Doubao to normalize industry, category and editable compliance material', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify({ industry: '美妆个护', category: '面部护肤/精华', complianceSummary: '只介绍备案和页面可核验功效。', riskKeywords: ['医学治愈'], riskBoundaries: ['不得宣传疾病治疗'], requiredDisclosures: ['功效宣称需与备案一致'], safeSellingPoints: ['介绍质地和使用方式'], confidence: 0.93 }) }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const profiler = new DoubaoProductComplianceProfiler({ ARK_API_KEY: 'key', ARK_MODEL: 'model' });

    const profile = await profiler.profile(PRODUCTS[0]);

    expect(profile).toMatchObject({ industry: '美妆个护', category: '面部护肤/精华', source: 'doubao', status: 'generated', confidence: 0.93 });
    expect(profile.riskKeywords).toEqual(['医学治愈']);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { input: Array<{ content: Array<{ text: string }> }> };
    expect(request.input[0]?.content[0]?.text).toContain('抖音电商带货直播商品合规资料专员');
    expect(request.input[1]?.content[0]?.text).toContain('默认平台规则：抖音带货直播间');
  });

  it('falls back locally when Doubao is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const profile = await new DoubaoProductComplianceProfiler({ ARK_API_KEY: 'key', ARK_MODEL: 'model', ARK_PRODUCT_PROFILE_TIMEOUT_MS: '5' }).profile(PRODUCTS[1]);

    expect(profile).toMatchObject({ industry: '数码家电', source: 'local-fallback', status: 'needs_review' });
  });
});
