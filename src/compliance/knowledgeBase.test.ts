import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArkKnowledgeBase, createKnowledgeBase } from '../../server/knowledgeBase';

afterEach(() => vi.unstubAllGlobals());

describe('ArkKnowledgeBase', () => {
  it('degrades to empty evidence when not configured', async () => {
    const base = createKnowledgeBase({});
    expect(await base.retrieve({ roomId: 'room-default', transcript: '全网最低', product: { id: 'p', name: '商品', category: '其他', price: '¥1', compliantPhrases: [] }, activeRules: [] })).toEqual([]);
    expect(base.status()).toMatchObject({ configured: false, available: true });
  });

  it('normalizes gateway evidence and sends bounded retrieval context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { items: [{ id: 'case-1', title: '处罚案例', text: '不要使用绝对化承诺', score: 1.2, source: '内部案例' }] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const base = new ArkKnowledgeBase({ retrieveUrl: 'https://kb.example/retrieve', apiKey: 'secret', timeoutMs: 500 });
    const evidence = await base.retrieve({ roomId: 'room-default', transcript: '这款保证有效', product: { id: 'p', name: '商品', category: '其他', price: '¥1', compliantPhrases: [] }, activeRules: [] });

    expect(evidence).toEqual([{ id: 'case-1', title: '处罚案例', content: '不要使用绝对化承诺', source: '内部案例', score: 1 }]);
    expect(fetchMock).toHaveBeenCalledWith('https://kb.example/retrieve', expect.objectContaining({ method: 'POST', body: expect.stringContaining('"top_k":5') }));
    expect(base.status().available).toBe(true);
  });

  it('returns no evidence and exposes the failure after a gateway error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('网络不可用')));
    const base = new ArkKnowledgeBase({ retrieveUrl: 'https://kb.example/retrieve', apiKey: 'secret', timeoutMs: 500 });
    const evidence = await base.retrieve({ roomId: 'room-default', transcript: '测试', product: { id: 'p', name: '商品', category: '其他', price: '¥1', compliantPhrases: [] }, activeRules: [] });
    expect(evidence).toEqual([]);
    expect(base.status()).toMatchObject({ configured: true, available: false, lastError: '网络不可用' });
  });
});
