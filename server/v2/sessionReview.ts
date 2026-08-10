import type { SpeakerLabel, TranscriptSegment } from '../../src/shared/types';
import type { DeliveryJob, SessionReview, SessionSummary } from '../../src/shared/v2';
import { SqliteFactStore } from './store';

export class SessionReviewModule {
  constructor(private readonly store: SqliteFactStore) {}

  listSessions(roomId?: string): SessionSummary[] {
    return this.store.listSessionSummaries(roomId);
  }

  getReview(sessionId: string): SessionReview | null {
    return this.store.getSessionReview(sessionId);
  }

  correctTranscript(sessionId: string, segmentId: string, text: string, actorId: string): { contentRevision: number; segment: TranscriptSegment } {
    const review = this.requireReview(sessionId);
    const original = review.transcripts.find((segment) => segment.id === segmentId);
    if (!original || !text.trim()) throw new Error('转录片段不存在');
    const segment: TranscriptSegment = { ...original, text: text.trim(), timestamp: original.timestamp, isFinal: true };
    return this.store.editReviewTranscript(sessionId, segmentId, segment, actorId);
  }

  assignSpeaker(sessionId: string, segmentId: string, speaker: SpeakerLabel, speakerId: string | undefined, actorId: string): { contentRevision: number; segment: TranscriptSegment } {
    const review = this.requireReview(sessionId);
    const original = review.transcripts.find((segment) => segment.id === segmentId);
    if (!original) throw new Error('转录片段不存在');
    const segment: TranscriptSegment = { ...original, speaker, speakerSource: 'manual', speakerConfidence: 1, ...(speakerId ? { speakerId } : {}) };
    return this.store.editReviewTranscript(sessionId, segmentId, segment, actorId, 'speaker.assigned');
  }

  saveNote(sessionId: string, note: string, actorId: string): { contentRevision: number; note: string } {
    const contentRevision = this.store.editReviewNote(sessionId, note.trim(), actorId);
    return { contentRevision, note: note.trim() };
  }

  approveDelivery(sessionId: string, actorId: string): DeliveryJob {
    return this.store.approveCurrentDelivery(sessionId, actorId);
  }

  retryDelivery(sessionId: string, actorId: string): DeliveryJob {
    return this.store.retryDelivery(sessionId, actorId);
  }

  private requireReview(sessionId: string): SessionReview {
    const review = this.getReview(sessionId);
    if (!review) throw new Error('直播场次不存在');
    return review;
  }
}
