import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export type StreamingAsrResult = { text: string; isFinal: boolean; startTimeMs?: number; endTimeMs?: number };

export type StreamingAsrDiagnostics = {
  logId?: string;
  lastAudioPacketAt?: number;
  lastAudioPacketGapMs?: number;
  lastAudioPacketKind?: 'microphone' | 'keepalive';
  pendingAudioBytes: number;
  socketReadyState: number | null;
};

export class StreamingAsrProviderError extends Error {
  constructor(message: string, readonly diagnostics: StreamingAsrDiagnostics) {
    super(message);
    this.name = 'StreamingAsrProviderError';
  }
}

export type StreamingAsrOptions = {
  onResult: (result: StreamingAsrResult) => void;
  onError: (error: Error) => void;
  onReady?: (logId?: string) => void;
  onClosed?: () => void;
  /** Serialized value for the official request.corpus.context field. */
  context?: string;
};

export type StreamingAsrConfig = {
  /** New console App Key, sent as X-Api-Key. */
  apiKey?: string;
  /** Legacy console APP ID, sent as X-Api-App-Key. */
  appKey?: string;
  /** Legacy console Access Token, sent as X-Api-Access-Key. */
  accessKey?: string;
  resourceId: string;
  endpoint: string;
  hotwordTableId?: string;
  hotwordTableName?: string;
  correctTableId?: string;
  correctTableName?: string;
  context?: string;
  endWindowMs: number;
};

type SpeechResponse = {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  resume(): void;
};

type SpeechRequest = { destroy(error?: Error): void };

type SpeechSocket = {
  readyState: number;
  on(event: 'open', listener: () => void): SpeechSocket;
  on(event: 'message', listener: (data: unknown) => void): SpeechSocket;
  on(event: 'error', listener: (error: Error) => void): SpeechSocket;
  on(event: 'close', listener: () => void): SpeechSocket;
  on(event: 'upgrade', listener: (response: SpeechResponse) => void): SpeechSocket;
  on(event: 'unexpected-response', listener: (request: SpeechRequest, response: SpeechResponse) => void): SpeechSocket;
  send(data: Buffer): void;
  close(): void;
};

type SpeechSocketFactory = (endpoint: string, headers: Record<string, string>) => SpeechSocket;

const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
const MAX_PENDING_AUDIO_BYTES = 160_000;
const KEEP_ALIVE_CHECK_INTERVAL_MS = 200;
const KEEP_ALIVE_IDLE_MS = 400;
const KEEP_ALIVE_AUDIO = Buffer.alloc(3_200);

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function endWindowMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 200 ? parsed : 800;
}

export function getStreamingAsrConfig(env: NodeJS.ProcessEnv = process.env): StreamingAsrConfig | null {
  const apiKey = env.X_API_KEY?.trim();
  const appKey = optional(env.X_API_APP_KEY);
  const accessKey = optional(env.X_API_ACCESS_KEY);
  if (!apiKey && !(appKey && accessKey)) return null;
  return {
    ...(apiKey ? { apiKey } : { appKey, accessKey }),
    resourceId: env.X_API_RESOURCE_ID?.trim() || 'volc.seedasr.sauc.duration',
    endpoint: env.SPEECH_ENDPOINT?.trim() || DEFAULT_ENDPOINT,
    hotwordTableId: optional(env.BOOSTING_TABLE_ID),
    hotwordTableName: optional(env.BOOSTING_TABLE_NAME),
    correctTableId: optional(env.CORRECT_TABLE_ID),
    correctTableName: optional(env.CORRECT_TABLE_NAME),
    endWindowMs: endWindowMs(env.END_WINDOW_SIZE),
  };
}

/** Builds the official serialized request.corpus.context payload. */
export function buildStreamingAsrContext(hotwords: string[], contextData: string[]): string | undefined {
  const words = [...new Set(hotwords.map((word) => word.trim()).filter(Boolean))].slice(0, 20);
  const contexts = contextData.map((text) => text.trim()).filter(Boolean).slice(0, 20).map((text) => ({ text }));
  if (words.length === 0 && contexts.length === 0) return undefined;
  return JSON.stringify({
    ...(words.length > 0 ? { hotwords: words.map((word) => ({ word })) } : {}),
    context_type: 'dialog_ctx',
    ...(contexts.length > 0 ? { context_data: contexts } : {}),
  });
}

function makeFrame(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
  payload: Buffer,
  sequence?: number,
): Buffer {
  const hasSequence = flags === 1 || flags === 3;
  const header = Buffer.from([0x11, (messageType << 4) | flags, (serialization << 4) | compression, 0]);
  const extension = hasSequence ? Buffer.alloc(4) : Buffer.alloc(0);
  if (hasSequence) extension.writeInt32BE(sequence ?? 1, 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, extension, length, payload]);
}

export function buildFullClientRequest(config: Partial<StreamingAsrConfig> = {}): Buffer {
  const corpus = {
    ...(config.hotwordTableId ? { boosting_table_id: config.hotwordTableId } : config.hotwordTableName ? { boosting_table_name: config.hotwordTableName } : {}),
    ...(config.correctTableId ? { correct_table_id: config.correctTableId } : config.correctTableName ? { correct_table_name: config.correctTableName } : {}),
    ...(config.context ? { context: config.context } : {}),
  };
  const request = {
    user: { uid: randomUUID() },
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      enable_nonstream: true,
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      show_utterances: true,
      result_type: 'single',
      end_window_size: config.endWindowMs ?? 800,
      ...(Object.keys(corpus).length > 0 ? { corpus } : {}),
    },
  };
  return makeFrame(1, 0, 1, 1, gzipSync(Buffer.from(JSON.stringify(request))));
}

export function buildAudioFrame(audio: Buffer, isFinal = false): Buffer {
  // The optimized bidirectional endpoint assigns its own request sequence.
  // Sending a client sequence makes the server reject the stream as mismatched.
  const flags = isFinal ? 2 : 0;
  return makeFrame(2, flags, 0, 1, gzipSync(audio));
}

export function parseResponseFrame(frame: Buffer): StreamingAsrResult | null {
  if (frame.length < 8) return null;
  const headerSize = (frame[0] & 0x0f) * 4;
  const messageType = (frame[1] >> 4) & 0x0f;
  const flags = frame[1] & 0x0f;
  const compression = frame[2] & 0x0f;
  let cursor = headerSize;
  if (flags === 1 || flags === 3) cursor += 4;
  if (messageType === 0x0f) {
    if (cursor + 8 > frame.length) return null;
    const errorCode = frame.readUInt32BE(cursor);
    cursor += 4;
    const payloadSize = frame.readUInt32BE(cursor);
    cursor += 4;
    if (cursor + payloadSize > frame.length) return null;
    const payload = frame.subarray(cursor, cursor + payloadSize);
    throw new Error(`豆包大模型流式语音识别错误 ${errorCode}: ${payload.toString('utf8')}`);
  }
  if (cursor + 4 > frame.length) return null;
  const payloadSize = frame.readUInt32BE(cursor);
  cursor += 4;
  if (cursor + payloadSize > frame.length) return null;
  const encoded = frame.subarray(cursor, cursor + payloadSize);
  if (messageType !== 0x09) return null;
  const decoded = compression === 1 ? gunzipSync(encoded) : encoded;
  const payload = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
  const result = (payload.result ?? payload.payload ?? payload) as Record<string, unknown>;
  const utterances = Array.isArray(result.utterances) ? result.utterances as Array<Record<string, unknown>> : [];
  const latestUtterance = utterances.at(-1);
  const text = typeof latestUtterance?.text === 'string' ? latestUtterance.text : typeof result.text === 'string' ? result.text : '';
  if (!text) return null;
  const startTimeMs = typeof latestUtterance?.start_time === 'number' ? latestUtterance.start_time : undefined;
  const endTimeMs = typeof latestUtterance?.end_time === 'number' ? latestUtterance.end_time : undefined;
  return {
    text,
    isFinal: Boolean(payload.is_final ?? payload.definite ?? result.definite ?? latestUtterance?.definite) || flags === 3,
    ...(startTimeMs === undefined ? {} : { startTimeMs }),
    ...(endTimeMs === undefined ? {} : { endTimeMs }),
  };
}

export class DoubaoStreamingAsr {
  private socket: SpeechSocket | null = null;
  private manuallyClosed = false;
  private finishRequested = false;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private lastAudioPacketAt = 0;
  private lastAudioPacketKind: StreamingAsrDiagnostics['lastAudioPacketKind'];
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private logId: string | undefined;
  private failureReported = false;

  constructor(
    private readonly config: StreamingAsrConfig,
    private readonly options: StreamingAsrOptions,
    private readonly socketFactory: SpeechSocketFactory = (endpoint, headers) => new WebSocket(endpoint, { headers }),
  ) {}

  connect(): void {
    this.manuallyClosed = false;
    this.finishRequested = false;
    this.logId = undefined;
    this.failureReported = false;
    const requestId = randomUUID();
    const authHeaders: Record<string, string> = this.config.apiKey
      ? { 'X-Api-Key': this.config.apiKey }
      : { 'X-Api-App-Key': this.config.appKey!, 'X-Api-Access-Key': this.config.accessKey! };
    this.socket = this.socketFactory(this.config.endpoint, {
      ...authHeaders,
      'X-Api-Resource-Id': this.config.resourceId,
      'X-Api-Connect-Id': requestId,
      'X-Api-Request-Id': requestId,
    });
    this.socket.on('open', () => {
      this.socket?.send(buildFullClientRequest(this.config));
      for (const audio of this.pendingAudio) {
        this.socket?.send(buildAudioFrame(audio));
        this.lastAudioPacketAt = Date.now();
        this.lastAudioPacketKind = 'microphone';
      }
      this.pendingAudio = [];
      this.pendingAudioBytes = 0;
      if (this.finishRequested) this.socket?.send(buildAudioFrame(Buffer.alloc(0), true));
      else this.startKeepAlive();
      this.options.onReady?.(this.logId);
    });
    this.socket.on('upgrade', (response) => {
      this.logId = this.headerValue(response.headers['x-tt-logid']);
    });
    this.socket.on('unexpected-response', (request, response) => {
      this.logId = this.headerValue(response.headers['x-tt-logid']);
      response.resume();
      request.destroy();
      this.reportError(new Error(`豆包大模型流式语音识别握手失败（HTTP ${response.statusCode ?? 'unknown'}${this.logId ? `，Logid ${this.logId}` : ''}）`));
    });
    this.socket.on('message', (data) => {
      try {
        const result = parseResponseFrame(Buffer.from(data as Buffer));
        if (result) this.options.onResult(result);
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.socket.on('error', (error) => this.reportError(error));
    this.socket.on('close', () => {
      this.stopKeepAlive();
      if (!this.manuallyClosed && !this.finishRequested) this.reportError(new Error('豆包大模型流式语音识别连接已断开'));
      this.options.onClosed?.();
    });
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  private reportError(error: Error): void {
    if (this.failureReported) return;
    this.failureReported = true;
    const suffix = this.logId && !error.message.includes(this.logId) ? `（Logid ${this.logId}）` : '';
    const now = Date.now();
    this.options.onError(new StreamingAsrProviderError(`${error.message}${suffix}`, {
      ...(this.logId ? { logId: this.logId } : {}),
      ...(this.lastAudioPacketAt > 0 ? {
        lastAudioPacketAt: this.lastAudioPacketAt,
        lastAudioPacketGapMs: Math.max(0, now - this.lastAudioPacketAt),
      } : {}),
      ...(this.lastAudioPacketKind ? { lastAudioPacketKind: this.lastAudioPacketKind } : {}),
      pendingAudioBytes: this.pendingAudioBytes,
      socketReadyState: this.socket?.readyState ?? null,
    }));
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.lastAudioPacketAt = Date.now();
    this.keepAliveTimer = setInterval(() => {
      if (this.finishRequested || this.socket?.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (now - this.lastAudioPacketAt < KEEP_ALIVE_IDLE_MS) return;
      // The provider's 8-second idle timeout is reset by any ordinary audio frame.
      // Keepalive audio is sent only to ASR and is never persisted as source audio.
      this.socket.send(buildAudioFrame(KEEP_ALIVE_AUDIO));
      this.lastAudioPacketAt = now;
      this.lastAudioPacketKind = 'keepalive';
    }, KEEP_ALIVE_CHECK_INTERVAL_MS);
    this.keepAliveTimer.unref?.();
  }

  private stopKeepAlive(): void {
    if (!this.keepAliveTimer) return;
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  sendAudio(audio: Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(buildAudioFrame(audio));
      this.lastAudioPacketAt = Date.now();
      this.lastAudioPacketKind = 'microphone';
      return;
    }
    if (this.socket?.readyState !== WebSocket.CONNECTING) return;
    if (this.pendingAudioBytes + audio.length > MAX_PENDING_AUDIO_BYTES) {
      this.options.onError(new Error('豆包大模型流式语音识别连接超时，开场音频缓冲已满'));
      return;
    }
    const copy = Buffer.from(audio);
    this.pendingAudio.push(copy);
    this.pendingAudioBytes += copy.length;
  }

  finish(): void {
    this.finishRequested = true;
    this.stopKeepAlive();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(buildAudioFrame(Buffer.alloc(0), true));
    }
  }

  close(): void {
    this.manuallyClosed = true;
    this.finishRequested = true;
    this.stopKeepAlive();
    this.socket?.close();
    this.socket = null;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
  }
}

export function createDoubaoStreamingAsr(options: StreamingAsrOptions): DoubaoStreamingAsr | null {
  const config = getStreamingAsrConfig();
  return config ? new DoubaoStreamingAsr({ ...config, context: options.context }, options) : null;
}
