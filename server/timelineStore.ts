import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  finalizeAudio(sessionId: string): void;
  getSessionTiming(sessionId: string): { createdAt: number | null; recordingStartedAt: number | null };
  exportSession(sessionId: string): SessionTimelineExport | null;
}

const AUDIO_CHUNK_DIRECTORY = 'audio.chunks';

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
    this.appendChunk(sessionId, 'asr', audio);
  }

  readAudio(sessionId: string): Buffer | null {
    const audioPath = this.getAudioPath(sessionId);
    return audioPath ? readFileSync(audioPath) : null;
  }

  getAudioByteLength(sessionId: string): number {
    const audioPath = this.getAudioPath(sessionId);
    return audioPath ? statSync(audioPath).size : this.chunkByteLength(sessionId, 'asr');
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
      const metadataPath = path.join(directory, 'audio.source.json');
      const temporaryPath = `${metadataPath}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({ encoding: 'pcm_s16le', channels: 1, bitsPerSample: 16, tracks }), 'utf8');
      renameSync(temporaryPath, metadataPath);
    }
    this.appendChunk(sessionId, `source-${tracks.indexOf(track)}`, audio);
  }

  getSourceAudioByteLength(sessionId: string, trackIndex = 0): number {
    const audioPath = this.getSourceAudioPath(sessionId, trackIndex);
    return audioPath ? statSync(audioPath).size : this.chunkByteLength(sessionId, `source-${trackIndex}`);
  }

  finalizeAudio(sessionId: string): void {
    const directory = this.ensureSessionDirectory(sessionId);
    this.mergeChunks(sessionId, 'asr', path.join(directory, 'audio.pcm'));
    const tracks = this.getSourceTracks(sessionId);
    tracks.forEach((_track, index) => this.mergeChunks(sessionId, `source-${index}`, path.join(directory, tracks[index].fileName)));
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
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { tracks?: Array<{ sampleRate?: number; fileName?: string }> };
      return (metadata.tracks ?? []).filter((track): track is { sampleRate: number; fileName: string } => typeof track.sampleRate === 'number' && typeof track.fileName === 'string');
    } catch {
      return [];
    }
  }

  private ensureSessionDirectory(sessionId: string): string {
    const directory = this.sessionPath(sessionId);
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  private appendChunk(sessionId: string, streamName: string, audio: Buffer): void {
    const directory = path.join(this.ensureSessionDirectory(sessionId), AUDIO_CHUNK_DIRECTORY, streamName);
    mkdirSync(directory, { recursive: true });
    const index = this.chunkFiles(sessionId, streamName).length;
    writeFileSync(path.join(directory, `${index.toString().padStart(8, '0')}.pcm`), audio, { flag: 'wx' });
  }

  private chunkFiles(sessionId: string, streamName: string): string[] {
    const directory = this.sessionPath(sessionId, path.join(AUDIO_CHUNK_DIRECTORY, streamName));
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((fileName) => /^\d{8}\.pcm$/u.test(fileName))
      .sort()
      .map((fileName) => path.join(directory, fileName));
  }

  private chunkByteLength(sessionId: string, streamName: string): number {
    return this.chunkFiles(sessionId, streamName).reduce((total, filePath) => total + statSync(filePath).size, 0);
  }

  private mergeChunks(sessionId: string, streamName: string, targetPath: string): void {
    const chunks = this.chunkFiles(sessionId, streamName);
    if (chunks.length === 0) return;
    const temporaryPath = `${targetPath}.tmp`;
    rmSync(temporaryPath, { force: true });
    for (const chunk of chunks) appendFileSync(temporaryPath, readFileSync(chunk));
    renameSync(temporaryPath, targetPath);
    rmSync(path.dirname(chunks[0]), { recursive: true, force: true });
  }

  private sessionPath(sessionId: string, fileName?: string): string {
    assertSessionId(sessionId);
    return fileName ? path.join(this.rootDirectory, sessionId, fileName) : path.join(this.rootDirectory, sessionId);
  }
}
