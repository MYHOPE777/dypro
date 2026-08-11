import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTS } from '../shared/products';
import { CatalogClient } from './catalogClient';

afterEach(() => vi.unstubAllGlobals());

describe('CatalogClient', () => {
  it('keeps product creation compatible with an older live server process', async () => {
    const product = { ...PRODUCTS[0], id: 'product-new', name: '直播间新商品', description: '', sellingPoints: [], compliantPhrases: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: '商品描述不能为空' }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(async (_input: string, init?: RequestInit) => new Response(String(init?.body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const saved = await new CatalogClient().saveProduct('room-default', product);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(saved).toMatchObject({ id: product.id, name: product.name });
    expect(saved.description).toContain('资料待补充');
  });
});
