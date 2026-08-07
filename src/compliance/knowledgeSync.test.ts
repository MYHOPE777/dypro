import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileKnowledgeSyncQueue } from '../../server/knowledgeSync';
import type { ComplianceRule } from '../shared/types';
import type { KnowledgeBaseIndexer } from '../../server/knowledgeBase';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const rule: ComplianceRule = {
  id: 'rule-1', roomId: 'room-default', scope: 'shared', name: '内部规则', matchType: 'contains', pattern: '第一', risk: 'warning', title: '不要说第一', reason: '需要证据', alternative: '可以改为：受到很多用户关注', policyRef: '内部案例', enabled: true, status: 'published', version: 1, createdBy: 'owner', approvedBy: 'owner', createdAt: 1, updatedAt: 1,
};

function createIndexer() {
  return { indexStatus: () => ({ configured: true, available: true, label: 'ok', detail: 'ok' }), index: vi.fn().mockResolvedValue(undefined) } satisfies KnowledgeBaseIndexer;
}

describe('FileKnowledgeSyncQueue', () => {
  it('queues only published rules and retries a failed index task', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'knowledge-sync-'));
    directories.push(directory);
    const indexer = createIndexer();
    indexer.index.mockRejectedValueOnce(new Error('暂时不可用')).mockResolvedValue(undefined);
    const queue = new FileKnowledgeSyncQueue(indexer, path.join(directory, 'sync.json'));

    expect(queue.enqueue({ ...rule, status: 'pending_review' })).toBe(false);
    expect(queue.enqueue(rule)).toBe(true);
    const startedAt = Date.now();
    await queue.flush(startedAt);
    expect(queue.status()).toMatchObject({ failed: 1, pending: 0 });
    await queue.flush(startedAt + 1_000);
    expect(queue.status()).toMatchObject({ succeeded: 0, failed: 1 });
    await queue.flush(startedAt + 5_000);
    expect(queue.status()).toMatchObject({ succeeded: 1, failed: 0 });
    expect(indexer.index).toHaveBeenCalledTimes(2);
  });

  it('keeps tasks pending while the indexer is not configured', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'knowledge-sync-'));
    directories.push(directory);
    const indexer = { indexStatus: () => ({ configured: false, available: true, label: '待配置', detail: '待配置' }), index: vi.fn() } satisfies KnowledgeBaseIndexer;
    const queue = new FileKnowledgeSyncQueue(indexer, path.join(directory, 'sync.json'));
    queue.enqueue(rule);
    await queue.flush();
    expect(queue.status()).toMatchObject({ pending: 1, configured: false });
    expect(indexer.index).not.toHaveBeenCalled();
  });

  it('retries an unavailable indexer and can remove a rule that left published state', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'knowledge-sync-'));
    directories.push(directory);
    const indexer = { indexStatus: () => ({ configured: true, available: false, label: '上次失败', detail: '后台重试' }), index: vi.fn().mockResolvedValue(undefined) } satisfies KnowledgeBaseIndexer;
    const queue = new FileKnowledgeSyncQueue(indexer, path.join(directory, 'sync.json'));

    expect(queue.enqueue({ ...rule, status: 'pending_review' }, undefined, 'remove')).toBe(true);
    await queue.flush();
    expect(indexer.index).toHaveBeenCalledWith(expect.objectContaining({ operation: 'remove', rule: expect.objectContaining({ id: rule.id, status: 'pending_review' }) }));
    expect(queue.status().succeeded).toBe(1);
  });

  it('re-indexes a rule after disable and re-enable without a content version change', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'knowledge-sync-'));
    directories.push(directory);
    const indexer = createIndexer();
    const queue = new FileKnowledgeSyncQueue(indexer, path.join(directory, 'sync.json'));

    expect(queue.enqueue(rule)).toBe(true);
    await queue.flush();
    expect(queue.enqueue({ ...rule, enabled: false, updatedAt: 2 })).toBe(true);
    await queue.flush();
    expect(queue.enqueue({ ...rule, enabled: true, updatedAt: 3 })).toBe(true);
    await queue.flush();

    expect(indexer.index.mock.calls.map(([document]) => document.operation)).toEqual(['upsert', 'remove', 'upsert']);
  });
});
