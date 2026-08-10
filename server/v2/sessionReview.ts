import type { SpeakerLabel, TranscriptSegment } from '../../src/shared/types';
import type { DeliveryJob, SessionReview, SessionSummary } from '../../src/shared/v2';
import { SqliteFactStore } from './store';

function deriveCorrection(originalText: string, correctedText: string): { wrongText: string; correctText: string } | undefined {
  const original = [...originalText.trim()];
  const corrected = [...correctedText.trim()];
  if (original.join('') === corrected.join('')) return undefined;
  let prefix = 0;
  while (prefix < original.length && prefix < corrected.length && original[prefix] === corrected[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < original.length - prefix && suffix < corrected.length - prefix && original[original.length - 1 - suffix] === corrected[corrected.length - 1 - suffix]) suffix += 1;
  const contextualStart = Math.max(0, prefix - 2);
  const originalEnd = Math.min(original.length, original.length - suffix + 2);
  const correctedEnd = Math.min(corrected.length, corrected.length - suffix + 2);
  const wrongText = original.slice(contextualStart, originalEnd).join('').trim();
  const correctText = corrected.slice(contextualStart, correctedEnd).join('').trim();
  return wrongText && correctText && wrongText !== correctText ? { wrongText, correctText } : undefined;
}

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
    const correction = deriveCorrection(original.text, segment.text);
    return this.store.editReviewTranscript(sessionId, segmentId, segment, actorId, 'transcript.corrected', Date.now(), correction ? { roomId: review.summary.roomId, ...correction } : undefined);
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
