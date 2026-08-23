import { describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT } from '../../src/shared/products';
import type { ComplianceResult } from '../../src/shared/types';
import type { LiveEvent, LiveSessionSnapshot } from '../../src/shared/v2';
import { reduceSessionSnapshot } from './sessionEventKernel';

function snapshot(): LiveSessionSnapshot {
  return {
    sessionId: 'kernel-session', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '主播',
    lifecycle: 'live', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT], partialTranscript: '', transcriptHistory: [], transcriptAnnotations: [],
    latestCompliance: null, alerts: [], coachSuggestions: [], coachPending: false, riskProfile: 'strict',
    stats: { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 }, contentRevision: 0, latestSequence: 0,
    createdAt: 1, updatedAt: 1,
  };
}

function event(sequence: number, type: LiveEvent['type'], payload: Record<string, unknown>): LiveEvent {
  return { sessionId: 'kernel-session', sequence, type, occurredAt: sequence, payload };
}

describe('SessionEventKernel', () => {
  it('replays transcript and review edits in sequence without database state', () => {
    const segment = { id: 'segment-1', text: '原始话术', isFinal: true, timestamp: 1, offsetMs: 1_000, startOffsetMs: 0, endOffsetMs: 1_000, speaker: 'host' as const };
    let projected = reduceSessionSnapshot(snapshot(), event(1, 'transcript.final', { segment: JSON.stringify(segment) }));
    projected = reduceSessionSnapshot(projected, event(2, 'review.edited', { segmentId: segment.id, contentRevision: 1, revision: 1, segment: JSON.stringify({ ...segment, text: '纠正后的话术' }) }));
    expect(projected.transcriptHistory[0]?.text).toBe('纠正后的话术');
    expect(projected.contentRevision).toBe(1);
    expect(projected.latestSequence).toBe(2);
  });

  it('replaces a segment risk count using the previous projection result', () => {
    const previous: ComplianceResult = { id: 'old', segmentId: 'segment-1', productId: DEFAULT_PRODUCT.id, risk: 'warning', title: '提醒', reason: '需要注意', alternative: '改为客观介绍', policyRef: '规则', confidence: 0.8, source: 'doubao', transcript: '原话', createdAt: 1 };
    const next: ComplianceResult = { ...previous, id: 'new', risk: 'blocked', title: '拦截', confidence: 0.95, createdAt: 2 };
    const initial = snapshot();
    initial.stats.warningCount = 1;
    initial.latestCompliance = previous;
    const projected = reduceSessionSnapshot(initial, event(1, 'compliance.updated', { result: JSON.stringify(next), latest: true }), { previousCompliance: previous });
    expect(projected.stats.warningCount).toBe(0);
    expect(projected.stats.blockedCount).toBe(1);
    expect(projected.latestCompliance?.risk).toBe('blocked');
    expect(projected.alerts).toHaveLength(1);
  });
});

