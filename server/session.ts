import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { createDoubaoAnalyzer } from './services';
import { createVolcSpeechStream, type VolcSpeechStream } from './providers/volcSpeech';
import type { TimelineWriter } from './timelineStore';
import type { RecordingArchiveQueue } from './recordingArchive';
import type { ComplianceAnalyzer } from '../src/compliance/engine';
import type { ProductCatalog } from './productCatalog';
import type { RuleCatalog } from './ruleCatalog';
import { DEFAULT_PRODUCT, PRODUCTS } from '../src/shared/products';
import type {
  ComplianceResult,
  Product,
  ServerMessage,
  SessionState,
  SessionStats,
  TranscriptSegment,
} from '../src/shared/types';

type Client = { socket: WebSocket; role: 'operator' | 'display' };
type TranscriptTiming = { startTimeMs?: number; endTimeMs?: number };
type LiveSessionOptions = { timelineStore?: TimelineWriter; productCatalog?: ProductCatalog; ruleCatalog?: RuleCatalog; archiveQueue?: RecordingArchiveQueue; analyzer?: ComplianceAnalyzer; roomId?: string; actorId?: string; now?: () => number };

function createStats(): SessionStats {
  return { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 };
}

export class LiveSession {
  readonly id: string;
  readonly roomId: string;
  readonly createdAt: number;
  private readonly clients = new Set<Client>();
  private readonly analyzer: ComplianceAnalyzer;
  private speechStream: VolcSpeechStream | null = null;
  private segmentNumber = 0;
  private productGeneration = 0;
  private analysisQueue: Promise<void> = Promise.resolve();
  private readonly complianceBySegment = new Map<string, ComplianceResult>();
  private readonly segmentRevisions = new Map<string, number>();
  private readonly timelineStore?: TimelineWriter;
  private readonly productCatalog?: ProductCatalog;
  private readonly ruleCatalog?: RuleCatalog;
  private readonly archiveQueue?: RecordingArchiveQueue;
  private readonly actorId: string;
  private readonly now: () => number;
  private recordingStartedAt: number | null = null;
  private currentCaptureOffsetMs: number | null = null;
  private currentCaptureSampleOffset = 0;
  private stateValue: SessionState;

  constructor(id = `live-${randomUUID().replaceAll('-', '').slice(0, 24)}`, options: LiveSessionOptions = {}) {
    this.id = id;
    this.timelineStore = options.timelineStore;
    this.productCatalog = options.productCatalog;
    this.ruleCatalog = options.ruleCatalog;
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
    if (this.stateValue.isListening) return;
    this.archiveQueue?.pause?.(this.id);
    const occurredAt = this.now();
    this.recordingStartedAt ??= occurredAt;
    this.currentCaptureOffsetMs = this.offsetAt(occurredAt);
    this.currentCaptureSampleOffset = Math.floor((this.timelineStore?.getAudioByteLength(this.id) ?? 0) / 2);
    this.stateValue.isListening = true;
    this.stateValue.lastEventAt = occurredAt;
    this.recordTimeline('capture.started', occurredAt, this.currentCaptureOffsetMs, this.stateValue.product.id, {
      audioSampleOffset: this.currentCaptureSampleOffset,
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    });
    this.speechStream = createVolcSpeechStream({
      onResult: ({ text, isFinal, startTimeMs, endTimeMs }) => {
        if (this.stateValue.isListening) this.ingestTranscript(text, isFinal, { startTimeMs, endTimeMs });
      },
      onError: (error) => this.handleSpeechFailure(error),
      onReady: () => this.status('火山实时语音已连接', 'success'),
    });
    this.speechStream?.connect();
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(this.speechStream ? '正在连接火山实时语音' : '演示模式已启动，可用快捷语句模拟收音', this.speechStream ? 'neutral' : 'success');
  }

  stopListening(): void {
    if (!this.stateValue.isListening) return;
    const occurredAt = this.now();
    this.speechStream?.finish();
    this.speechStream?.close();
    this.speechStream = null;
    this.stateValue.isListening = false;
    this.stateValue.partialTranscript = '';
    this.stateValue.lastEventAt = occurredAt;
    this.recordTimeline('capture.stopped', occurredAt, this.offsetAt(occurredAt), this.stateValue.product.id, {
      audioSampleOffset: Math.floor((this.timelineStore?.getAudioByteLength(this.id) ?? 0) / 2),
    });
    this.archiveQueue?.enqueue(this.id);
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status('已停止收音', 'neutral');
  }

  ingestAudio(audio: Buffer): void {
    if (!this.stateValue.isListening) return;
    this.timelineStore?.appendAudio(this.id, audio);
    this.speechStream?.sendAudio(audio);
  }

  ingestSourceAudio(audio: Buffer, sampleRate: number): void {
    if (!this.stateValue.isListening) return;
    this.timelineStore?.appendSourceAudio(this.id, audio, sampleRate);
  }

  private handleSpeechFailure(error: Error): void {
    if (!this.stateValue.isListening) return;
    const occurredAt = this.now();
    this.speechStream?.close();
    this.speechStream = null;
    this.stateValue.isListening = false;
    this.stateValue.partialTranscript = '';
    this.stateValue.lastEventAt = occurredAt;
    this.recordTimeline('capture.failed', occurredAt, this.offsetAt(occurredAt), this.stateValue.product.id, { message: error.message });
    this.archiveQueue?.enqueue(this.id);
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(`火山语音连接异常，已停止收音：${error.message}`, 'error');
  }

  ingestTranscript(rawText: string, isFinal = true, timing: TranscriptTiming = {}): void {
    const text = rawText.trim();
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

  correctTranscript(segmentId: string, correctedText: string, actorId = this.actorId): void {
    const text = correctedText.trim();
    if (!text) return;
    const index = this.stateValue.transcriptHistory.findIndex((segment) => segment.id === segmentId && segment.isFinal);
    if (index < 0) return;
    const original = this.stateValue.transcriptHistory[index];
    const correctedAt = this.now();
    const corrected = { ...original, text };
    this.segmentRevisions.set(segmentId, (this.segmentRevisions.get(segmentId) ?? 0) + 1);
    const history = [...this.stateValue.transcriptHistory];
    history[index] = corrected;
    this.stateValue.transcriptHistory = history;
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
    this.recordTimeline('transcript.corrected', correctedAt, corrected.endOffsetMs, this.stateValue.product.id, {
      segmentId,
      originalText: original.text,
      correctedText: text,
      actorId,
    });
    this.broadcast({ type: 'transcript.final', segment: corrected });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.enqueueCompliance(corrected);
  }

  private enqueueCompliance(segment: TranscriptSegment): void {
    const generation = this.productGeneration;
    const product = this.stateValue.product;
    const revision = this.segmentRevisions.get(segment.id) ?? 0;
    this.analysisQueue = this.analysisQueue
      .then(() => this.checkCompliance(segment.text, generation, product.id, product, segment, revision))
      .catch((error: unknown) => this.status(`合规分析暂时不可用：${error instanceof Error ? error.message : String(error)}`, 'error'));
  }

  private async checkCompliance(transcript: string, generation: number, productId: string, product: Product, segment: TranscriptSegment, revision: number): Promise<void> {
    const analyzed = await this.analyzer.analyze({ roomId: this.roomId, productId, transcript, product, customRules: this.ruleCatalog?.listActive(this.roomId) });
    if (generation !== this.productGeneration || productId !== this.stateValue.product.id || revision !== this.segmentRevisions.get(segment.id)) return;
    const result = { ...analyzed, segmentId: segment.id };
    this.complianceBySegment.set(segment.id, result);
    this.stateValue.latestCompliance = result;
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
      knowledgeEvidence: result.knowledgeEvidence ?? [],
    });
    this.broadcast({ type: 'compliance.result', result });
    this.broadcast({ type: 'state.snapshot', state: this.state });
  }

  private restorePersistedState(): void {
    const timeline = this.timelineStore?.exportSession(this.id);
    if (!timeline) return;
    const transcripts = new Map<string, TranscriptSegment>();
    const results = new Map<string, ComplianceResult>();
    let selectedProductId = this.stateValue.product.id;
    let productContextStartedAt = this.stateValue.productContextStartedAt;
    let maximumOffsetMs = 0;

    for (const event of timeline.events) {
      maximumOffsetMs = Math.max(maximumOffsetMs, event.offsetMs ?? 0);
      this.stateValue.lastEventAt = Math.max(this.stateValue.lastEventAt, event.occurredAt);
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
