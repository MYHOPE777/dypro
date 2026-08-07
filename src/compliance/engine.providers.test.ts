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
  });

  it('applies the non-downgradable local block before a lower custom rule or Doubao call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ risk: 'warning', title: '豆包提醒', reason: '需要注意', alternative: '替代表达', policyRef: '平台规则', confidence: 0.8 }) } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const rule: ComplianceRule = {
      id: 'rule-warning', roomId: 'room-default', scope: 'room', name: '内部提醒', matchType: 'contains', pattern: '保证',
      risk: 'warning', title: '内部提醒', reason: '需要注意', alternative: '替代表达', policyRef: '内部规则', enabled: true,
      status: 'published', version: 1, createdBy: 'owner', createdAt: 1, updatedAt: 1,
    };
    const analyzer = new DoubaoComplianceAnalyzer({ DOUBAO_API_KEY: 'key', DOUBAO_ENDPOINT_ID: 'endpoint' });

    const result = await analyzer.analyze({ productId: 'serum', transcript: '保证三天全部消失', customRules: [rule] });

    expect(result.risk).toBe('blocked');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('falls back to local rules when Doubao exceeds the realtime deadline', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const analyzer = new DoubaoComplianceAnalyzer({ DOUBAO_API_KEY: 'key', DOUBAO_ENDPOINT_ID: 'endpoint', DOUBAO_TIMEOUT_MS: '5' });

    const result = await analyzer.analyze({ productId: 'serum', transcript: '这款产品保证立刻见效' });

    expect(result).toMatchObject({ risk: 'blocked', source: 'local-fallback' });
    expect(result.reason).toContain('豆包暂时不可用');
  });
});
