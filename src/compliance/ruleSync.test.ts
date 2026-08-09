import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileRuleSyncQueue } from '../../server/ruleSync';
import type { ComplianceRule } from '../shared/types';

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const learnedRule: ComplianceRule = {
  id: 'rule-learned', roomId: 'room-default', scope: 'room', name: '智能发现', matchType: 'contains', pattern: '全平台最低',
  risk: 'warning', title: '价格风险', reason: '无法核验', alternative: '以页面为准', policyRef: '平台规则', enabled: true,
  status: 'pending_review', version: 1, origin: 'learned', confidence: 0.97, evidenceCount: 1,
  createdBy: 'doubao-learning', createdAt: 1, updatedAt: 1,
};

describe('rule sync queue', () => {
  it('sends a versioned local rule event without blocking the caller', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rule-sync-'));
    directories.push(directory);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const queue = new FileRuleSyncQueue(
      { url: 'https://sync.example/rules', apiKey: 'test-key', timeoutMs: 1_000 },
      path.join(directory, 'queue.json'),
    );

    expect(queue.enqueue({ action: 'learned', rule: learnedRule, occurredAt: 10 })).toBe(true);
    expect(queue.status()).toMatchObject({ pending: 1, failed: 0, succeeded: 0 });
    await queue.flush(Number.MAX_SAFE_INTEGER);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      schemaVersion: 1,
      event: { action: 'learned', occurredAt: 10, rule: { id: 'rule-learned', version: 1, origin: 'learned' } },
    });
    expect(queue.status()).toMatchObject({ pending: 0, failed: 0, succeeded: 1 });
  });

  it('persists failed work and retries it after a restart', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rule-sync-retry-'));
    directories.push(directory);
    const queuePath = path.join(directory, 'queue.json');
    const config = { url: 'https://sync.example/rules', apiKey: 'test-key', timeoutMs: 1_000 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const firstProcess = new FileRuleSyncQueue(config, queuePath);
    firstProcess.enqueue({ action: 'learned', rule: learnedRule, occurredAt: 10 });

    await firstProcess.flush(Number.MAX_SAFE_INTEGER);
    expect(firstProcess.status()).toMatchObject({ pending: 0, failed: 1, succeeded: 0 });

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const restartedProcess = new FileRuleSyncQueue(config, queuePath);
    await restartedProcess.flush(Number.MAX_SAFE_INTEGER);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(restartedProcess.status()).toMatchObject({ pending: 0, failed: 0, succeeded: 1 });
  });
});
