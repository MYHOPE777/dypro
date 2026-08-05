import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export type SpeechResult = { text: string; isFinal: boolean };

export type VolcSpeechOptions = {
  onResult: (result: SpeechResult) => void;
  onError: (error: Error) => void;
};

type VolcConfig = {
  appKey: string;
  accessKey: string;
  resourceId: string;
  endpoint: string;
};

const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';

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
  const text = typeof result.text === 'string' ? result.text : '';
  if (!text) return null;
  return {
    text,
    isFinal: Boolean(payload.is_final ?? payload.definite) || flags === 3,
  };
}

export class VolcSpeechStream {
  private socket: WebSocket | null = null;
  private sequence = 1;
  private manuallyClosed = false;

  constructor(private readonly config: VolcConfig, private readonly options: VolcSpeechOptions) {}

  connect(): void {
    this.manuallyClosed = false;
    this.socket = new WebSocket(this.config.endpoint, {
      headers: {
        'X-Api-App-Key': this.config.appKey,
        'X-Api-Access-Key': this.config.accessKey,
        'X-Api-Resource-Id': this.config.resourceId,
        'X-Api-Connect-Id': randomUUID(),
      },
    });
    this.socket.on('open', () => this.socket?.send(buildFullClientRequest()));
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
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(buildAudioFrame(audio, false, this.sequence++));
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
  }
}

export function createVolcSpeechStream(options: VolcSpeechOptions): VolcSpeechStream | null {
  const config = getVolcConfig();
  return config ? new VolcSpeechStream(config, options) : null;
}
