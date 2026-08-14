import { randomUUID } from 'node:crypto';
import type { ComplianceResult, SpeakerLabel, TranscriptAnnotation, TranscriptSegment } from '../../src/shared/types';
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

function optionalText(value: string | undefined, maximum: number, name: string): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${name}不能超过 ${maximum} 个字符`);
  return text || undefined;
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

  assignSpeaker(sessionId: string, segmentId: string, speaker: SpeakerLabel, speakerId: string | undefined, actorId: string, speakerName?: string): { contentRevision: number; segment: TranscriptSegment } {
    const review = this.requireReview(sessionId);
    const original = review.transcripts.find((segment) => segment.id === segmentId);
    if (!original) throw new Error('转录片段不存在');
    const normalizedName = speakerName?.trim().slice(0, 80) || undefined;
    const segment: TranscriptSegment = { ...original, speaker, speakerSource: 'manual', speakerConfidence: 1, ...(speakerId ? { speakerId } : {}), ...(normalizedName ? { speakerName: normalizedName } : {}) };
    return this.store.editReviewTranscript(sessionId, segmentId, segment, actorId, 'speaker.assigned');
  }

  annotateTranscript(sessionId: string, segmentId: string, input: { selectedText: string; start: number; end: number; kind: 'term' | 'sentence' | 'context'; title?: string; reason?: string; alternative?: string; policyRef?: string }, actorId: string): { annotation: TranscriptAnnotation; result: ComplianceResult } {
    const review = this.requireReview(sessionId);
    const segment = review.transcripts.find((candidate) => candidate.id === segmentId);
    const snapshot = this.store.getSessionSnapshot(sessionId);
    if (!segment || !snapshot) throw new Error('转录片段不存在');
    const product = snapshot.lineup.find((candidate) => candidate.id === segment.productId) ?? snapshot.product;
    const start = Math.max(0, Math.min(segment.text.length, Math.floor(input.start)));
    const end = Math.max(start, Math.min(segment.text.length, Math.floor(input.end)));
    const selectedText = input.selectedText.trim();
    if (selectedText.length > 2_000) throw new Error('选中文本不能超过 2000 个字符');
    if (!selectedText || segment.text.slice(start, end).trim() !== selectedText) throw new Error('选中文本与当前转录不一致，请重新选择');
    const now = Date.now();
    const annotation: TranscriptAnnotation = {
      id: `annotation-${randomUUID()}`, sessionId, segmentId, selectedText, start, end, kind: input.kind, risk: 'blocked',
      title: optionalText(input.title, 160, '违规标题') || (input.kind === 'term' ? '人工标注违规词' : '人工标注违规句'),
      reason: optionalText(input.reason, 500, '判断说明') || '主播表达被人工标注为需要拦截的风险内容',
      alternative: optionalText(input.alternative, 500, '替代表达') || '请改用不承诺功效、不绝对化的客观表达',
      policyRef: optionalText(input.policyRef, 200, '规则依据') || '直播间人工复核规则', confidence: 1, status: 'pending', actorId, createdAt: now, updatedAt: now,
    };
    const syntheticSegmentId = `${segment.id}:annotation:${annotation.id}`;
    const result: ComplianceResult = {
      id: annotation.id, segmentId: syntheticSegmentId, transcriptSegmentId: segment.id, annotationId: annotation.id, productId: product.id,
      risk: 'blocked', title: annotation.title, reason: annotation.reason, alternative: annotation.alternative, policyRef: annotation.policyRef,
      confidence: 1, source: 'manual', transcript: segment.text, matchedTerms: [selectedText], ruleKind: input.kind, evidenceStart: start, evidenceEnd: end, createdAt: now,
    };
    this.store.appendSessionEvent(sessionId, { type: 'compliance.updated', occurredAt: now, payload: { result: JSON.stringify(result), annotation: JSON.stringify(annotation), product: JSON.stringify(product), segmentId: syntheticSegmentId, latest: false } });
    return { annotation, result };
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
