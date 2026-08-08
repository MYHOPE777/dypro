import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoubaoComplianceAnalyzer } from '../../server/providers/doubao';
import type { ComplianceRule } from '../shared/types';

afterEach(() => vi.unstubAllGlobals());

describe('DoubaoComplianceAnalyzer', () => {
  it('uses the local guardrail when credentials are not configured', async () => {
    const analyzer = new DoubaoComplianceAnalyzer({});
    const result = await analyzer.analyze({ productId: 'serum', transcript: '这款产品保证立刻见效' });

    expect(result.source).toBe('local-fallback');
    expect(result.risk).toBe('blocked');
    expect(result.analysisTiming).toMatchObject({
      path: 'local',
      analyzerMs: expect.any(Number),
      localGuardrailMs: expect.any(Number),
    });
  });

  it('returns an immediate local block without waiting for a lower-priority model result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ risk: 'warning', title: '豆包提醒', reason: '需要注意', alternative: '替代表达', policyRef: '平台规则', confidence: 0.8 }) }] }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const rule: ComplianceRule = {
      id: 'rule-warning', roomId: 'room-default', scope: 'room', name: '内部提醒', matchType: 'contains', pattern: '保证',
      risk: 'warning', title: '内部提醒', reason: '需要注意', alternative: '替代表达', policyRef: '内部规则', enabled: true,
      status: 'published', version: 1, createdBy: 'owner', createdAt: 1, updatedAt: 1,
    };
    const analyzer = new DoubaoComplianceAnalyzer({ ARK_API_KEY: 'key', ARK_MODEL: 'model' });

    const result = await analyzer.analyze({ productId: 'serum', transcript: '保证三天全部消失', customRules: [rule] });

    expect(result.risk).toBe('blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a compact response budget for semantic checks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ risk: 'warning', title: '语义提醒', reason: '需要核验', alternative: '替代表达', policyRef: '平台规则', confidence: 0.8 }) }] }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const analyzer = new DoubaoComplianceAnalyzer({ ARK_API_KEY: 'key', ARK_MODEL: 'model', ARK_COMPLIANCE_MAX_OUTPUT_TOKENS: '200', ARK_LOCAL_FAST_PATH: 'false' });

    await analyzer.analyze({ productId: 'serum', transcript: '特别适合所有肤质' });

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { max_output_tokens: number; input: Array<{ content: Array<{ text: string }> }> };
    expect(request.max_output_tokens).toBe(200);
    expect(request.input[1]?.content[0]?.text).toContain('本直播间相关规则');
  });

  it('returns a high-confidence local warning without waiting for the model', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const analyzer = new DoubaoComplianceAnalyzer({ ARK_API_KEY: 'key', ARK_MODEL: 'model' });

    const result = await analyzer.analyze({ productId: 'serum', transcript: '这款商品适合所有肤质' });

    expect(result).toMatchObject({ risk: 'warning', source: 'local-fallback' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses a recent result for the same transcript and product', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({ risk: 'warning', title: '语义提醒', reason: '需要核验', alternative: '替代表达', policyRef: '平台规则', confidence: 0.8 }),
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const analyzer = new DoubaoComplianceAnalyzer({ ARK_API_KEY: 'key', ARK_MODEL: 'model', ARK_LOCAL_FAST_PATH: 'false' });
    const input = { productId: 'serum', transcript: '这款商品采用行业领先的特殊工艺', customRules: [] };

    const first = await analyzer.analyze(input);
    const second = await analyzer.analyze(input);

    expect(second).toMatchObject({ risk: 'warning', source: 'doubao' });
    expect(second.id).toBe(first.id);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('falls back to local rules when Doubao exceeds the realtime deadline', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const analyzer = new DoubaoComplianceAnalyzer({ ARK_API_KEY: 'key', ARK_MODEL: 'model', ARK_TIMEOUT_MS: '5', ARK_LOCAL_FAST_PATH: 'false' });

    const result = await analyzer.analyze({ productId: 'serum', transcript: '今天是全网最低价' });

    expect(result).toMatchObject({ risk: 'warning', source: 'local-fallback' });
    expect(result.reason).toContain('豆包暂时不可用');
  });
});
