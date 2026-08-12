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

  it('requests a fresh compliance profile for an existing room product', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(PRODUCTS[0]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await new CatalogClient().generateProductComplianceProfile('room-a', 'product-a');

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/rooms/room-a/products/product-a/compliance-profile/generate', expect.objectContaining({ method: 'POST' }));
  });
});
