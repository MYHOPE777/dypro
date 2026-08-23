import type { ComplianceResult, CoachSuggestion, Product, TranscriptAnnotation, TranscriptSegment } from '../../src/shared/types';
import type { LiveEvent, LiveLifecycle, LiveSessionSnapshot } from '../../src/shared/v2';

export type SessionEventKernelContext = {
  previousCompliance?: ComplianceResult | null;
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boolValue(value: unknown): boolean {
  return value === 1 || value === true;
}

function decrementRiskCount(snapshot: LiveSessionSnapshot, risk: ComplianceResult['risk']): void {
  const key = `${risk}Count` as 'safeCount' | 'warningCount' | 'blockedCount';
  snapshot.stats[key] = Math.max(0, snapshot.stats[key] - 1);
}

function incrementRiskCount(snapshot: LiveSessionSnapshot, risk: ComplianceResult['risk']): void {
  const key = `${risk}Count` as 'safeCount' | 'warningCount' | 'blockedCount';
  snapshot.stats[key] += 1;
}

/**
 * Deterministic session projection reducer. It has no SQLite knowledge; the
 * store supplies only the previous compliance result needed to update counts.
 */
export function reduceSessionSnapshot(snapshot: LiveSessionSnapshot, event: LiveEvent, context: SessionEventKernelContext = {}): LiveSessionSnapshot {
  const payload = event.payload;
  switch (event.type) {
    case 'lifecycle.changed': {
      snapshot.lifecycle = (payload.lifecycle as LiveLifecycle) ?? snapshot.lifecycle;
      if (snapshot.lifecycle === 'ended') snapshot.partialTranscript = '';
      break;
    }
    case 'product.selected': {
      const product = parseJson<Product | null>(payload.product, null);
      if (product) {
        snapshot.product = product;
        snapshot.latestCompliance = null;
        snapshot.coachSuggestions = [];
        snapshot.coachPending = false;
      }
      break;
    }
    case 'lineup.updated': {
      const lineup = parseJson<Product[]>(payload.lineup, []);
      if (lineup.length) {
        snapshot.lineup = lineup;
        snapshot.product = lineup.find((product) => product.id === snapshot.product.id) ?? snapshot.product;
        snapshot.latestCompliance = null;
        snapshot.coachSuggestions = [];
        snapshot.coachPending = false;
      }
      break;
    }
    case 'risk_profile.changed':
      if (payload.profile === 'strict' || payload.profile === 'balanced' || payload.profile === 'optimized') snapshot.riskProfile = payload.profile;
      break;
    case 'presenter.selected':
      snapshot.presenterId = stringValue(payload.presenterId, snapshot.presenterId);
      snapshot.presenterName = stringValue(payload.presenterName, snapshot.presenterName);
      break;
    case 'transcript.partial':
      snapshot.partialTranscript = stringValue(payload.text);
      break;
    case 'transcript.final': {
      const segment = parseJson<TranscriptSegment | null>(payload.segment, null);
      if (segment) {
        snapshot.partialTranscript = '';
        snapshot.transcriptHistory = [...snapshot.transcriptHistory.filter((candidate) => candidate.id !== segment.id), segment].slice(-80);
        snapshot.stats.words += segment.text.replace(/\s/g, '').length;
        const offset = segment.endOffsetMs ?? segment.offsetMs;
        if (offset !== null && offset !== undefined) snapshot.stats.speakingSeconds = Math.max(snapshot.stats.speakingSeconds, Math.round(offset / 1_000));
      }
      break;
    }
    case 'transcript.corrected': {
      const segmentId = stringValue(payload.segmentId);
      const text = stringValue(payload.text);
      snapshot.transcriptHistory = snapshot.transcriptHistory.map((segment) => segment.id === segmentId ? { ...segment, text } : segment);
      snapshot.contentRevision += 1;
      break;
    }
    case 'transcript.annotated': {
      const annotation = parseJson<TranscriptAnnotation | null>(payload.annotation, null);
      if (annotation) {
        snapshot.transcriptAnnotations = [...snapshot.transcriptAnnotations.filter((item) => item.id !== annotation.id), annotation].slice(-80);
        snapshot.contentRevision += 1;
      }
      break;
    }
    case 'transcript.annotation_resolved': {
      const annotationId = stringValue(payload.annotationId);
      const status = payload.disposition === 'confirmed' ? 'confirmed' : payload.disposition === 'dismissed' ? 'dismissed' : null;
      if (annotationId && status) {
        snapshot.transcriptAnnotations = snapshot.transcriptAnnotations.map((annotation) => annotation.id === annotationId
          ? { ...annotation, status, ...(typeof payload.ruleId === 'string' ? { ruleId: payload.ruleId } : {}), updatedAt: event.occurredAt }
          : annotation);
      }
      break;
    }
    case 'speaker.assigned': {
      const segmentId = stringValue(payload.segmentId);
      const segmentIds = Array.isArray(payload.segmentIds) ? payload.segmentIds.filter((value): value is string => typeof value === 'string') : [segmentId];
      const speaker = payload.speaker === 'other' ? 'other' : 'host';
      const speakerName = typeof payload.speakerName === 'string' && payload.speakerName.trim() ? payload.speakerName.trim() : undefined;
      snapshot.transcriptHistory = snapshot.transcriptHistory.map((segment) => segmentIds.includes(segment.id) ? { ...segment, speaker, speakerSource: 'manual', speakerConfidence: 1, ...(typeof payload.speakerId === 'string' ? { speakerId: payload.speakerId } : {}), ...(speakerName ? { speakerName } : {}) } : segment);
      snapshot.contentRevision += 1;
      break;
    }
    case 'compliance.updated': {
      const annotation = parseJson<TranscriptAnnotation | null>(payload.annotation, null);
      if (annotation) {
        snapshot.transcriptAnnotations = [...snapshot.transcriptAnnotations.filter((item) => item.id !== annotation.id), annotation].slice(-80);
        snapshot.contentRevision += 1;
      }
      const result = parseJson<ComplianceResult | null>(payload.result, null);
      if (result) {
        if (context.previousCompliance) decrementRiskCount(snapshot, context.previousCompliance.risk);
        if (payload.latest !== false) snapshot.latestCompliance = result;
        snapshot.alerts = snapshot.alerts.filter((alert) => alert.segmentId !== result.segmentId);
        if (result.risk !== 'safe') snapshot.alerts = [result, ...snapshot.alerts].slice(0, 20);
        incrementRiskCount(snapshot, result.risk);
      }
      break;
    }
    case 'coach.updated':
      snapshot.coachSuggestions = parseJson<CoachSuggestion[]>(payload.suggestions, []);
      snapshot.coachPending = boolValue(payload.pending);
      break;
    case 'capture.error':
      snapshot.lifecycle = 'paused';
      snapshot.partialTranscript = '';
      break;
    case 'review.edited': {
      const contentRevision = numberValue(payload.contentRevision);
      if (contentRevision > 0) snapshot.contentRevision = Math.max(snapshot.contentRevision, contentRevision);
      const segmentId = stringValue(payload.segmentId);
      const segment = parseJson<TranscriptSegment | null>(payload.segment, null);
      if (segment && segmentId) snapshot.transcriptHistory = snapshot.transcriptHistory.map((candidate) => candidate.id === segmentId ? segment : candidate);
      break;
    }
    case 'session.created':
    case 'session.ended':
      break;
  }
  snapshot.latestSequence = event.sequence;
  snapshot.updatedAt = event.occurredAt;
  return snapshot;
}

