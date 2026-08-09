import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePhraseSyncQueue } from '../../server/phraseSync';
import type { PresenterPhrase } from '../shared/types';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const phrase: PresenterPhrase = {
  id: 'phrase-one', roomId: 'room-default', presenterId: 'presenter-1234567890abcd', productId: 'serum', purpose: '塑品',
  text: '主播参考话术', source: 'session', status: 'draft', version: 1, usageCount: 0, createdAt: 1, updatedAt: 1,
};

describe('phrase sync queue', () => {
  it('persists a failed phrase event and retries it after restart', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'phrase-sync-'));
    directories.push(directory);
    const queuePath = path.join(directory, 'queue.json');
    const config = { url: 'https://sync.example/phrases', apiKey: 'test-key', timeoutMs: 1_000 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const first = new FilePhraseSyncQueue(config, queuePath);
    first.enqueue({ action: 'archived', phrase, occurredAt: 10 });
    await first.flush(Number.MAX_SAFE_INTEGER);
    expect(first.status()).toMatchObject({ failed: 1, succeeded: 0 });

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const restarted = new FilePhraseSyncQueue(config, queuePath);
    await restarted.flush(Number.MAX_SAFE_INTEGER);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(restarted.status()).toMatchObject({ pending: 0, failed: 0, succeeded: 1 });
  });
});
