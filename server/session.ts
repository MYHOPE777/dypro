import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { createDoubaoAnalyzer } from './services';
import { buildStreamingAsrContext, createDoubaoStreamingAsr, StreamingAsrProviderError, type DoubaoStreamingAsr, type StreamingAsrOptions } from './providers/doubaoStreamingAsr';
import type { TimelineWriter } from './timelineStore';
import type { RecordingArchiveQueue } from './recordingArchive';
import type { AnalysisInput, ComplianceAnalyzer } from '../src/compliance/engine';
import type { ProductCatalog } from './productCatalog';
import { findMentionedProduct } from './productMentionMatcher';
import { createDoubaoCoach, localSuggestions, type CoachInput, type CoachProvider } from './providers/doubaoCoach';
import type { RuleCatalog } from './ruleCatalog';
import type { PresenterPhraseLibrary } from './presenterPhraseLibrary';
import { deriveSpeechCorrection, type SpeechCorrectionCatalog } from './speechCorrectionCatalog';
import { DEFAULT_PRODUCT, PRODUCTS } from '../src/shared/products';
import type {
  CaptureState,
  ComplianceResult,
  Product,
  RiskProfile,
  ServerMessage,
  SessionState,
  SessionStats,
  TranscriptSegment,
  PresenterProfile,
} from '../src/shared/types';

type Client = { socket: WebSocket; role: 'operator' | 'display' };
type TranscriptTiming = { startTimeMs?: number; endTimeMs?: number };
type LiveSessionOptions = {
  timelineStore?: TimelineWriter;
  productCatalog?: ProductCatalog;
  ruleCatalog?: RuleCatalog;
  speechCorrectionCatalog?: SpeechCorrectionCatalog;
  archiveQueue?: RecordingArchiveQueue;
  analyzer?: ComplianceAnalyzer;
  coach?: CoachProvider;
  streamingAsrFactory?: (options: StreamingAsrOptions) => DoubaoStreamingAsr | null;
  roomId?: string;
  actorId?: string;
  now?: () => number;
  riskProfile?: RiskProfile;
  phraseLibrary?: PresenterPhraseLibrary;
  presenter?: PresenterProfile;
};

const AUDIO_CHUNK_BYTES = 256 * 1024;
const SPEECH_RECOVERY_DELAYS_MS = [250, 500, 1_000] as const;
const SPEECH_RECOVERY_STABLE_MS = 30_000;

function isNextPacketTimeout(error: Error): boolean {
  return /45000081|Timeout waiting next packet|waiting next packet timeout/iu.test(error.message);
}

function speechFailurePayload(error: Error): Record<string, unknown> {
  const code = /(?:错误|error)\s*(\d{8})/iu.exec(error.message)?.[1];
  const logId = error instanceof StreamingAsrProviderError
    ? error.diagnostics.logId
    : /Logid\s+([^）)]+)/iu.exec(error.message)?.[1];
  return {
    message: error.message,
    ...(code ? { providerCode: code } : {}),
    ...(logId ? { logId } : {}),
    ...(error instanceof StreamingAsrProviderError ? { diagnostics: error.diagnostics } : {}),
  };
}

function speechFailureMessage(error: Error): string {
  if (/45000292|quota exceeded for types:\s*concurrency/iu.test(error.message)) {
    return '语音识别并发额度已满，本场已暂停。请关闭其他正在收音的会话；若控制台并发额度为 0，请开通额度或切换到已开通的小时版资源。';
  }
  if (isNextPacketTimeout(error)) {
    return '语音识别连续恢复失败，本场已暂停。请确认网络和麦克风正常后，再点击“继续收音”。';
  }
  return '语音识别连接异常，本场已暂停。请确认网络正常后，再点击“继续收音”。';
}

function createStats(): SessionStats {
  return { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 };
}

export class LiveSession {
  readonly id: string;
  readonly roomId: string;
  readonly createdAt: number;
  private readonly clients = new Set<Client>();
  private readonly analyzer: ComplianceAnalyzer;
  private readonly coach: CoachProvider;
  private readonly streamingAsrFactory: NonNullable<LiveSessionOptions['streamingAsrFactory']>;
  private speechStream: DoubaoStreamingAsr | null = null;
  private drainingSpeechStream: DoubaoStreamingAsr | null = null;
  private speechDrainTimer: NodeJS.Timeout | null = null;
  private speechRecoveryTimer: NodeJS.Timeout | null = null;
  private speechRecoveryResetTimer: NodeJS.Timeout | null = null;
  private speechRecoveryAttempt = 0;
  private speechRecoveryStartedAt: number | null = null;
  private segmentNumber = 0;
  private productGeneration = 0;
  private analysisRequestNumber = 0;
  private latestAnalysisRequest = 0;
  private coachRequestNumber = 0;
  private readonly complianceBySegment = new Map<string, ComplianceResult>();
  private readonly segmentRevisions = new Map<string, number>();
  private readonly timelineStore?: TimelineWriter;
  private readonly productCatalog?: ProductCatalog;
  private readonly ruleCatalog?: RuleCatalog;
  private readonly phraseLibrary?: PresenterPhraseLibrary;
  private presenter?: PresenterProfile;
  private readonly speechCorrectionCatalog?: SpeechCorrectionCatalog;
  private readonly archiveQueue?: RecordingArchiveQueue;
  private readonly actorId: string;
  private readonly now: () => number;
  private recordingStartedAt: number | null = null;
  private currentCaptureOffsetMs: number | null = null;
  private currentCaptureSampleOffset = 0;
  private audioWriteQueue: Promise<void> = Promise.resolve();
  private pendingAsrAudioBytes = 0;
  private pendingAsrChunk: Buffer[] = [];
  private pendingAsrChunkBytes = 0;
  private pendingSourceChunks = new Map<number, { buffers: Buffer[]; byteLength: number }>();
  private stateValue: SessionState;

  constructor(id = `live-${randomUUID().replaceAll('-', '').slice(0, 24)}`, options: LiveSessionOptions = {}) {
    this.id = id;
    this.timelineStore = options.timelineStore;
    this.productCatalog = options.productCatalog;
    this.ruleCatalog = options.ruleCatalog;
    this.phraseLibrary = options.phraseLibrary;
    this.presenter = options.presenter;
    this.speechCorrectionCatalog = options.speechCorrectionCatalog;
    this.archiveQueue = options.archiveQueue;
    this.analyzer = options.analyzer ?? createDoubaoAnalyzer();
    this.coach = options.coach ?? createDoubaoCoach();
    this.streamingAsrFactory = options.streamingAsrFactory ?? createDoubaoStreamingAsr;
    this.roomId = options.roomId ?? 'room-default';
    this.actorId = options.actorId ?? 'owner';
    this.now = options.now ?? Date.now;
    const persistedTiming = this.timelineStore?.getSessionTiming(id) ?? { createdAt: null, recordingStartedAt: null };
    this.createdAt = persistedTiming.createdAt ?? this.now();
    this.recordingStartedAt = persistedTiming.recordingStartedAt;
    const lineup = this.productCatalog?.getLineup(id, this.roomId) ?? PRODUCTS;
    const initialProduct = lineup[0] ?? DEFAULT_PRODUCT;
    this.stateValue = {
      sessionId: id,
      roomId: this.roomId,
      presenterId: this.presenter?.id ?? 'presenter-default',
      presenterName: this.presenter?.name ?? '默认主播',
      product: initialProduct,
      lineup,
      isListening: false,
      captureState: 'idle',
      partialTranscript: '',
      transcriptHistory: [],
      latestCompliance: null,
      coachSuggestion: null,
      coachSuggestions: [],
      coachPending: false,
      riskProfile: options.riskProfile ?? 'balanced',
      productContextStartedAt: this.createdAt,
      alerts: [],
      stats: createStats(),
      lastEventAt: this.createdAt,
    };
    if (persistedTiming.createdAt === null) {
      this.recordTimeline('session.created', this.createdAt, null, initialProduct.id, { roomId: this.roomId, actorId: this.actorId, presenterId: this.presenter?.id ?? 'presenter-default', presenterName: this.presenter?.name ?? '默认主播', product: initialProduct, lineupProductIds: lineup.map((product) => product.id) });
    } else {
      this.restorePersistedState();
    }
  }

  get state(): SessionState {
    return structuredClone(this.stateValue);
  }

  addClient(socket: WebSocket, role: Client['role']): void {
    this.clients.add({ socket, role });
  }

  removeClient(socket: WebSocket): void {
    for (const client of this.clients) {
      if (client.socket === socket) this.clients.delete(client);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async waitForPersistence(): Promise<void> {
    await this.audioWriteQueue;
  }

  products(): Product[] {
    return structuredClone(this.stateValue.lineup);
  }

  selectProduct(productId: string): void {
    const product = this.stateValue.lineup.find((item) => item.id === productId);
    if (!product) return;
    this.applyProductSelection(product, this.now(), { selectionSource: 'manual' });
  }

  setRiskProfile(profile: RiskProfile, actorId = this.actorId): void {
    if (this.stateValue.riskProfile === profile) return;
    const occurredAt = this.now();
    this.stateValue.riskProfile = profile;
    this.stateValue.lastEventAt = occurredAt;
    this.recordTimeline('risk.profile.changed', occurredAt, this.offsetAt(occurredAt), this.stateValue.product.id, { profile, actorId });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    const label = profile === 'strict' ? '严审' : profile === 'optimized' ? '优化' : '均衡';
    this.status(`本场风险档位已切换为${label}`, 'success');
  }

  setPresenter(presenter: PresenterProfile, actorId = this.actorId): void {
    if (presenter.roomId !== this.roomId) throw new Error('主播不属于当前直播间');
    if (this.stateValue.presenterId === presenter.id) return;
    const occurredAt = this.now();
    this.presenter = presenter;
    this.stateValue.presenterId = presenter.id;
    this.stateValue.presenterName = presenter.name;
    this.stateValue.lastEventAt = occurredAt;
    this.recordTimeline('presenter.selected', occurredAt, this.offsetAt(occurredAt), this.stateValue.product.id, { presenterId: presenter.id, presenterName: presenter.name, actorId });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(`当前主播已切换为${presenter.name}`, 'success');
  }

  private applyProductSelection(
    product: Product,
    occurredAt: number,
    payload: Record<string, unknown>,
  ): void {
    if (product.id === this.stateValue.product.id) return;
    this.productGeneration += 1;
    this.stateValue.product = product;
    this.stateValue.productContextStartedAt = occurredAt;
    this.stateValue.latestCompliance = null;
    this.stateValue.partialTranscript = '';
    this.stateValue.lastEventAt = occurredAt;
    this.recordTimeline('product.selected', occurredAt, this.offsetAt(occurredAt), product.id, { product, ...payload });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(`${payload.selectionSource === 'speech' ? '已自动切换' : '已切换'}商品：${product.name}`, 'success');
  }

  setLineup(productIds: string[], actorId = this.actorId): void {
    const lineup = this.productCatalog?.setLineup(this.id, this.roomId, productIds)
      ?? PRODUCTS.filter((product) => productIds.includes(product.id));
    if (lineup.length === 0) return;
    const occurredAt = this.now();
    const currentProduct = lineup.find((product) => product.id === this.stateValue.product.id);
    this.stateValue.lineup = lineup;
    if (!currentProduct) {
      this.productGeneration += 1;
      this.stateValue.product = lineup[0];
      this.stateValue.productContextStartedAt = occurredAt;
      this.stateValue.latestCompliance = null;
      this.stateValue.partialTranscript = '';
    } else {
      this.stateValue.product = currentProduct;
    }
    this.stateValue.lastEventAt = occurredAt;
    this.recordTimeline('lineup.updated', occurredAt, this.offsetAt(occurredAt), this.stateValue.product.id, {
      productIds: lineup.map((product) => product.id),
      actorId,
    });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(`本场商品清单已更新，共 ${lineup.length} 件`, 'success');
  }

  startListening(): void {
    if (this.stateValue.isListening || this.stateValue.captureState === 'ended') return;
    this.flushAudioBuffers();
    this.cancelSpeechRecovery(true);
    const captureEvent = this.stateValue.captureState === 'paused' ? 'capture.resumed' : 'capture.started';
    this.releaseDrainingSpeechStream(this.drainingSpeechStream, true);
    this.archiveQueue?.pause?.(this.id);
    const occurredAt = this.now();
    this.recordingStartedAt ??= occurredAt;
    this.currentCaptureOffsetMs = this.offsetAt(occurredAt);
    this.currentCaptureSampleOffset = Math.floor(this.currentAsrAudioByteLength() / 2);
    this.stateValue.isListening = true;
    this.stateValue.captureState = 'live';
    this.stateValue.lastEventAt = occurredAt;
    const currentProduct = this.stateValue.product;
    const contextProducts = [currentProduct, ...this.stateValue.lineup.filter((product) => product.id !== currentProduct.id)];
    const learnedCorrections = this.speechCorrectionCatalog?.list(this.roomId).filter((entry) => entry.enabled).slice(0, 12) ?? [];
    const asrContext = buildStreamingAsrContext(
      [...learnedCorrections.map((entry) => entry.correctText), ...contextProducts.flatMap((product) => [product.name, product.sku]).filter(Boolean)],
      [
        `当前直播商品：${currentProduct.name}；类目：${currentProduct.category}；规格：${currentProduct.description || '以商品页面为准'}`,
        `本场直播商品清单：${contextProducts.map((product) => product.name).join('、')}`,
        ...(learnedCorrections.length > 0 ? [`主播历史语音纠错：${learnedCorrections.map((entry) => `${entry.wrongText}应识别为${entry.correctText}`).join('；')}`] : []),
      ],
    );
    this.recordTimeline(captureEvent, occurredAt, this.currentCaptureOffsetMs, this.stateValue.product.id, {
      audioSampleOffset: this.currentCaptureSampleOffset,
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    });
    this.connectSpeechStream(asrContext);
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(this.speechStream ? '正在连接语音识别' : '演示模式已启动，可用快捷语句模拟收音', this.speechStream ? 'neutral' : 'success');
  }

  private connectSpeechStream(context: string | undefined): void {
    let stream: DoubaoStreamingAsr | null = null;
    const recoveryAttempt = this.speechRecoveryAttempt;
    stream = this.streamingAsrFactory({
      onResult: ({ text, isFinal, startTimeMs, endTimeMs }) => {
        const isActiveStream = this.stateValue.isListening && this.speechStream === stream;
        if (isActiveStream || (isFinal && this.drainingSpeechStream === stream)) this.ingestTranscript(text, isFinal, { startTimeMs, endTimeMs });
      },
      onError: (error) => {
        if (this.stateValue.isListening && this.speechStream === stream) this.handleSpeechFailure(error, stream, context);
        else if (!this.stateValue.isListening && this.drainingSpeechStream === stream) {
          const occurredAt = this.now();
          this.recordTimeline('asr.error', occurredAt, this.offsetAt(occurredAt), this.stateValue.product.id, { phase: 'draining', ...speechFailurePayload(error) });
          this.status('最后一句可能不完整，请在停播复核中检查', 'warning');
          this.releaseDrainingSpeechStream(stream, true);
        }
      },
      onReady: () => {
        if (!this.stateValue.isListening || this.speechStream !== stream) return;
        if (recoveryAttempt > 0) {
          const occurredAt = this.now();
          this.recordTimeline('asr.recovery.succeeded', occurredAt, this.offsetAt(occurredAt), this.stateValue.product.id, {
            attempt: recoveryAttempt,
            recoveryMs: this.speechRecoveryStartedAt === null ? null : Math.max(0, occurredAt - this.speechRecoveryStartedAt),
          });
          this.status('语音识别已自动恢复，收音继续', 'success');
        } else {
          this.status('语音识别已连接', 'success');
        }
        this.scheduleSpeechRecoveryReset(stream);
      },
      onClosed: () => this.releaseDrainingSpeechStream(stream, false),
      context,
    });
    this.speechStream = stream;
    this.speechStream?.connect();
  }

  pauseListening(): void {
    if (!this.stateValue.isListening) return;
    const occurredAt = this.now();
    this.flushAudioBuffers();
    this.finishActiveSpeechStream();
    this.stateValue.captureState = 'paused';
    this.recordCaptureBoundary('capture.paused', occurredAt);
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status('直播收音已暂停，可继续本场直播', 'warning');
  }

  resumeListening(): void {
    if (this.stateValue.captureState !== 'paused') return;
    this.startListening();
  }

  endLive(): void {
    if (this.stateValue.captureState === 'idle' || this.stateValue.captureState === 'ended') return;
    const occurredAt = this.now();
    this.flushAudioBuffers();
    if (this.stateValue.isListening) this.finishActiveSpeechStream();
    this.stateValue.captureState = 'ended';
    this.recordCaptureBoundary('capture.ended', occurredAt);
    this.audioWriteQueue = this.audioWriteQueue.then(() => {
      this.timelineStore?.finalizeAudio(this.id);
      this.archiveQueue?.enqueue(this.id);
    });
    void this.audioWriteQueue.catch((error: unknown) => this.status(`音频切片合成失败：${error instanceof Error ? error.message : String(error)}`, 'error'));
    try {
      const timeline = this.timelineStore?.exportSession(this.id);
      if (timeline && this.presenter) this.phraseLibrary?.archiveSession(this.presenter.id, timeline);
    } catch {
      this.status('本场话术归档稍后重试', 'warning');
    }
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status('本场直播已结束，音频和转录可进行复核', 'success');
  }

  stopListening(): void {
    this.endLive();
  }

  private finishActiveSpeechStream(): void {
    this.cancelSpeechRecovery(true);
    const stream = this.speechStream;
    this.speechStream = null;
    if (stream) {
      this.drainingSpeechStream = stream;
      this.speechDrainTimer = setTimeout(() => this.releaseDrainingSpeechStream(stream, true), 2_000);
      this.speechDrainTimer.unref();
    }
    this.stateValue.isListening = false;
    stream?.finish();
    this.stateValue.partialTranscript = '';
  }

  private recordCaptureBoundary(type: 'capture.paused' | 'capture.ended', occurredAt: number): void {
    this.stateValue.lastEventAt = occurredAt;
    this.recordTimeline(type, occurredAt, this.offsetAt(occurredAt), this.stateValue.product.id, {
      audioSampleOffset: Math.floor(this.currentAsrAudioByteLength() / 2),
    });
  }

  ingestAudio(audio: Buffer): void {
    if (!this.stateValue.isListening) return;
    this.speechStream?.sendAudio(audio);
    if (!this.timelineStore || audio.length === 0) return;
    this.pendingAsrAudioBytes += audio.length;
    this.pendingAsrChunk.push(audio);
    this.pendingAsrChunkBytes += audio.length;
    if (this.pendingAsrChunkBytes >= AUDIO_CHUNK_BYTES) this.flushAsrChunk();
  }

  ingestSourceAudio(audio: Buffer, sampleRate: number): void {
    if (!this.stateValue.isListening) return;
    if (!this.timelineStore || audio.length === 0) return;
    const pending = this.pendingSourceChunks.get(sampleRate) ?? { buffers: [], byteLength: 0 };
    pending.buffers.push(audio);
    pending.byteLength += audio.length;
    this.pendingSourceChunks.set(sampleRate, pending);
    if (pending.byteLength >= AUDIO_CHUNK_BYTES) this.flushSourceChunk(sampleRate);
  }

  private handleSpeechFailure(error: Error, failedStream: DoubaoStreamingAsr | null, context: string | undefined): void {
    if (!this.stateValue.isListening) return;
    if (isNextPacketTimeout(error) && this.speechRecoveryAttempt < SPEECH_RECOVERY_DELAYS_MS.length) {
      this.beginSpeechRecovery(error, failedStream, context);
      return;
    }
    const occurredAt = this.now();
    this.cancelSpeechRecovery(true);
    if (this.speechStream === failedStream) this.speechStream = null;
    failedStream?.close();
    this.speechStream = null;
    this.stateValue.isListening = false;
    this.stateValue.captureState = 'paused';
    this.stateValue.partialTranscript = '';
    this.stateValue.lastEventAt = occurredAt;
    this.recordTimeline('capture.failed', occurredAt, this.offsetAt(occurredAt), this.stateValue.product.id, speechFailurePayload(error));
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(speechFailureMessage(error), 'error');
  }

  private beginSpeechRecovery(error: Error, failedStream: DoubaoStreamingAsr | null, context: string | undefined): void {
    const occurredAt = this.now();
    this.clearSpeechRecoveryTimers();
    if (this.speechStream === failedStream) this.speechStream = null;
    failedStream?.close();
    this.speechRecoveryAttempt += 1;
    this.speechRecoveryStartedAt = occurredAt;
    const delayMs = SPEECH_RECOVERY_DELAYS_MS[this.speechRecoveryAttempt - 1];
    this.stateValue.partialTranscript = '';
    this.stateValue.lastEventAt = occurredAt;
    this.recordTimeline('asr.recovery.started', occurredAt, this.offsetAt(occurredAt), this.stateValue.product.id, {
      ...speechFailurePayload(error),
      attempt: this.speechRecoveryAttempt,
      delayMs,
    });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(`连接短暂中断，正在恢复语音识别（第 ${this.speechRecoveryAttempt} 次）`, 'warning');
    this.speechRecoveryTimer = setTimeout(() => {
      this.speechRecoveryTimer = null;
      if (!this.stateValue.isListening || this.stateValue.captureState !== 'live' || this.speechStream) return;
      this.connectSpeechStream(context);
    }, delayMs);
    this.speechRecoveryTimer.unref();
  }

  private scheduleSpeechRecoveryReset(stream: DoubaoStreamingAsr | null): void {
    if (this.speechRecoveryResetTimer) clearTimeout(this.speechRecoveryResetTimer);
    this.speechRecoveryResetTimer = setTimeout(() => {
      this.speechRecoveryResetTimer = null;
      if (this.stateValue.isListening && this.speechStream === stream) {
        this.speechRecoveryAttempt = 0;
        this.speechRecoveryStartedAt = null;
      }
    }, SPEECH_RECOVERY_STABLE_MS);
    this.speechRecoveryResetTimer.unref();
  }

  private clearSpeechRecoveryTimers(): void {
    if (this.speechRecoveryTimer) clearTimeout(this.speechRecoveryTimer);
    if (this.speechRecoveryResetTimer) clearTimeout(this.speechRecoveryResetTimer);
    this.speechRecoveryTimer = null;
    this.speechRecoveryResetTimer = null;
  }

  private cancelSpeechRecovery(resetAttempt: boolean): void {
    this.clearSpeechRecoveryTimers();
    if (!resetAttempt) return;
    this.speechRecoveryAttempt = 0;
    this.speechRecoveryStartedAt = null;
  }

  private releaseDrainingSpeechStream(stream: DoubaoStreamingAsr | null, close: boolean): void {
    if (!stream || this.drainingSpeechStream !== stream) return;
    if (this.speechDrainTimer) clearTimeout(this.speechDrainTimer);
    this.speechDrainTimer = null;
    this.drainingSpeechStream = null;
    if (close) stream.close();
  }

  ingestTranscript(rawText: string, isFinal = true, timing: TranscriptTiming = {}): void {
    const raw = rawText.trim();
    const normalized = this.speechCorrectionCatalog?.apply(this.roomId, raw) ?? { text: raw, applied: [] };
    const text = normalized.text.trim();
    if (!text) return;
    const occurredAt = this.now();
    const receivedOffsetMs = this.offsetAt(occurredAt);
    const startOffsetMs = timing.startTimeMs === undefined || this.currentCaptureOffsetMs === null ? null : this.currentCaptureOffsetMs + timing.startTimeMs;
    const endOffsetMs = timing.endTimeMs === undefined || this.currentCaptureOffsetMs === null ? receivedOffsetMs : this.currentCaptureOffsetMs + timing.endTimeMs;
    const segment: TranscriptSegment = {
      id: `segment-${this.segmentNumber++}`,
      text,
      isFinal,
      timestamp: occurredAt,
      offsetMs: endOffsetMs,
      startOffsetMs,
      endOffsetMs,
      speaker: 'host',
    };
    this.stateValue.lastEventAt = occurredAt;
    if (!isFinal) {
      this.stateValue.partialTranscript = text;
      this.broadcast({ type: 'transcript.partial', segment });
      return;
    }
    const mentionedProduct = findMentionedProduct(text, this.stateValue.lineup);
    if (mentionedProduct && mentionedProduct.product.id !== this.stateValue.product.id) {
      this.applyProductSelection(mentionedProduct.product, occurredAt, {
        selectionSource: 'speech',
        matchedTerm: mentionedProduct.matchedTerm,
        matchType: mentionedProduct.matchType,
        transcriptSegmentId: segment.id,
      });
    }
    this.stateValue.partialTranscript = '';
    this.stateValue.transcriptHistory = [...this.stateValue.transcriptHistory, segment].slice(-20);
    this.stateValue.stats.words += text.replace(/\s/g, '').length;
    this.stateValue.stats.speakingSeconds = Math.round((receivedOffsetMs ?? occurredAt - this.createdAt) / 1000);
    this.recordTimeline('transcript.final', occurredAt, endOffsetMs, this.stateValue.product.id, {
      segmentId: segment.id,
      text,
      ...(normalized.applied.length > 0 ? { rawText: raw, appliedSpeechCorrectionIds: normalized.applied.map((entry) => entry.id) } : {}),
      startOffsetMs,
      endOffsetMs,
      speaker: segment.speaker,
      audioStartSample: timing.startTimeMs === undefined ? null : this.currentCaptureSampleOffset + Math.round((timing.startTimeMs / 1000) * 16000),
      audioEndSample: timing.endTimeMs === undefined ? null : this.currentCaptureSampleOffset + Math.round((timing.endTimeMs / 1000) * 16000),
    });
    this.broadcast({ type: 'transcript.final', segment });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.segmentRevisions.set(segment.id, 0);
    this.enqueueCompliance(segment);
  }

  correctTranscript(
    segmentId: string,
    correctedText: string,
    actorId = this.actorId,
    learning: { learn?: boolean; wrongText?: string; correctText?: string } = {},
  ): TranscriptSegment | null {
    const text = correctedText.trim();
    if (!text) return null;
    const explicitPair = learning.wrongText?.trim() && learning.correctText?.trim()
      ? { wrongText: learning.wrongText.trim(), correctText: learning.correctText.trim() }
      : undefined;
    if (learning.learn && explicitPair && explicitPair.wrongText === explicitPair.correctText) throw new Error('错误词和正确词不能相同');
    const index = this.stateValue.transcriptHistory.findIndex((segment) => segment.id === segmentId && segment.isFinal);
    const original = index >= 0 ? this.stateValue.transcriptHistory[index] : this.findPersistedTranscript(segmentId);
    if (!original) return null;
    const correctedAt = this.now();
    const corrected = { ...original, text };
    this.segmentRevisions.set(segmentId, (this.segmentRevisions.get(segmentId) ?? 0) + 1);
    if (index >= 0) {
      const history = [...this.stateValue.transcriptHistory];
      history[index] = corrected;
      this.stateValue.transcriptHistory = history;
    }
    this.stateValue.stats.words = Math.max(0, this.stateValue.stats.words - original.text.replace(/\s/g, '').length + text.replace(/\s/g, '').length);
    const previousResult = this.complianceBySegment.get(segmentId);
    if (previousResult) {
      const statKey = `${previousResult.risk}Count` as 'safeCount' | 'warningCount' | 'blockedCount';
      this.stateValue.stats[statKey] = Math.max(0, this.stateValue.stats[statKey] - 1);
      this.complianceBySegment.delete(segmentId);
    }
    this.stateValue.alerts = this.stateValue.alerts.filter((alert) => alert.segmentId !== segmentId);
    if (this.stateValue.latestCompliance?.segmentId === segmentId) this.stateValue.latestCompliance = null;
    this.stateValue.lastEventAt = correctedAt;
    const derived = deriveSpeechCorrection(original.text, text);
    const pair = explicitPair ?? derived;
    const learned = learning.learn && pair
      ? this.speechCorrectionCatalog?.record(this.roomId, { ...pair, actorId, sessionId: this.id, segmentId })
      : undefined;
    this.recordTimeline('transcript.corrected', correctedAt, corrected.endOffsetMs, this.stateValue.product.id, {
      segmentId,
      originalText: original.text,
      correctedText: text,
      actorId,
      ...(learned ? { speechCorrectionId: learned.id, wrongText: learned.wrongText, correctText: learned.correctText } : {}),
    });
    if (index >= 0) this.broadcast({ type: 'transcript.final', segment: corrected });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.enqueueCompliance(corrected);
    return corrected;
  }

  annotateSpeaker(segmentId: string, speaker: 'host' | 'other', actorId = this.actorId): TranscriptSegment | null {
    const index = this.stateValue.transcriptHistory.findIndex((segment) => segment.id === segmentId && segment.isFinal);
    const original = index >= 0 ? this.stateValue.transcriptHistory[index] : this.findPersistedTranscript(segmentId);
    if (!original) return null;
    if (original.speaker === speaker) return original;
    const annotatedAt = this.now();
    const annotated = { ...original, speaker };
    if (index >= 0) {
      const history = [...this.stateValue.transcriptHistory];
      history[index] = annotated;
      this.stateValue.transcriptHistory = history;
    }
    this.stateValue.lastEventAt = annotatedAt;
    this.recordTimeline('transcript.annotated', annotatedAt, annotated.endOffsetMs, this.stateValue.product.id, {
      segmentId,
      speaker,
      actorId,
    });
    if (index >= 0) this.broadcast({ type: 'transcript.final', segment: annotated });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    return annotated;
  }

  private findPersistedTranscript(segmentId: string): TranscriptSegment | null {
    const events = this.timelineStore?.exportSession(this.id)?.events ?? [];
    let segment: TranscriptSegment | null = null;
    for (const event of events) {
      if (event.type === 'transcript.final' && event.payload.segmentId === segmentId && typeof event.payload.text === 'string') {
        segment = {
          id: segmentId,
          text: event.payload.text,
          isFinal: true,
          timestamp: event.occurredAt,
          offsetMs: event.offsetMs,
          startOffsetMs: typeof event.payload.startOffsetMs === 'number' ? event.payload.startOffsetMs : null,
          endOffsetMs: typeof event.payload.endOffsetMs === 'number' ? event.payload.endOffsetMs : event.offsetMs,
          speaker: event.payload.speaker === 'other' ? 'other' : 'host',
        };
      }
      if (segment && event.type === 'transcript.corrected' && event.payload.segmentId === segmentId && typeof event.payload.correctedText === 'string') {
        segment = { ...segment, text: event.payload.correctedText };
      }
      if (segment && event.type === 'transcript.annotated' && event.payload.segmentId === segmentId) {
        segment = { ...segment, speaker: event.payload.speaker === 'other' ? 'other' : 'host' };
      }
    }
    return segment;
  }

  private enqueueCompliance(segment: TranscriptSegment): void {
    const generation = this.productGeneration;
    const product = this.stateValue.product;
    const revision = this.segmentRevisions.get(segment.id) ?? 0;
    const requestNumber = ++this.analysisRequestNumber;
    this.latestAnalysisRequest = requestNumber;
    const queuedAt = performance.now();
    const riskProfile = this.stateValue.riskProfile;
    const context = this.buildAnalysisContext(segment, riskProfile);
    void this.checkCompliance(segment.text, generation, product.id, product, segment, revision, requestNumber, queuedAt, riskProfile, context)
      .catch((error: unknown) => {
        this.status(`合规分析暂时不可用：${error instanceof Error ? error.message : String(error)}`, 'error');
        if (requestNumber === this.latestAnalysisRequest) this.enqueueCoach(segment, null);
      });
  }

  private buildAnalysisContext(segment: TranscriptSegment, profile: RiskProfile): NonNullable<AnalysisInput['context']> {
    const windowMs = profile === 'strict' ? 90_000 : profile === 'optimized' ? 45_000 : 60_000;
    const maxSegments = profile === 'strict' ? 20 : profile === 'optimized' ? 8 : 12;
    const windowStartMs = Math.max(this.stateValue.productContextStartedAt, segment.timestamp - windowMs);
    const segments = this.stateValue.transcriptHistory
      .filter((candidate) => candidate.isFinal && candidate.speaker !== 'other' && candidate.timestamp >= windowStartMs && candidate.timestamp <= segment.timestamp)
      .slice(-maxSegments);
    return {
      text: segments.map((candidate) => candidate.text).join('\n').slice(-4_000),
      segmentCount: segments.length,
      windowStartMs,
      windowEndMs: segment.timestamp,
    };
  }

  private enqueueCoach(segment: TranscriptSegment, compliance: ComplianceResult | null): void {
    const requestNumber = ++this.coachRequestNumber;
    const input: CoachInput = {
      product: this.stateValue.product,
      transcript: segment.text,
      compliance,
      stats: this.stateValue.stats,
      referencePhrases: this.phraseLibrary?.references(this.presenter?.id ?? this.stateValue.presenterId, this.stateValue.product.id).slice(0, 10).map((phrase) => ({ text: phrase.text, purpose: phrase.purpose })) ?? [],
    };
    const fallback = localSuggestions(input, this.now());
    this.stateValue.coachSuggestion = fallback[0];
    this.stateValue.coachSuggestions = fallback;
    this.stateValue.coachPending = true;
    this.broadcast({ type: 'state.snapshot', state: this.state });
    const request = this.coach.suggestMany ? this.coach.suggestMany(input) : this.coach.suggest(input).then((suggestion) => [suggestion]);
    void request.then((suggestions) => {
      if (requestNumber !== this.coachRequestNumber) return;
      const resolved = [...suggestions, ...fallback]
        .filter((suggestion, index, all) => all.findIndex((item) => item.text === suggestion.text) === index)
        .slice(0, 3);
      this.stateValue.coachSuggestion = resolved[0] ?? fallback[0];
      this.stateValue.coachSuggestions = resolved.length === 3 ? resolved : fallback;
      this.stateValue.coachPending = false;
      this.stateValue.coachSuggestions.forEach((suggestion, suggestionIndex) => {
        this.recordTimeline('coach.suggestion', suggestion.createdAt, segment.endOffsetMs, input.product.id, {
          transcriptSegmentId: segment.id,
          suggestionIndex,
          purpose: suggestion.purpose,
          text: suggestion.text,
          reason: suggestion.reason,
          source: suggestion.source,
          ...(suggestion.latencyMs === undefined ? {} : { latencyMs: suggestion.latencyMs }),
        });
      });
      this.broadcast({ type: 'state.snapshot', state: this.state });
    }).catch(() => {
      if (requestNumber !== this.coachRequestNumber) return;
      this.stateValue.coachPending = false;
      this.broadcast({ type: 'state.snapshot', state: this.state });
    });
  }

  private async checkCompliance(transcript: string, generation: number, productId: string, product: Product, segment: TranscriptSegment, revision: number, requestNumber: number, queuedAt: number, riskProfile: RiskProfile, context: NonNullable<AnalysisInput['context']>): Promise<void> {
    const analysisStartedAt = performance.now();
    const analysisStartedAtWallClock = this.now();
    const analyzed = await this.analyzer.analyze({ roomId: this.roomId, productId, transcript, product, customRules: this.ruleCatalog?.listActive(this.roomId), riskProfile, context });
    if (generation !== this.productGeneration || productId !== this.stateValue.product.id || revision !== this.segmentRevisions.get(segment.id)) return;
    const complianceAnalysisMs = Math.max(0, Math.round(performance.now() - analysisStartedAt));
    const completedAt = this.now();
    const totalResponseMs = Math.max(0, completedAt - segment.timestamp);
    const result = { ...analyzed, segmentId: segment.id, createdAt: completedAt, analysisMs: totalResponseMs };
    const stageTimings = {
      totalResponseMs,
      asrAudioDurationMs: segment.startOffsetMs !== null && segment.endOffsetMs !== null ? Math.max(0, segment.endOffsetMs - segment.startOffsetMs) : null,
      asrFinalizationMs: this.recordingStartedAt !== null && segment.endOffsetMs !== null
        ? Math.max(0, segment.timestamp - (this.recordingStartedAt + segment.endOffsetMs))
        : null,
      complianceQueueMs: Math.max(0, Math.round(analysisStartedAt - queuedAt)),
      complianceAnalysisMs,
      analysisStartedAt: analysisStartedAtWallClock,
      completedAt,
      ...(analyzed.analysisTiming ? { analyzer: analyzed.analysisTiming } : {}),
    };
    this.complianceBySegment.set(segment.id, result);
    if (requestNumber === this.latestAnalysisRequest) this.stateValue.latestCompliance = result;
    this.stateValue.stats[`${result.risk}Count` as 'safeCount' | 'warningCount' | 'blockedCount'] += 1;
    if (result.risk !== 'safe') {
      this.stateValue.alerts = [result, ...this.stateValue.alerts].slice(0, 12);
    }
    this.recordTimeline('compliance.result', result.createdAt, segment.endOffsetMs, productId, {
      transcriptSegmentId: segment.id,
      risk: result.risk,
      title: result.title,
      reason: result.reason,
      alternative: result.alternative,
      policyRef: result.policyRef,
      confidence: result.confidence,
      source: result.source,
      analysisMs: result.analysisMs,
      matchedTerms: result.matchedTerms ?? [],
      ruleKind: result.ruleKind ?? 'sentence',
      riskProfile,
      contextSegmentCount: context.segmentCount,
      contextWindowMs: Math.max(0, context.windowEndMs - context.windowStartMs),
      stageTimings,
    });
    this.broadcast({ type: 'compliance.result', result });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    if (requestNumber === this.latestAnalysisRequest) this.enqueueCoach(segment, result);
    try {
      this.ruleCatalog?.learnFromResult(this.roomId, this.id, result);
    } catch {
      // Rule learning is best-effort and must never interrupt the live session.
    }
  }

  private currentAsrAudioByteLength(): number {
    return (this.timelineStore?.getAudioByteLength(this.id) ?? 0) + this.pendingAsrAudioBytes;
  }

  private flushAudioBuffers(): void {
    this.flushAsrChunk();
    for (const sampleRate of this.pendingSourceChunks.keys()) this.flushSourceChunk(sampleRate);
  }

  private flushAsrChunk(): void {
    if (!this.timelineStore || this.pendingAsrChunkBytes === 0) return;
    const chunk = Buffer.concat(this.pendingAsrChunk, this.pendingAsrChunkBytes);
    this.pendingAsrChunk = [];
    this.pendingAsrChunkBytes = 0;
    this.enqueueAudioWrite(chunk.length, () => this.timelineStore?.appendAudio(this.id, chunk));
  }

  private flushSourceChunk(sampleRate: number): void {
    const pending = this.pendingSourceChunks.get(sampleRate);
    if (!this.timelineStore || !pending || pending.byteLength === 0) return;
    const chunk = Buffer.concat(pending.buffers, pending.byteLength);
    this.pendingSourceChunks.delete(sampleRate);
    this.enqueueAudioWrite(0, () => this.timelineStore?.appendSourceAudio(this.id, chunk, sampleRate));
  }

  private enqueueAudioWrite(byteLength: number, write: () => void): void {
    this.audioWriteQueue = this.audioWriteQueue
      .catch(() => undefined)
      .then(() => new Promise<void>((resolve) => {
        setImmediate(() => {
          try {
            write();
          } catch (error) {
            this.status(`音频切片保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
          } finally {
            this.pendingAsrAudioBytes = Math.max(0, this.pendingAsrAudioBytes - byteLength);
            resolve();
          }
        });
      }));
  }

  private restorePersistedState(): void {
    const timeline = this.timelineStore?.exportSession(this.id);
    if (!timeline) return;
    const transcripts = new Map<string, TranscriptSegment>();
    const results = new Map<string, ComplianceResult>();
    let latestCoach: SessionState['coachSuggestion'] = null;
    let latestCoachSuggestions: NonNullable<SessionState['coachSuggestions']> = [];
    let selectedProductId = this.stateValue.product.id;
    let productContextStartedAt = this.stateValue.productContextStartedAt;
    let riskProfile = this.stateValue.riskProfile;
    let maximumOffsetMs = 0;
    let captureState: CaptureState = 'idle';

    for (const event of timeline.events) {
      maximumOffsetMs = Math.max(maximumOffsetMs, event.offsetMs ?? 0);
      this.stateValue.lastEventAt = Math.max(this.stateValue.lastEventAt, event.occurredAt);
      if (event.type === 'capture.started' || event.type === 'capture.resumed') captureState = 'paused';
      if (event.type === 'capture.paused' || event.type === 'capture.failed') captureState = 'paused';
      if (event.type === 'capture.ended' || event.type === 'capture.stopped') captureState = 'ended';
      if (event.type === 'product.selected' && event.productId) {
        selectedProductId = event.productId;
        productContextStartedAt = event.occurredAt;
      }
      if (event.type === 'risk.profile.changed' && (event.payload.profile === 'strict' || event.payload.profile === 'balanced' || event.payload.profile === 'optimized')) {
        riskProfile = event.payload.profile;
      }
      if ((event.type === 'session.created' || event.type === 'presenter.selected') && typeof event.payload.presenterId === 'string') {
        this.stateValue.presenterId = event.payload.presenterId;
        this.stateValue.presenterName = typeof event.payload.presenterName === 'string' ? event.payload.presenterName : this.stateValue.presenterName;
      }
      if (event.type === 'transcript.final') {
        const segmentId = typeof event.payload.segmentId === 'string' ? event.payload.segmentId : '';
        const text = typeof event.payload.text === 'string' ? event.payload.text : '';
        if (!segmentId || !text) continue;
        transcripts.set(segmentId, {
          id: segmentId,
          text,
          isFinal: true,
          timestamp: event.occurredAt,
          offsetMs: event.offsetMs,
          startOffsetMs: typeof event.payload.startOffsetMs === 'number' ? event.payload.startOffsetMs : null,
          endOffsetMs: typeof event.payload.endOffsetMs === 'number' ? event.payload.endOffsetMs : event.offsetMs,
          speaker: event.payload.speaker === 'other' ? 'other' : 'host',
        });
        const match = /^segment-(\d+)$/u.exec(segmentId);
        if (match) this.segmentNumber = Math.max(this.segmentNumber, Number(match[1]) + 1);
      }
      if (event.type === 'transcript.corrected') {
        const segmentId = typeof event.payload.segmentId === 'string' ? event.payload.segmentId : '';
        const correctedText = typeof event.payload.correctedText === 'string' ? event.payload.correctedText : '';
        const existing = transcripts.get(segmentId);
        if (existing && correctedText) {
          transcripts.set(segmentId, { ...existing, text: correctedText });
          results.delete(segmentId);
        }
      }
      if (event.type === 'compliance.result') {
        const segmentId = typeof event.payload.transcriptSegmentId === 'string' ? event.payload.transcriptSegmentId : '';
        const segment = transcripts.get(segmentId);
        const risk = event.payload.risk === 'blocked' || event.payload.risk === 'warning' ? event.payload.risk : 'safe';
        const source = event.payload.source === 'doubao' || event.payload.source === 'custom-rule' ? event.payload.source : 'local-fallback';
        if (!segmentId || !segment) continue;
        results.set(segmentId, {
          id: `restored-${event.id}`,
          segmentId,
          productId: event.productId ?? this.stateValue.product.id,
          risk,
          title: typeof event.payload.title === 'string' ? event.payload.title : '历史合规结果',
          reason: typeof event.payload.reason === 'string' ? event.payload.reason : '',
          alternative: typeof event.payload.alternative === 'string' ? event.payload.alternative : '',
          policyRef: typeof event.payload.policyRef === 'string' ? event.payload.policyRef : '',
          confidence: typeof event.payload.confidence === 'number' ? event.payload.confidence : 0,
          source,
          transcript: segment.text,
          createdAt: event.occurredAt,
          ...(typeof event.payload.analysisMs === 'number' ? { analysisMs: Math.max(0, event.payload.analysisMs) } : {}),
          ...(Array.isArray(event.payload.matchedTerms) ? { matchedTerms: event.payload.matchedTerms.filter((term): term is string => typeof term === 'string') } : {}),
          ...(event.payload.ruleKind === 'term' || event.payload.ruleKind === 'context' || event.payload.ruleKind === 'sentence' ? { ruleKind: event.payload.ruleKind } : {}),
        });
      }
      if (event.type === 'coach.suggestion') {
        const purpose = typeof event.payload.purpose === 'string' ? event.payload.purpose : '塑品';
        const text = typeof event.payload.text === 'string' ? event.payload.text : '';
        if (text) {
          const suggestion: NonNullable<SessionState['coachSuggestion']> = {
            id: `restored-${event.id}`,
            purpose: purpose as NonNullable<SessionState['coachSuggestion']>['purpose'],
            text,
            reason: typeof event.payload.reason === 'string' ? event.payload.reason : '',
            source: event.payload.source === 'doubao' ? 'doubao' : 'local-fallback',
            createdAt: event.occurredAt,
            ...(typeof event.payload.latencyMs === 'number' ? { latencyMs: event.payload.latencyMs } : {}),
          };
          const suggestionIndex = typeof event.payload.suggestionIndex === 'number' ? event.payload.suggestionIndex : 0;
          if (suggestionIndex === 0) latestCoachSuggestions = [];
          latestCoachSuggestions[suggestionIndex] = suggestion;
          latestCoach = latestCoachSuggestions[0] ?? suggestion;
        }
      }
    }

    const allTranscripts = [...transcripts.values()].sort((first, second) => first.timestamp - second.timestamp);
    const allResults = [...results.values()].sort((first, second) => first.createdAt - second.createdAt);
    this.stateValue.product = this.stateValue.lineup.find((product) => product.id === selectedProductId) ?? this.stateValue.product;
    this.stateValue.captureState = captureState;
    this.stateValue.productContextStartedAt = productContextStartedAt;
    this.stateValue.riskProfile = riskProfile;
    this.presenter = this.phraseLibrary?.getPresenter(this.stateValue.presenterId) ?? this.presenter;
    this.stateValue.transcriptHistory = allTranscripts.slice(-20);
    this.stateValue.latestCompliance = allResults.at(-1) ?? null;
    this.stateValue.coachSuggestion = latestCoach;
    this.stateValue.coachSuggestions = latestCoachSuggestions.filter(Boolean).slice(0, 3);
    this.stateValue.coachPending = false;
    this.stateValue.alerts = allResults.filter((result) => result.risk !== 'safe').reverse().slice(0, 12);
    this.stateValue.stats = {
      speakingSeconds: Math.round(maximumOffsetMs / 1_000),
      words: allTranscripts.reduce((total, segment) => total + segment.text.replace(/\s/g, '').length, 0),
      blockedCount: allResults.filter((result) => result.risk === 'blocked').length,
      warningCount: allResults.filter((result) => result.risk === 'warning').length,
      safeCount: allResults.filter((result) => result.risk === 'safe').length,
    };
    for (const segment of allTranscripts) this.segmentRevisions.set(segment.id, 0);
    for (const [segmentId, result] of results) this.complianceBySegment.set(segmentId, result);
  }

  private status(message: string, tone: 'neutral' | 'success' | 'warning' | 'error'): void {
    this.broadcast({ type: 'system.status', message, tone });
  }

  private offsetAt(occurredAt: number): number | null {
    return this.recordingStartedAt === null ? null : Math.max(0, occurredAt - this.recordingStartedAt);
  }

  private recordTimeline(
    type: Parameters<TimelineWriter['appendEvent']>[1]['type'],
    occurredAt: number,
    offsetMs: number | null,
    productId: string | null,
    payload: Record<string, unknown>,
  ): void {
    this.timelineStore?.appendEvent(this.id, { type, occurredAt, offsetMs, productId, payload });
  }

  private broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.socket.readyState === 1) client.socket.send(payload);
    }
  }
}
