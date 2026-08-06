import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionTimelineExport, TimelineAudioAsset, TimelineEvent, TimelineEventType } from '../src/shared/types';

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = CHANNELS * (BITS_PER_SAMPLE / 8);

export type TimelineEventInput = {
  type: TimelineEventType;
  occurredAt: number;
  offsetMs: number | null;
  productId: string | null;
  payload?: Record<string, unknown>;
};

export interface TimelineWriter {
  appendEvent(sessionId: string, input: TimelineEventInput): TimelineEvent;
  appendAudio(sessionId: string, audio: Buffer): void;
  getAudioByteLength(sessionId: string): number;
  appendSourceAudio(sessionId: string, audio: Buffer, sampleRate: number): void;
  getSessionTiming(sessionId: string): { createdAt: number | null; recordingStartedAt: number | null };
  exportSession(sessionId: string): SessionTimelineExport | null;
}

function assertSessionId(sessionId: string): void {
  if (!/^[a-z0-9-]{4,64}$/iu.test(sessionId)) throw new Error('invalid session id');
}

export class FileTimelineStore implements TimelineWriter {
  constructor(private readonly rootDirectory = path.resolve(process.cwd(), '.data/timeline')) {}

  appendEvent(sessionId: string, input: TimelineEventInput): TimelineEvent {
    const directory = this.ensureSessionDirectory(sessionId);
    const event: TimelineEvent = {
      schemaVersion: 1,
      id: `event-${randomUUID()}`,
      sessionId,
      type: input.type,
      occurredAt: input.occurredAt,
      occurredAtIso: new Date(input.occurredAt).toISOString(),
      timezone: 'Asia/Shanghai',
      offsetMs: input.offsetMs,
      productId: input.productId,
      payload: input.payload ?? {},
    };
    appendFileSync(path.join(directory, 'timeline.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  appendAudio(sessionId: string, audio: Buffer): void {
    if (audio.length === 0) return;
    if (audio.length % BYTES_PER_SAMPLE !== 0) throw new Error('PCM16 audio must contain complete samples');
    const directory = this.ensureSessionDirectory(sessionId);
    appendFileSync(path.join(directory, 'audio.pcm'), audio);
  }

  readAudio(sessionId: string): Buffer | null {
    const audioPath = this.getAudioPath(sessionId);
    return audioPath ? readFileSync(audioPath) : null;
  }

  getAudioByteLength(sessionId: string): number {
    const audioPath = this.getAudioPath(sessionId);
    return audioPath ? statSync(audioPath).size : 0;
  }

  appendSourceAudio(sessionId: string, audio: Buffer, sampleRate: number): void {
    if (audio.length === 0) return;
    if (audio.length % BYTES_PER_SAMPLE !== 0) throw new Error('PCM16 audio must contain complete samples');
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000) throw new Error('invalid source audio sample rate');
    const directory = this.ensureSessionDirectory(sessionId);
    const tracks = this.getSourceTracks(sessionId);
    let track = tracks.find((candidate) => candidate.sampleRate === sampleRate);
    if (!track) {
      track = { sampleRate, fileName: `audio.source.${tracks.length}.pcm` };
      tracks.push(track);
      writeFileSync(path.join(directory, 'audio.source.json'), JSON.stringify({ encoding: 'pcm_s16le', channels: 1, bitsPerSample: 16, tracks }), 'utf8');
    }
    appendFileSync(path.join(directory, track.fileName), audio);
  }

  getSourceAudioByteLength(sessionId: string, trackIndex = 0): number {
    const audioPath = this.getSourceAudioPath(sessionId, trackIndex);
    return audioPath ? statSync(audioPath).size : 0;
  }

  readSourceAudio(sessionId: string, trackIndex = 0): Buffer | null {
    const audioPath = this.getSourceAudioPath(sessionId, trackIndex);
    return audioPath ? readFileSync(audioPath) : null;
  }

  getAudioPath(sessionId: string): string | null {
    const filePath = this.sessionPath(sessionId, 'audio.pcm');
    return existsSync(filePath) ? filePath : null;
  }

  getSourceAudioPath(sessionId: string, trackIndex = 0): string | null {
    const track = this.getSourceTracks(sessionId)[trackIndex];
    if (!track) return null;
    const filePath = this.sessionPath(sessionId, track.fileName);
    return existsSync(filePath) ? filePath : null;
  }

  getWavHeader(sessionId: string, source = false, trackIndex = 0): Buffer | null {
    const audio = this.getAudioAsset(sessionId, source, trackIndex);
    if (!audio) return null;
    if (audio.byteLength > 0xffffffff - 44) throw new Error('audio file is too large for WAV');
    const byteRate = audio.sampleRate * BYTES_PER_SAMPLE;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(audio.byteLength + 36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(audio.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
    header.writeUInt16LE(BITS_PER_SAMPLE, 34);
    header.write('data', 36);
    header.writeUInt32LE(audio.byteLength, 40);
    return header;
  }

  exportSession(sessionId: string): SessionTimelineExport | null {
    const events = this.readEvents(sessionId);
    if (events.length === 0) return null;
    const created = events.find((event) => event.type === 'session.created');
    const recordingStarted = events.find((event) => event.type === 'capture.started');
    return {
      schemaVersion: 1,
      sessionId,
      timezone: 'Asia/Shanghai',
      createdAt: created?.occurredAt ?? events[0].occurredAt,
      recordingStartedAt: recordingStarted?.occurredAt ?? null,
      audio: this.getAudioAsset(sessionId),
      sourceAudio: this.getSourceTracks(sessionId).map((_track, index) => this.getAudioAsset(sessionId, true, index)).filter((asset): asset is TimelineAudioAsset => asset !== null),
      events,
    };
  }

  getSessionTiming(sessionId: string): { createdAt: number | null; recordingStartedAt: number | null } {
    const events = this.readEvents(sessionId);
    return {
      createdAt: events.find((event) => event.type === 'session.created')?.occurredAt ?? null,
      recordingStartedAt: events.find((event) => event.type === 'capture.started')?.occurredAt ?? null,
    };
  }

  toJsonLines(sessionId: string): string | null {
    const filePath = this.sessionPath(sessionId, 'timeline.jsonl');
    return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  }

  private readEvents(sessionId: string): TimelineEvent[] {
    const jsonLines = this.toJsonLines(sessionId);
    if (!jsonLines) return [];
    const events: TimelineEvent[] = [];
    for (const line of jsonLines.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as TimelineEvent);
      } catch {
        // A malformed or partially-written record must not hide the remaining usable timeline.
      }
    }
    return events;
  }

  private getAudioAsset(sessionId: string, source = false, trackIndex = 0): TimelineAudioAsset | null {
    const audioPath = source ? this.getSourceAudioPath(sessionId, trackIndex) : this.getAudioPath(sessionId);
    if (!audioPath) return null;
    const byteLength = statSync(audioPath).size;
    const sampleRate = source ? this.getSourceTracks(sessionId)[trackIndex]?.sampleRate : SAMPLE_RATE;
    if (!sampleRate) return null;
    const sampleCount = Math.floor(byteLength / BYTES_PER_SAMPLE);
    return {
      assetId: source ? `source-${trackIndex}` : 'asr',
      encoding: 'pcm_s16le',
      sampleRate,
      channels: CHANNELS,
      bitsPerSample: BITS_PER_SAMPLE,
      byteLength,
      sampleCount,
      durationMs: Math.round((sampleCount / sampleRate) * 1_000),
      pcmUrl: source ? `/api/session/${sessionId}/audio-source.pcm?track=${trackIndex}` : `/api/session/${sessionId}/audio.pcm`,
      wavUrl: source ? `/api/session/${sessionId}/audio-source.wav?track=${trackIndex}` : `/api/session/${sessionId}/audio.wav`,
    };
  }

  private getSourceTracks(sessionId: string): Array<{ sampleRate: number; fileName: string }> {
    const metadataPath = this.sessionPath(sessionId, 'audio.source.json');
    if (!existsSync(metadataPath)) return [];
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { tracks?: Array<{ sampleRate?: number; fileName?: string }> };
    return (metadata.tracks ?? []).filter((track): track is { sampleRate: number; fileName: string } => typeof track.sampleRate === 'number' && typeof track.fileName === 'string');
  }

  private ensureSessionDirectory(sessionId: string): string {
    const directory = this.sessionPath(sessionId);
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  private sessionPath(sessionId: string, fileName?: string): string {
    assertSessionId(sessionId);
    return fileName ? path.join(this.rootDirectory, sessionId, fileName) : path.join(this.rootDirectory, sessionId);
  }
}
