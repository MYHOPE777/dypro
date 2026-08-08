import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildArkRequest, getArkConfig, getArkKnowledgeSearchStatus, requestArk } from '../../server/providers/ark';

afterEach(() => vi.unstubAllGlobals());

describe('Volcano Ark Responses API', () => {
  it('uses the official /responses body and knowledge_search tool fields', () => {
    const config = getArkConfig({ ARK_API_KEY: 'key', ARK_MODEL: 'model', ARK_SERVICE_TIER: 'fast', KNOWLEDGE_RESOURCE_ID: 'resource' });
    expect(config).not.toBeNull();
    const request = buildArkRequest(config!, 'system', 'user', 500, true);
    const headers = new Headers(request.headers);
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(headers.get('authorization')).toBe('Bearer key');
    expect(headers.get('ark-beta-knowledge-search')).toBe('true');
    expect(body).toMatchObject({ model: 'model', service_tier: 'auto', store: false, max_output_tokens: 500, thinking: { type: 'auto' }, text: { format: { type: 'json_object' } } });
    expect(body.tools).toEqual([{ type: 'knowledge_search', knowledge_resource_id: 'resource', limit: 10 }]);
    expect(body.input).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: 'system' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'user' }] },
    ]);
  });

  it('passes the official fast service tier when no knowledge_search tool is enabled', () => {
    const config = getArkConfig({ ARK_API_KEY: 'key', ARK_MODEL: 'model', ARK_SERVICE_TIER: 'fast' });
    const body = JSON.parse(String(buildArkRequest(config!, 'system', 'user', 160).body)) as Record<string, unknown>;

    expect(body.service_tier).toBe('fast');
  });

  it('falls back to auto when fast is not open for the configured model', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'ModelNotOpen' } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: '{"risk":"safe"}' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = getArkConfig({ ARK_API_KEY: 'key', ARK_MODEL: 'model', ARK_SERVICE_TIER: 'fast' })!;

    await expect(requestArk(config, 'system', 'user', 100)).resolves.toBe('{"risk":"safe"}');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).service_tier).toBe('fast');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).service_tier).toBe('auto');
  });

  it('calls only the official Responses endpoint and extracts output_text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: '{"risk":"safe"}' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = getArkConfig({ ARK_API_KEY: 'key', ARK_MODEL: 'model' })!;

    await expect(requestArk(config, 'system', 'user', 100)).resolves.toBe('{"risk":"safe"}');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ark.cn-beijing.volces.com/api/v3/responses');
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/responses$/u);
  });

  it('reports knowledge search as optional configuration', () => {
    expect(getArkKnowledgeSearchStatus({ ARK_API_KEY: 'key', ARK_MODEL: 'model' }).configured).toBe(false);
    expect(getArkKnowledgeSearchStatus({ ARK_API_KEY: 'key', ARK_MODEL: 'model', KNOWLEDGE_RESOURCE_ID: 'resource' })).toMatchObject({ configured: true, available: true });
  });

  it('surfaces a failed knowledge_search request in readiness', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'AccessDenied' } }), { status: 403 })));
    const config = getArkConfig({ ARK_API_KEY: 'key', ARK_MODEL: 'model', KNOWLEDGE_RESOURCE_ID: 'resource' })!;

    await expect(requestArk(config, 'system', 'user', 100, true)).rejects.toThrow('AccessDenied');
    expect(getArkKnowledgeSearchStatus({ ARK_API_KEY: 'key', ARK_MODEL: 'model', KNOWLEDGE_RESOURCE_ID: 'resource' })).toMatchObject({ configured: true, available: false });
  });
});
