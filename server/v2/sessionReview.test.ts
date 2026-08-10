import { describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT } from '../../src/shared/products';
import type { TranscriptSegment } from '../../src/shared/types';
import { SqliteFactStore } from './store';
import { SessionReviewModule } from './sessionReview';

const transcript: TranscriptSegment = { id: 'segment-1', text: '原始文本', isFinal: true, timestamp: 10, offsetMs: 10, startOffsetMs: 0, endOffsetMs: 10, speaker: 'host', speakerSource: 'default', speakerConfidence: 0.5 };

describe('SessionReviewModule', () => {
  it('revokes approval after an edit and only queues the approved revision', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    store.createSession({ sessionId: 'review-session', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '主播', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT] });
    store.appendSessionEvent('review-session', { type: 'transcript.final', occurredAt: 10, payload: { segment: JSON.stringify(transcript) } });
    store.appendSessionEvent('review-session', { type: 'lifecycle.changed', occurredAt: 20, payload: { lifecycle: 'ended' } });
    const review = new SessionReviewModule(store);

    const first = review.approveDelivery('review-session', 'operator-a');
    expect(first.idempotencyKey).toBe('review-session:0');
    expect(review.getReview('review-session')?.approval).toBe('approved');
    expect(review.getReview('review-session')?.delivery).toBe('queued');

    const edited = review.correctTranscript('review-session', 'segment-1', '修正文本', 'operator-a');
    expect(edited.contentRevision).toBe(1);
    expect(review.getReview('review-session')?.approval).toBe('approval_required');
    expect(review.getReview('review-session')?.delivery).toBe('superseded');

    expect(() => review.approveDelivery('review-session', 'operator-a')).not.toThrow();
    const repeated = review.approveDelivery('review-session', 'operator-a');
    expect(repeated.idempotencyKey).toBe('review-session:1');
    expect(repeated.id).toBe(review.approveDelivery('review-session', 'operator-a').id);
    store.close();
  });

  it('keeps a synced revision synced when approval is repeated', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    store.createSession({ sessionId: 'review-synced', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '主播', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT] });
    store.appendSessionEvent('review-synced', { type: 'lifecycle.changed', occurredAt: 20, payload: { lifecycle: 'ended' } });
    const review = new SessionReviewModule(store);
    review.approveDelivery('review-synced', 'reviewer');
    store.updateDeliveryJob('review-synced:0', 'uploading', null, 30);
    store.settleDeliveryJob('review-synced:0', 'synced', null, 40);

    const repeated = review.approveDelivery('review-synced', 'reviewer');

    expect(repeated.status).toBe('synced');
    expect(review.getReview('review-synced')?.delivery).toBe('synced');
    store.close();
  });

  it('learns a reusable room correction from historical transcript edits', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    store.createSession({ sessionId: 'correction-session', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '主播', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT] });
    store.appendSessionEvent('correction-session', { type: 'transcript.final', occurredAt: 10, payload: { segment: JSON.stringify({ ...transcript, text: '请检查蓝牙卖克风' }) } });
    store.appendSessionEvent('correction-session', { type: 'lifecycle.changed', occurredAt: 20, payload: { lifecycle: 'ended' } });
    const review = new SessionReviewModule(store);

    review.correctTranscript('correction-session', 'segment-1', '请检查蓝牙麦克风', 'reviewer');

    expect(store.listSpeechCorrections('room-default')).toEqual([
      expect.objectContaining({ wrongText: '蓝牙卖克风', correctText: '蓝牙麦克风', confirmations: 1, enabled: true }),
    ]);
    expect(store.applySpeechCorrections('room-default', '现在使用蓝牙卖克风直播').text).toBe('现在使用蓝牙麦克风直播');
    store.close();
  });

  it('persists speaker assignment and notes as review edits', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    store.createSession({ sessionId: 'review-session-2', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '主播', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT] });
    store.appendSessionEvent('review-session-2', { type: 'transcript.final', occurredAt: 10, payload: { segment: JSON.stringify(transcript) } });
    const review = new SessionReviewModule(store);
    review.assignSpeaker('review-session-2', 'segment-1', 'other', 'speaker-2', 'operator-a');
    review.saveNote('review-session-2', '待复盘', 'operator-a');
    const current = review.getReview('review-session-2')!;
    expect(current.transcripts[0].speaker).toBe('other');
    expect(current.summary.note).toBe('待复盘');
    expect(current.summary.contentRevision).toBe(2);
    store.close();
  });
});
