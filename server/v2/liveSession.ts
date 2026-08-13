import type { ComplianceAnalyzer } from '../../src/compliance/engine';
import { analyzeTranscript } from '../../src/compliance/engine';
import type { CoachPurpose, ComplianceResult, ComplianceRule, Product, SpeakerLabel, TranscriptSegment } from '../../src/shared/types';
import type { LiveCommand, LiveEvent, LiveSessionListener, LiveSessionSnapshot } from '../../src/shared/v2';
import type { AudioTrack } from '../../src/shared/v2Audio';
import type { CoachProvider } from '../providers/doubaoCoach';
import { findMentionedProduct } from '../productMentionMatcher';
import { BoundedScheduler } from './scheduler';
import { SqliteFactStore, type SessionCreation } from './store';
import { RealtimeReviewPipeline, type RealtimeReviewTiming } from './realtimeReviewPipeline';
import { SpeakerDiarizer, type SpeakerAssignment } from '../speakerDiarizer';
import { buildRiskContext } from '../compliance/contextWindow';

export type CapturePort = {
  start(): void;
  pause(): void;
  resume(): void;
  end(): Promise<void>;
  pushAudio(pcm: Uint8Array, sampleRate: number, channels?: number, track?: AudioTrack): void;
  close?(): void;
};

export type ReviewAnalyzer = Pick<ComplianceAnalyzer, 'analyze'>;
export type AsrTranscript = { text: string; isFinal: boolean; startTimeMs?: number; endTimeMs?: number };

export type LiveSessionOptions = {
  store: SqliteFactStore;
  scheduler: BoundedScheduler;
  products: Product[] | (() => Product[]);
  session: SessionCreation;
  capture: CapturePort;
  analyzer?: ReviewAnalyzer;
  coach?: CoachProvider;
  now?: () => number;
  endingDrainTimeoutMs?: number;
  rules?: (product: Product) => ComplianceRule[];
  referencePhrases?: (presenterId: string, productId: string) => Array<{ text: string; purpose?: CoachPurpose }>;
  resolvePresenter?: (presenterId: string) => { id: string; name: string } | null;
  onComplianceResult?: (result: ComplianceResult, product: Product) => void;
  onReviewTiming?: (timing: RealtimeReviewTiming) => void;
};

const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;

function drainWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, timeoutMs);
    timer.unref();
    promise.then(() => { if (!settled) { settled = true; clearTimeout(timer); resolve(true); } }, () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } });
  });
}

function segmentId(sessionId: string, sequence: number): string {
  return `${sessionId}-segment-${sequence}`;
}

export class LiveSession {
  readonly id: string;
  private readonly store: SqliteFactStore;
  private readonly scheduler: BoundedScheduler;
  private readonly products: () => Product[];
  private readonly capture: CapturePort;
  private readonly now: () => number;
  private readonly endingDrainTimeoutMs: number;
  private readonly listeners = new Set<LiveSessionListener>();
  private snapshotValue: LiveSessionSnapshot;
  private productRevision = 0;
  /** Context sent to semantic review is scoped to the active product. */
  private productContextStartedAt = 0;
  private requestSequence = 0;
  private segmentSequence = 0;
  private readonly segmentRevisions = new Map<string, number>();
  private readonly reviewPipeline: RealtimeReviewPipeline;
  private readonly rulesProvider: (product: Product) => ComplianceRule[];
  private readonly referencePhraseProvider: (presenterId: string, productId: string) => Array<{ text: string; purpose?: CoachPurpose }>;
  private readonly presenterResolver: (presenterId: string) => { id: string; name: string } | null;
  private readonly speakerDiarizer = new SpeakerDiarizer();
  private readonly speakerBindings = new Map<string, SpeakerLabel>();
  private audioOffsetMs = 0;
  private endingPromise: Promise<void> | null = null;

  constructor(options: LiveSessionOptions) {
    this.store = options.store;
    this.scheduler = options.scheduler;
    this.products = typeof options.products === 'function' ? options.products : () => options.products as Product[];
    this.capture = options.capture;
    this.now = options.now ?? Date.now;
    this.endingDrainTimeoutMs = options.endingDrainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.rulesProvider = options.rules ?? (() => []);
    this.referencePhraseProvider = options.referencePhrases ?? (() => []);
    this.presenterResolver = options.resolvePresenter ?? ((presenterId) => presenterId === options.session.presenterId ? { id: presenterId, name: options.session.presenterName } : null);
    this.id = options.session.sessionId;
    const existing = this.store.getSessionSnapshot(this.id);
    this.store.createSession(options.session);
    this.snapshotValue = this.store.getSessionSnapshot(this.id)!;
    this.productContextStartedAt = this.snapshotValue.createdAt;
    this.segmentSequence = this.snapshotValue.transcriptHistory.reduce((maximum, segment) => {
      const match = segment.id.match(/-segment-(\d+)$/u);
      return Math.max(maximum, match ? Number(match[1]) : 0);
    }, this.snapshotValue.transcriptHistory.length);
    this.requestSequence = this.snapshotValue.transcriptHistory.length;
    if (existing?.lifecycle === 'live' || existing?.lifecycle === 'ending') {
      this.store.appendSessionEvent(this.id, { type: 'capture.error', occurredAt: this.now(), payload: { message: '服务已恢复，请确认麦克风后继续收音', recoveredFrom: existing.lifecycle } });
      this.snapshotValue = this.store.getSessionSnapshot(this.id)!;
    }
    this.reviewPipeline = new RealtimeReviewPipeline({
      sessionId: this.id,
      scheduler: this.scheduler,
      analyzer: options.analyzer ?? { analyze: analyzeTranscript },
      coach: options.coach ?? null,
      now: this.now,
      isProductSegmentCurrent: (token) => token.productRevision === this.productRevision && token.segmentRevision === (this.segmentRevisions.get(token.segmentId) ?? 0),
      isLatest: (token) => token.requestSequence === this.requestSequence && token.productRevision === this.productRevision && token.segmentRevision === (this.segmentRevisions.get(token.segmentId) ?? 0),
      onCompliance: (result, latest, product) => { this.commit('compliance.updated', { result: JSON.stringify(result), product: JSON.stringify(product), segmentId: result.segmentId, latest }); options.onComplianceResult?.(result, product); },
      onCoach: (segmentIdValue, suggestions, pending) => this.commit('coach.updated', { segmentId: segmentIdValue, suggestions: JSON.stringify(suggestions), pending }),
      onTiming: options.onReviewTiming,
    });
  }

  snapshot(): LiveSessionSnapshot {
    return structuredClone(this.snapshotValue);
  }

  subscribe(listener: LiveSessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispatch(command: LiveCommand): Promise<void> {
    switch (command.type) {
      case 'start':
        if (this.snapshotValue.lifecycle === 'idle') {
          this.speakerDiarizer.reset();
          this.speakerBindings.clear();
          this.audioOffsetMs = 0;
          this.commit('lifecycle.changed', { lifecycle: 'live' });
          this.capture.start();
        } else if (this.snapshotValue.lifecycle === 'paused') {
          await this.dispatch({ type: 'resume' });
        }
        return;
      case 'pause':
        if (this.snapshotValue.lifecycle !== 'live') return;
        this.capture.pause();
        this.commit('lifecycle.changed', { lifecycle: 'paused' });
        return;
      case 'resume':
        if (this.snapshotValue.lifecycle !== 'paused') return;
        this.capture.resume();
        this.commit('lifecycle.changed', { lifecycle: 'live' });
        return;
      case 'end':
      case 'stop':
        await this.end();
        return;
      case 'select_product':
        this.selectProduct(command.productId, command.source ?? 'operator');
        return;
      case 'set_lineup':
        this.setLineup(command.productIds);
        return;
      case 'catalog_sync':
        this.commit('catalog.updated', { products: JSON.stringify(command.products) });
        return;
      case 'set_risk_profile':
        if (this.snapshotValue.riskProfile !== command.profile) this.commit('risk_profile.changed', { profile: command.profile });
        return;
      case 'select_presenter':
        {
          const presenter = this.presenterResolver(command.presenterId);
          if (!presenter) throw new Error('主播不存在或不属于当前直播间');
          this.commit('presenter.selected', { presenterId: presenter.id, presenterName: presenter.name });
        }
        return;
      case 'demo_transcript':
        await this.ingestTranscript(command.text, command.isFinal ?? true);
        return;
      case 'transcript_correct':
        this.correctTranscript(command.segmentId, command.text);
        return;
      case 'assign_speaker':
        this.assignSpeaker(command.segmentId, command.speaker, command.speakerId);
        return;
      case 'audio':
        if (this.snapshotValue.lifecycle === 'live') {
          const channels = command.channels ?? 1;
          const track = command.track ?? 'asr';
          if (track === 'asr') {
            this.speakerDiarizer.pushAudio(Buffer.from(command.pcm), this.audioOffsetMs);
            this.audioOffsetMs += command.pcm.byteLength / Math.max(1, command.sampleRate * channels * 2) * 1_000;
          }
          this.capture.pushAudio(command.pcm, command.sampleRate, channels, track);
        }
        return;
    }
  }

  receiveAsr(result: AsrTranscript): void {
    const assignment = result.isFinal ? this.speakerDiarizer.assign(result.startTimeMs ?? null, result.endTimeMs ?? null, this.audioOffsetMs) : null;
    void this.ingestTranscript(result.text, result.isFinal, { ...result, assignment });
  }

  captureFailure(error: Error): void {
    if (this.snapshotValue.lifecycle === 'ended' || this.snapshotValue.lifecycle === 'ending') return;
    this.commit('capture.error', { message: error.message });
  }

  private end(): Promise<void> {
    if (this.snapshotValue.lifecycle === 'idle' || this.snapshotValue.lifecycle === 'ended') return Promise.resolve();
    if (this.endingPromise) return this.endingPromise;
    const promise = this.finishEnd();
    this.endingPromise = promise;
    const clear = () => { if (this.endingPromise === promise) this.endingPromise = null; };
    void promise.then(clear, clear);
    return promise;
  }

  private async finishEnd(): Promise<void> {
    if (this.snapshotValue.lifecycle !== 'ending') this.commit('lifecycle.changed', { lifecycle: 'ending' });
    const drained = await drainWithin(this.capture.end(), this.endingDrainTimeoutMs);
    if (!drained) this.commit('capture.error', { message: 'ASR 排空超时，已保留已收到的最后转录' });
    this.commit('session.ended', { drained });
    this.commit('lifecycle.changed', { lifecycle: 'ended' });
  }

  private selectProduct(productId: string, source: 'operator' | 'speech'): void {
    const product = this.snapshotValue.lineup.find((candidate) => candidate.id === productId) ?? this.products().find((candidate) => candidate.id === productId);
    if (!product || this.snapshotValue.product.id === product.id) return;
    this.productRevision += 1;
    this.productContextStartedAt = this.now();
    this.commit('product.selected', { product: JSON.stringify(product), source });
  }

  private setLineup(productIds: string[]): void {
    const products = this.products();
    const lineup = productIds.map((id) => products.find((product) => product.id === id)).filter((product): product is Product => Boolean(product));
    if (lineup.length === 0) return;
    const refreshedActiveProduct = lineup.find((product) => product.id === this.snapshotValue.product.id);
    if (!refreshedActiveProduct || JSON.stringify(refreshedActiveProduct) !== JSON.stringify(this.snapshotValue.product)) {
      this.productRevision += 1;
      this.productContextStartedAt = this.now();
    }
    this.commit('lineup.updated', { lineup: JSON.stringify(lineup) });
    if (!lineup.some((product) => product.id === this.snapshotValue.product.id)) this.selectProduct(lineup[0].id, 'operator');
  }

  private async ingestTranscript(rawText: string, isFinal: boolean, timing: Pick<AsrTranscript, 'startTimeMs' | 'endTimeMs'> & { assignment?: SpeakerAssignment | null } = {}): Promise<void> {
    const text = rawText.trim();
    if (!text || (this.snapshotValue.lifecycle !== 'live' && this.snapshotValue.lifecycle !== 'paused' && this.snapshotValue.lifecycle !== 'ending')) return;
    const now = this.now();
    const id = segmentId(this.id, ++this.segmentSequence);
    const startOffsetMs = typeof timing.startTimeMs === 'number' ? timing.startTimeMs : null;
    const endOffsetMs = typeof timing.endTimeMs === 'number' ? timing.endTimeMs : null;
    const boundSpeaker = timing.assignment ? this.speakerBindings.get(timing.assignment.speakerId) : undefined;
    const segment: TranscriptSegment = {
      id, text, isFinal, timestamp: now, offsetMs: endOffsetMs, startOffsetMs, endOffsetMs,
      speaker: boundSpeaker ?? 'host',
      ...(timing.assignment ? { speakerId: timing.assignment.speakerId, speakerSource: boundSpeaker ? 'manual' : timing.assignment.source, speakerConfidence: boundSpeaker ? 1 : timing.assignment.confidence } : { speakerSource: 'default' as const, speakerConfidence: 0.5 }),
    };
    if (!isFinal) {
      this.commit('transcript.partial', { text, segment: JSON.stringify(segment) });
      return;
    }
    // Product auto-switching follows the host only. A guest or operator may
    // mention another SKU while answering questions; that must not change the
    // active product context used for risk rules and coaching.
    const mentioned = segment.speaker !== 'other' ? findMentionedProduct(text, this.snapshotValue.lineup) : null;
    if (mentioned && mentioned.product.id !== this.snapshotValue.product.id) this.selectProduct(mentioned.product.id, 'speech');
    const product = this.snapshotValue.product;
    const requestNumber = ++this.requestSequence;
    const productGeneration = this.productRevision;
    const revision = this.segmentRevisions.get(id) ?? 0;
    this.commit('transcript.final', { segment: JSON.stringify(segment), productId: product.id });
    const productContext = buildRiskContext(this.snapshotValue.transcriptHistory, this.productContextStartedAt, now);
    await this.reviewPipeline.process({
      token: { requestSequence: requestNumber, productRevision: productGeneration, segmentRevision: revision, segmentId: id },
      segment,
      product,
      roomId: this.snapshotValue.roomId,
      riskProfile: this.snapshotValue.riskProfile,
      context: productContext,
      stats: this.snapshotValue.stats,
      customRules: this.rulesProvider(product),
      referencePhrases: this.referencePhraseProvider(this.snapshotValue.presenterId, product.id),
    });
  }

  private correctTranscript(segmentIdValue: string, text: string): void {
    const original = this.snapshotValue.transcriptHistory.find((segment) => segment.id === segmentIdValue);
    if (!original || !text.trim()) return;
    this.segmentRevisions.set(segmentIdValue, (this.segmentRevisions.get(segmentIdValue) ?? 0) + 1);
    this.commit('transcript.corrected', { segmentId: segmentIdValue, text: text.trim(), originalText: original.text });
  }

  private assignSpeaker(segmentIdValue: string, speaker: SpeakerLabel, speakerId?: string): void {
    const target = this.snapshotValue.transcriptHistory.find((segment) => segment.id === segmentIdValue);
    if (!target) return;
    const boundId = speakerId ?? target.speakerId;
    if (boundId) this.speakerBindings.set(boundId, speaker);
    const segmentIds = boundId ? this.snapshotValue.transcriptHistory.filter((segment) => segment.speakerId === boundId).map((segment) => segment.id) : [segmentIdValue];
    this.commit('speaker.assigned', { segmentId: segmentIdValue, segmentIds, speaker, ...(boundId ? { speakerId: boundId } : {}) });
  }

  private commit(type: LiveEvent['type'], payload: Record<string, unknown>): LiveEvent {
    const event = this.store.appendSessionEvent(this.id, { type, occurredAt: this.now(), payload });
    this.snapshotValue = this.store.getSessionSnapshot(this.id)!;
    for (const listener of this.listeners) {
      try {
        listener(event, this.snapshot());
      } catch (error) {
        console.error('[live-session-listener]', JSON.stringify({ sessionId: this.id, eventType: event.type, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    return event;
  }
}
