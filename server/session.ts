import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { createDoubaoAnalyzer } from './services';
import { buildStreamingAsrContext, createDoubaoStreamingAsr, type DoubaoStreamingAsr } from './providers/doubaoStreamingAsr';
import type { TimelineWriter } from './timelineStore';
import type { RecordingArchiveQueue } from './recordingArchive';
import type { ComplianceAnalyzer } from '../src/compliance/engine';
import type { ProductCatalog } from './productCatalog';
import type { RuleCatalog } from './ruleCatalog';
import { deriveSpeechCorrection, type SpeechCorrectionCatalog } from './speechCorrectionCatalog';
import { DEFAULT_PRODUCT, PRODUCTS } from '../src/shared/products';
import type {
  CaptureState,
  ComplianceResult,
  Product,
  ServerMessage,
  SessionState,
  SessionStats,
  TranscriptSegment,
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
  roomId?: string;
  actorId?: string;
  now?: () => number;
};

const AUDIO_CHUNK_BYTES = 256 * 1024;

function createStats(): SessionStats {
  return { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 };
}

export class LiveSession {
  readonly id: string;
  readonly roomId: string;
  readonly createdAt: number;
  private readonly clients = new Set<Client>();
  private readonly analyzer: ComplianceAnalyzer;
  private speechStream: DoubaoStreamingAsr | null = null;
  private drainingSpeechStream: DoubaoStreamingAsr | null = null;
  private speechDrainTimer: NodeJS.Timeout | null = null;
  private segmentNumber = 0;
  private productGeneration = 0;
  private analysisRequestNumber = 0;
  private latestAnalysisRequest = 0;
  private readonly complianceBySegment = new Map<string, ComplianceResult>();
  private readonly segmentRevisions = new Map<string, number>();
  private readonly timelineStore?: TimelineWriter;
  private readonly productCatalog?: ProductCatalog;
  private readonly ruleCatalog?: RuleCatalog;
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
    this.speechCorrectionCatalog = options.speechCorrectionCatalog;
    this.archiveQueue = options.archiveQueue;
    this.analyzer = options.analyzer ?? createDoubaoAnalyzer();
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
      product: initialProduct,
      lineup,
      isListening: false,
      captureState: 'idle',
      partialTranscript: '',
      transcriptHistory: [],
      latestCompliance: null,
      productContextStartedAt: this.createdAt,
      alerts: [],
      stats: createStats(),
      lastEventAt: this.createdAt,
    };
    if (persistedTiming.createdAt === null) {
      this.recordTimeline('session.created', this.createdAt, null, initialProduct.id, { roomId: this.roomId, actorId: this.actorId, product: initialProduct, lineupProductIds: lineup.map((product) => product.id) });
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

  products(): Product[] {
    return structuredClone(this.stateValue.lineup);
  }

  selectProduct(productId: string): void {
    const product = this.stateValue.lineup.find((item) => item.id === productId);
    if (!product) return;
    this.productGeneration += 1;
    const occurredAt = this.now();
    this.stateValue.product = product;
    this.stateValue.productContextStartedAt = occurredAt;
    this.stateValue.latestCompliance = null;
    this.stateValue.partialTranscript = '';
    this.stateValue.lastEventAt = occurredAt;
    this.recordTimeline('product.selected', occurredAt, this.offsetAt(occurredAt), product.id, { product });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(`已切换商品：${product.name}`, 'success');
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
    let stream: DoubaoStreamingAsr | null = null;
    stream = createDoubaoStreamingAsr({
      onResult: ({ text, isFinal, startTimeMs, endTimeMs }) => {
        if (this.stateValue.isListening || (isFinal && this.drainingSpeechStream === stream)) this.ingestTranscript(text, isFinal, { startTimeMs, endTimeMs });
      },
      onError: (error) => {
        if (this.stateValue.isListening) this.handleSpeechFailure(error);
        else if (this.drainingSpeechStream === stream) {
          this.status(`流式语音识别收尾失败，最后一句可能不完整：${error.message}`, 'error');
          this.releaseDrainingSpeechStream(stream, true);
        }
      },
      onReady: () => {
        if (this.stateValue.isListening) this.status('豆包大模型流式语音识别已连接', 'success');
      },
      onClosed: () => this.releaseDrainingSpeechStream(stream, false),
      context: asrContext,
    });
    this.speechStream = stream;
    this.speechStream?.connect();
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(this.speechStream ? '正在连接豆包大模型流式语音识别' : '演示模式已启动，可用快捷语句模拟收音', this.speechStream ? 'neutral' : 'success');
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
    void this.audioWriteQueue.then(() => {
      this.timelineStore?.finalizeAudio(this.id);
      this.archiveQueue?.enqueue(this.id);
    }).catch((error: unknown) => this.status(`音频切片合成失败：${error instanceof Error ? error.message : String(error)}`, 'error'));
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status('本场直播已结束，音频和转录可进行复核', 'success');
  }

  stopListening(): void {
    this.endLive();
  }

  private finishActiveSpeechStream(): void {
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

  private handleSpeechFailure(error: Error): void {
    if (!this.stateValue.isListening) return;
    const occurredAt = this.now();
    this.speechStream?.close();
    this.speechStream = null;
    this.stateValue.isListening = false;
    this.stateValue.captureState = 'paused';
    this.stateValue.partialTranscript = '';
    this.stateValue.lastEventAt = occurredAt;
    this.recordTimeline('capture.failed', occurredAt, this.offsetAt(occurredAt), this.stateValue.product.id, { message: error.message });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(`豆包大模型流式语音识别连接异常，本场已暂停：${error.message}`, 'error');
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
    };
    this.stateValue.lastEventAt = occurredAt;
    if (!isFinal) {
      this.stateValue.partialTranscript = text;
      this.broadcast({ type: 'transcript.partial', segment });
      return;
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
        };
      }
      if (segment && event.type === 'transcript.corrected' && event.payload.segmentId === segmentId && typeof event.payload.correctedText === 'string') {
        segment = { ...segment, text: event.payload.correctedText };
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
    void this.checkCompliance(segment.text, generation, product.id, product, segment, revision, requestNumber)
      .catch((error: unknown) => this.status(`合规分析暂时不可用：${error instanceof Error ? error.message : String(error)}`, 'error'));
  }

  private async checkCompliance(transcript: string, generation: number, productId: string, product: Product, segment: TranscriptSegment, revision: number, requestNumber: number): Promise<void> {
    const analyzed = await this.analyzer.analyze({ roomId: this.roomId, productId, transcript, product, customRules: this.ruleCatalog?.listActive(this.roomId) });
    if (generation !== this.productGeneration || productId !== this.stateValue.product.id || revision !== this.segmentRevisions.get(segment.id)) return;
    const result = { ...analyzed, segmentId: segment.id };
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
    });
    this.broadcast({ type: 'compliance.result', result });
    this.broadcast({ type: 'state.snapshot', state: this.state });
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
    let selectedProductId = this.stateValue.product.id;
    let productContextStartedAt = this.stateValue.productContextStartedAt;
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
        });
      }
    }

    const allTranscripts = [...transcripts.values()].sort((first, second) => first.timestamp - second.timestamp);
    const allResults = [...results.values()].sort((first, second) => first.createdAt - second.createdAt);
    this.stateValue.product = this.stateValue.lineup.find((product) => product.id === selectedProductId) ?? this.stateValue.product;
    this.stateValue.captureState = captureState;
    this.stateValue.productContextStartedAt = productContextStartedAt;
    this.stateValue.transcriptHistory = allTranscripts.slice(-20);
    this.stateValue.latestCompliance = allResults.at(-1) ?? null;
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
