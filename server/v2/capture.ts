import { createDoubaoStreamingAsr, getStreamingAsrConfig, type StreamingAsrResult } from '../providers/doubaoStreamingAsr';
import type { CapturePort } from './liveSession';
import type { AudioTrack } from '../../src/shared/v2Audio';

export type CaptureAsrStream = { connect(): void; sendAudio(audio: Buffer): void; finish(): void; close(): void };
export type CaptureAsrFactory = (options: {
  onResult: (result: StreamingAsrResult) => void;
  onError: (error: Error) => void;
  onReady: () => void;
  onClosed: () => void;
  context?: string;
}) => CaptureAsrStream | null;

const RECOVERY_DELAYS_MS = [250, 750, 1_500];

function recoverable(error: Error): boolean {
  return /45000081|Timeout waiting next packet|连接已断开|ECONNRESET|socket hang up|WebSocket.*closed/iu.test(error.message);
}

export class CaptureModule implements CapturePort {
  private stream: CaptureAsrStream | null = null;
  private active = false;
  private readonly createAsr: CaptureAsrFactory;
  private readonly drainTimeoutMs: number;
  private endWaiter: { resolve: () => void; timer: NodeJS.Timeout } | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private recoveryAttempt = 0;
  private generation = 0;
  private recoveryScheduled = false;
  private audioTimelineMs = 0;

  constructor(private readonly options: {
    onPartial: (result: StreamingAsrResult) => void;
    onFinal: (result: StreamingAsrResult) => void;
    onError: (error: Error) => void;
    onAudio?: (pcm: Uint8Array, sampleRate: number, channels: number, track: AudioTrack) => void;
    asrContext?: () => string | undefined;
    createAsr?: CaptureAsrFactory;
    drainTimeoutMs?: number;
  }) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? 2_000;
    this.createAsr = options.createAsr ?? ((streamOptions) => createDoubaoStreamingAsr({
      onResult: streamOptions.onResult,
      onError: streamOptions.onError,
      onReady: streamOptions.onReady,
      onClosed: streamOptions.onClosed,
      context: streamOptions.context,
    }));
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.recoveryAttempt = 0;
    this.connect();
  }

  private connect(): void {
    if (!this.active) return;
    const generation = ++this.generation;
    const streamBaseOffsetMs = this.audioTimelineMs;
    this.recoveryScheduled = false;
    let stream: CaptureAsrStream | null = null;
    stream = this.createAsr({
      context: this.options.asrContext?.(),
      onResult: (result) => {
        if (generation !== this.generation) return;
        if (!this.active && !this.endWaiter) return;
        const timelineResult: StreamingAsrResult = {
          ...result,
          ...(typeof result.startTimeMs === 'number' ? { startTimeMs: streamBaseOffsetMs + result.startTimeMs } : {}),
          ...(typeof result.endTimeMs === 'number' ? { endTimeMs: streamBaseOffsetMs + result.endTimeMs } : {}),
        };
        if (result.isFinal) this.options.onFinal(timelineResult); else this.options.onPartial(timelineResult);
      },
      onError: (error) => {
        if (generation !== this.generation) return;
        if (this.active && recoverable(error) && this.recoveryAttempt < RECOVERY_DELAYS_MS.length) {
          this.scheduleRecovery(stream);
          return;
        }
        this.active = false;
        this.clearRecovery();
        this.options.onError(error);
      },
      onReady: () => {
        if (generation !== this.generation) return;
        this.recoveryScheduled = false;
        if (this.stableTimer) clearTimeout(this.stableTimer);
        this.stableTimer = setTimeout(() => { this.stableTimer = null; if (this.active && generation === this.generation) this.recoveryAttempt = 0; }, 10_000);
        this.stableTimer.unref();
      },
      onClosed: () => {
        if (generation !== this.generation) return;
        if (this.endWaiter) this.finishWaiter();
        else if (this.active && !this.recoveryScheduled && this.recoveryAttempt < RECOVERY_DELAYS_MS.length) this.scheduleRecovery(stream);
      },
    });
    this.stream = stream;
    stream?.connect();
  }

  pause(): void {
    if (!this.active) return;
    this.active = false;
    this.clearRecovery();
    this.stream?.finish();
    this.stream = null;
  }

  resume(): void {
    this.start();
  }

  end(): Promise<void> {
    if (!this.active && !this.stream) return Promise.resolve();
    this.active = false;
    this.clearRecovery();
    const stream = this.stream;
    this.stream = null;
    if (!stream) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.endWaiter = null;
        stream.close();
        resolve();
      }, this.drainTimeoutMs);
      timer.unref();
      this.endWaiter = { resolve, timer };
      stream.finish();
    });
  }

  pushAudio(pcm: Uint8Array, _sampleRate: number, _channels = 1, track: AudioTrack = 'asr'): void {
    if (!this.active || pcm.byteLength === 0) return;
    this.options.onAudio?.(pcm, _sampleRate, _channels, track);
    if (track === 'source') return;
    this.audioTimelineMs += pcm.byteLength / Math.max(1, _sampleRate * _channels * 2) * 1_000;
    this.stream?.sendAudio(Buffer.from(pcm));
  }

  close(): void {
    this.active = false;
    this.clearRecovery();
    this.stream?.close();
    this.stream = null;
    this.finishWaiter();
  }

  private finishWaiter(): void {
    const waiter = this.endWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.endWaiter = null;
    waiter.resolve();
  }

  private scheduleRecovery(stream: CaptureAsrStream | null): void {
    if (!this.active || this.recoveryScheduled) return;
    this.recoveryScheduled = true;
    stream?.close();
    if (this.stream === stream) this.stream = null;
    const delay = RECOVERY_DELAYS_MS[this.recoveryAttempt++];
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (!this.active) return;
      this.connect();
    }, delay);
    this.recoveryTimer.unref();
  }

  private clearRecovery(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.recoveryTimer = null;
    this.stableTimer = null;
    this.recoveryScheduled = false;
  }
}

export function createCaptureModule(options: ConstructorParameters<typeof CaptureModule>[0]): CaptureModule {
  return new CaptureModule(options);
}

export function streamingAsrConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getStreamingAsrConfig(env));
}
