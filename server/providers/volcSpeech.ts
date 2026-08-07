import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export type SpeechResult = { text: string; isFinal: boolean; startTimeMs?: number; endTimeMs?: number };

export type VolcSpeechOptions = {
  onResult: (result: SpeechResult) => void;
  onError: (error: Error) => void;
  onReady?: () => void;
};

type VolcConfig = {
  appKey: string;
  accessKey: string;
  resourceId: string;
  endpoint: string;
};

type SpeechSocket = {
  readyState: number;
  on(event: 'open', listener: () => void): SpeechSocket;
  on(event: 'message', listener: (data: unknown) => void): SpeechSocket;
  on(event: 'error', listener: (error: Error) => void): SpeechSocket;
  on(event: 'close', listener: () => void): SpeechSocket;
  send(data: Buffer): void;
  close(): void;
};

type SpeechSocketFactory = (endpoint: string, headers: Record<string, string>) => SpeechSocket;

const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
const MAX_PENDING_AUDIO_BYTES = 160_000;

export function getVolcConfig(env: NodeJS.ProcessEnv = process.env): VolcConfig | null {
  const appKey = env.VOLC_SPEECH_APP_KEY;
  const accessKey = env.VOLC_SPEECH_ACCESS_KEY;
  if (!appKey || !accessKey) return null;
  return {
    appKey,
    accessKey,
    resourceId: env.VOLC_SPEECH_RESOURCE_ID ?? 'volc.bigasr.sauc.duration',
    endpoint: env.VOLC_SPEECH_ENDPOINT ?? DEFAULT_ENDPOINT,
  };
}

function makeFrame(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
  payload: Buffer,
  sequence?: number,
): Buffer {
  const hasSequence = flags === 1 || flags === 2;
  const header = Buffer.from([0x11, (messageType << 4) | flags, (serialization << 4) | compression, 0]);
  const extension = hasSequence ? Buffer.alloc(4) : Buffer.alloc(0);
  if (hasSequence) extension.writeInt32BE(sequence ?? 1, 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, extension, length, payload]);
}

export function buildFullClientRequest(): Buffer {
  const request = {
    user: { uid: randomUUID() },
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
      result_type: 'full',
    },
  };
  return makeFrame(1, 0, 1, 1, gzipSync(Buffer.from(JSON.stringify(request))));
}

export function buildAudioFrame(audio: Buffer, isFinal = false, sequence = 1): Buffer {
  const flags = isFinal ? 2 : 0;
  return makeFrame(2, flags, 0, 1, gzipSync(audio), sequence);
}

export function parseResponseFrame(frame: Buffer): SpeechResult | null {
  if (frame.length < 8) return null;
  const headerSize = (frame[0] & 0x0f) * 4;
  const messageType = (frame[1] >> 4) & 0x0f;
  const flags = frame[1] & 0x0f;
  const compression = frame[2] & 0x0f;
  let cursor = headerSize;
  if (flags > 0) cursor += 4;
  if (cursor + 4 > frame.length) return null;
  const payloadSize = frame.readUInt32BE(cursor);
  cursor += 4;
  if (cursor + payloadSize > frame.length) return null;
  const encoded = frame.subarray(cursor, cursor + payloadSize);
  if (messageType === 0x0f) {
    throw new Error(encoded.toString('utf8'));
  }
  if (messageType !== 0x09) return null;
  const decoded = compression === 1 ? gunzipSync(encoded) : encoded;
  const payload = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
  const result = (payload.result ?? payload.payload ?? payload) as Record<string, unknown>;
  const utterances = Array.isArray(result.utterances) ? result.utterances as Array<Record<string, unknown>> : [];
  const latestUtterance = utterances.at(-1);
  const text = typeof result.text === 'string' ? result.text : typeof latestUtterance?.text === 'string' ? latestUtterance.text : '';
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

export class VolcSpeechStream {
  private socket: SpeechSocket | null = null;
  private sequence = 1;
  private manuallyClosed = false;
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;

  constructor(
    private readonly config: VolcConfig,
    private readonly options: VolcSpeechOptions,
    private readonly socketFactory: SpeechSocketFactory = (endpoint, headers) => new WebSocket(endpoint, { headers }),
  ) {}

  connect(): void {
    this.manuallyClosed = false;
    this.sequence = 1;
    this.socket = this.socketFactory(this.config.endpoint, {
      'X-Api-App-Key': this.config.appKey,
      'X-Api-Access-Key': this.config.accessKey,
      'X-Api-Resource-Id': this.config.resourceId,
      'X-Api-Connect-Id': randomUUID(),
    });
    this.socket.on('open', () => {
      this.socket?.send(buildFullClientRequest());
      for (const audio of this.pendingAudio) this.socket?.send(buildAudioFrame(audio, false, this.sequence++));
      this.pendingAudio = [];
      this.pendingAudioBytes = 0;
      this.options.onReady?.();
    });
    this.socket.on('message', (data) => {
      try {
        const result = parseResponseFrame(Buffer.from(data as Buffer));
        if (result) this.options.onResult(result);
      } catch (error) {
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.socket.on('error', (error) => this.options.onError(error));
    this.socket.on('close', () => {
      if (!this.manuallyClosed) this.options.onError(new Error('火山语音连接已断开'));
    });
  }

  sendAudio(audio: Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(buildAudioFrame(audio, false, this.sequence++));
      return;
    }
    if (this.socket?.readyState !== WebSocket.CONNECTING) return;
    if (this.pendingAudioBytes + audio.length > MAX_PENDING_AUDIO_BYTES) {
      this.options.onError(new Error('火山语音连接超时，开场音频缓冲已满'));
      return;
    }
    const copy = Buffer.from(audio);
    this.pendingAudio.push(copy);
    this.pendingAudioBytes += copy.length;
  }

  finish(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(buildAudioFrame(Buffer.alloc(0), true, -this.sequence++));
    }
  }

  close(): void {
    this.manuallyClosed = true;
    this.socket?.close();
    this.socket = null;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
  }
}

export function createVolcSpeechStream(options: VolcSpeechOptions): VolcSpeechStream | null {
  const config = getVolcConfig();
  return config ? new VolcSpeechStream(config, options) : null;
}
