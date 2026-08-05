import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { createDoubaoAnalyzer } from './services';
import { createVolcSpeechStream, type VolcSpeechStream } from './providers/volcSpeech';
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

function createStats(): SessionStats {
  return { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 };
}

export class LiveSession {
  readonly id: string;
  readonly createdAt = Date.now();
  private readonly clients = new Set<Client>();
  private readonly analyzer = createDoubaoAnalyzer();
  private speechStream: VolcSpeechStream | null = null;
  private segmentNumber = 0;
  private productGeneration = 0;
  private analysisQueue: Promise<void> = Promise.resolve();
  private stateValue: SessionState;

  constructor(id = `live-${randomUUID().slice(0, 8)}`) {
    this.id = id;
    this.stateValue = {
      sessionId: id,
      product: DEFAULT_PRODUCT,
      isListening: false,
      partialTranscript: '',
      transcriptHistory: [],
      latestCompliance: null,
      alerts: [],
      stats: createStats(),
      lastEventAt: Date.now(),
    };
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
    return PRODUCTS;
  }

  selectProduct(productId: string): void {
    const product = PRODUCTS.find((item) => item.id === productId);
    if (!product) return;
    this.productGeneration += 1;
    this.stateValue.product = product;
    this.stateValue.latestCompliance = null;
    this.stateValue.partialTranscript = '';
    this.stateValue.lastEventAt = Date.now();
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(`已切换商品：${product.name}`, 'success');
  }

  startListening(): void {
    if (this.stateValue.isListening) return;
    this.stateValue.isListening = true;
    this.stateValue.lastEventAt = Date.now();
    this.speechStream = createVolcSpeechStream({
      onResult: ({ text, isFinal }) => this.ingestTranscript(text, isFinal),
      onError: (error) => this.handleSpeechFailure(error),
    });
    this.speechStream?.connect();
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(this.speechStream ? '火山实时语音已连接' : '演示模式已启动，可用快捷语句模拟收音', 'success');
  }

  stopListening(): void {
    if (!this.stateValue.isListening) return;
    this.speechStream?.finish();
    this.speechStream?.close();
    this.speechStream = null;
    this.stateValue.isListening = false;
    this.stateValue.partialTranscript = '';
    this.stateValue.lastEventAt = Date.now();
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status('已停止收音', 'neutral');
  }

  ingestAudio(audio: Buffer): void {
    this.speechStream?.sendAudio(audio);
  }

  private handleSpeechFailure(error: Error): void {
    if (!this.stateValue.isListening) return;
    this.speechStream?.close();
    this.speechStream = null;
    this.stateValue.isListening = false;
    this.stateValue.partialTranscript = '';
    this.stateValue.lastEventAt = Date.now();
    this.broadcast({ type: 'state.snapshot', state: this.state });
    this.status(`火山语音连接异常，已停止收音：${error.message}`, 'error');
  }

  ingestTranscript(rawText: string, isFinal = true): void {
    const text = rawText.trim();
    if (!text) return;
    const segment: TranscriptSegment = {
      id: `segment-${this.segmentNumber++}`,
      text,
      isFinal,
      timestamp: Date.now(),
    };
    this.stateValue.lastEventAt = Date.now();
    if (!isFinal) {
      this.stateValue.partialTranscript = text;
      this.broadcast({ type: 'transcript.partial', segment });
      return;
    }
    this.stateValue.partialTranscript = '';
    this.stateValue.transcriptHistory = [...this.stateValue.transcriptHistory, segment].slice(-20);
    this.stateValue.stats.words += text.replace(/\s/g, '').length;
    this.stateValue.stats.speakingSeconds = Math.round((Date.now() - this.createdAt) / 1000);
    this.broadcast({ type: 'transcript.final', segment });
    this.broadcast({ type: 'state.snapshot', state: this.state });
    const generation = this.productGeneration;
    const product = this.stateValue.product;
    this.analysisQueue = this.analysisQueue
      .then(() => this.checkCompliance(text, generation, product.id, product))
      .catch((error: unknown) => this.status(`合规分析暂时不可用：${error instanceof Error ? error.message : String(error)}`, 'error'));
  }

  private async checkCompliance(transcript: string, generation: number, productId: string, product: Product): Promise<void> {
    const result = await this.analyzer.analyze({ productId, transcript, product });
    if (generation !== this.productGeneration || productId !== this.stateValue.product.id) return;
    this.stateValue.latestCompliance = result;
    this.stateValue.stats[`${result.risk}Count` as 'safeCount' | 'warningCount' | 'blockedCount'] += 1;
    if (result.risk !== 'safe') {
      this.stateValue.alerts = [result, ...this.stateValue.alerts].slice(0, 12);
    }
    this.broadcast({ type: 'compliance.result', result });
    this.broadcast({ type: 'state.snapshot', state: this.state });
  }

  private status(message: string, tone: 'neutral' | 'success' | 'warning' | 'error'): void {
    this.broadcast({ type: 'system.status', message, tone });
  }

  private broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.socket.readyState === 1) client.socket.send(payload);
    }
  }
}
