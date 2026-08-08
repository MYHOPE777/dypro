import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LiveSession } from '../../server/session';
import { FileTimelineStore } from '../../server/timelineStore';
import type WebSocket from 'ws';
import type { ComplianceResult } from '../shared/types';

function fakeSocket() {
  return { readyState: 1, send: () => undefined } as unknown as WebSocket;
}

describe('LiveSession', () => {
  it('uses an unguessable id for a new display session', () => {
    expect(new LiveSession().id).toMatch(/^live-[a-f0-9]{24}$/u);
  });

  it('keeps the selected product as the context for the next compliance result', async () => {
    const session = new LiveSession('test-session');
    session.addClient(fakeSocket(), 'operator');
    session.selectProduct('headphones');
    session.ingestTranscript('这款耳机全网最低价，错过今天就没有了！');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.state.product.id).toBe('headphones');
    expect(session.state.latestCompliance?.productId).toBe('headphones');
    expect(session.state.latestCompliance?.risk).toBe('warning');
    expect(session.state.latestCompliance?.analysisMs).toEqual(expect.any(Number));
    expect(session.state.latestCompliance?.analysisMs).toBeGreaterThanOrEqual(0);
    expect(session.state.stats.warningCount).toBe(1);
    expect(session.state.alerts).toHaveLength(1);
  });

  it('enters listening state without provider credentials for a demo session', () => {
    const session = new LiveSession('demo-session');
    session.startListening();
    expect(session.state.isListening).toBe(true);
    session.stopListening();
    expect(session.state.isListening).toBe(false);
  });

  it('keeps capture local and enqueues the archive only after stopping', async () => {
    const enqueue = vi.fn();
    const session = new LiveSession('archive-session', { archiveQueue: { enqueue } });

    session.startListening();
    session.ingestAudio(Buffer.from([0, 0]));
    expect(enqueue).not.toHaveBeenCalled();
    session.stopListening();
    await new Promise((resolve) => setImmediate(resolve));
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith('archive-session');
  });

  it('pauses and resumes one live session without archiving until it ends', async () => {
    const enqueue = vi.fn();
    const session = new LiveSession('lifecycle-session', { archiveQueue: { enqueue } });

    session.startListening();
    expect(session.state).toMatchObject({ isListening: true, captureState: 'live' });
    session.pauseListening();
    expect(session.state).toMatchObject({ isListening: false, captureState: 'paused' });
    expect(enqueue).not.toHaveBeenCalled();

    session.resumeListening();
    expect(session.state).toMatchObject({ isListening: true, captureState: 'live' });
    session.endLive();
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.state).toMatchObject({ isListening: false, captureState: 'ended' });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('starts semantic checks concurrently and keeps the newest result current', async () => {
    const pending = new Map<string, (result: ComplianceResult) => void>();
    const analyzer = {
      analyze: vi.fn((input: { transcript: string }) => new Promise<ComplianceResult>((resolve) => pending.set(input.transcript, resolve))),
    };
    const session = new LiveSession('concurrent-analysis-session', { analyzer });
    const result = (transcript: string, risk: ComplianceResult['risk']): ComplianceResult => ({
      id: `result-${transcript}`, productId: 'serum', risk, title: risk, reason: risk, alternative: risk,
      policyRef: 'test', confidence: 0.9, source: 'doubao', transcript, createdAt: Date.now(),
    });

    session.ingestTranscript('第一句');
    session.ingestTranscript('第二句');
    await Promise.resolve();
    expect(analyzer.analyze).toHaveBeenCalledTimes(2);

    pending.get('第二句')?.(result('第二句', 'warning'));
    await Promise.resolve();
    pending.get('第一句')?.(result('第一句', 'safe'));
    await Promise.resolve();

    expect(session.state.latestCompliance?.transcript).toBe('第二句');
  });

  it('can correct a transcript that has moved out of the live history window', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'session-review-'));
    try {
      const timelineStore = new FileTimelineStore(directory);
      const session = new LiveSession('session-review-old-segment', { timelineStore });
      for (let index = 0; index < 21; index += 1) session.ingestTranscript(`第${index}句`);
      const corrected = session.correctTranscript('segment-0', '第一句', 'operator-a', { learn: false });

      expect(corrected?.text).toBe('第一句');
      expect(timelineStore.exportSession(session.id)?.events.at(-1)?.payload).toMatchObject({ segmentId: 'segment-0', correctedText: '第一句' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
