import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTimelineStore } from '../../server/timelineStore';
import { LiveSession } from '../../server/session';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('session timeline export', () => {
  it('persists a final transcript with wall-clock and replay-relative timestamps', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'live-timeline-'));
    tempDirectories.push(directory);
    const timelineStore = new FileTimelineStore(directory);
    let now = Date.parse('2026-08-06T10:00:00.000Z');
    const session = new LiveSession('live-timeline-test', { timelineStore, now: () => now });

    now += 1_000;
    session.startListening();
    const originalAudio = Buffer.alloc(3_200, 0x2a);
    session.ingestAudio(originalAudio);
    const originalSourceAudio = Buffer.alloc(9_600, 0x19);
    session.ingestSourceAudio(originalSourceAudio, 48_000);
    now += 900;
    session.ingestTranscript('这款耳机适合日常通勤使用', true, { startTimeMs: 120, endTimeMs: 820 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timeline = timelineStore.exportSession(session.id);
    const transcript = timeline?.events.find((event) => event.type === 'transcript.final');
    expect(timeline?.recordingStartedAt).toBe(Date.parse('2026-08-06T10:00:01.000Z'));
    expect(timeline?.audio).toMatchObject({ encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1, byteLength: 3_200, durationMs: 100 });
    expect(timeline?.sourceAudio).toHaveLength(1);
    expect(timeline?.sourceAudio[0]).toMatchObject({ assetId: 'source-0', encoding: 'pcm_s16le', sampleRate: 48_000, channels: 1, byteLength: 9_600, durationMs: 100 });
    expect(timelineStore.readAudio(session.id)).toEqual(originalAudio);
    expect(timelineStore.readSourceAudio(session.id)).toEqual(originalSourceAudio);
    expect(transcript).toMatchObject({
      sessionId: 'live-timeline-test',
      occurredAt: Date.parse('2026-08-06T10:00:01.900Z'),
      occurredAtIso: '2026-08-06T10:00:01.900Z',
      offsetMs: 820,
      productId: 'serum',
      payload: { text: '这款耳机适合日常通勤使用', startOffsetMs: 120, endOffsetMs: 820 },
    });
  });

  it('wraps the original PCM in WAV without changing any captured sample bytes', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'live-audio-'));
    tempDirectories.push(directory);
    const timelineStore = new FileTimelineStore(directory);
    const sessionId = 'live-audio-test';
    const originalAudio = Buffer.from([0x00, 0x80, 0xff, 0x7f, 0x2a, 0x10]);
    timelineStore.appendEvent(sessionId, { type: 'session.created', occurredAt: 1, offsetMs: null, productId: 'serum' });
    timelineStore.appendAudio(sessionId, originalAudio);

    const header = timelineStore.getWavHeader(sessionId);
    expect(header?.toString('ascii', 0, 4)).toBe('RIFF');
    expect(header?.toString('ascii', 8, 12)).toBe('WAVE');
    expect(header?.readUInt32LE(40)).toBe(originalAudio.length);
    expect(Buffer.concat([header!, timelineStore.readAudio(sessionId)!]).subarray(44)).toEqual(originalAudio);
  });

  it('keeps separate source tracks when the browser sample rate changes', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'live-source-tracks-'));
    tempDirectories.push(directory);
    const timelineStore = new FileTimelineStore(directory);
    const sessionId = 'live-source-tracks';
    const first = Buffer.from([0x01, 0x02]);
    const second = Buffer.from([0x03, 0x04, 0x05, 0x06]);
    timelineStore.appendEvent(sessionId, { type: 'session.created', occurredAt: 1, offsetMs: null, productId: 'serum' });
    timelineStore.appendSourceAudio(sessionId, first, 48_000);
    timelineStore.appendSourceAudio(sessionId, second, 44_100);

    const timeline = timelineStore.exportSession(sessionId);
    expect(timeline?.sourceAudio.map((asset) => [asset.assetId, asset.sampleRate, asset.byteLength])).toEqual([
      ['source-0', 48_000, first.length],
      ['source-1', 44_100, second.length],
    ]);
    expect(timelineStore.readSourceAudio(sessionId, 0)).toEqual(first);
    expect(timelineStore.readSourceAudio(sessionId, 1)).toEqual(second);
  });

  it('ignores a malformed trailing JSONL record during export', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'live-jsonl-'));
    tempDirectories.push(directory);
    const timelineStore = new FileTimelineStore(directory);
    const sessionId = 'live-jsonl-test';
    timelineStore.appendEvent(sessionId, { type: 'session.created', occurredAt: 1, offsetMs: null, productId: 'serum' });
    appendFileSync(path.join(directory, sessionId, 'timeline.jsonl'), '{"type":"incomplete"');

    expect(timelineStore.exportSession(sessionId)?.events).toHaveLength(1);
  });

  it('rejects odd PCM byte counts', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'live-pcm-'));
    tempDirectories.push(directory);
    const timelineStore = new FileTimelineStore(directory);
    expect(() => timelineStore.appendAudio('live-pcm-test', Buffer.from([0x01]))).toThrow('complete samples');
    expect(() => timelineStore.appendSourceAudio('live-pcm-test', Buffer.from([0x01]), 48_000)).toThrow('complete samples');
  });

  it('restores the live state when a session id is reopened', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'live-resume-'));
    tempDirectories.push(directory);
    const timelineStore = new FileTimelineStore(directory);
    let now = 1_000;
    const firstSession = new LiveSession('live-resume-test', { timelineStore, now: () => now });
    now = 2_000;
    firstSession.startListening();
    firstSession.ingestAudio(Buffer.alloc(4));
    firstSession.selectProduct('headphones');
    now = 3_000;
    firstSession.ingestTranscript('今天是全网最低价');
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstSession.stopListening();

    now = 7_000;
    const resumedSession = new LiveSession('live-resume-test', { timelineStore, now: () => now });
    expect(resumedSession.createdAt).toBe(1_000);
    expect(resumedSession.state.product.id).toBe('headphones');
    expect(resumedSession.state.transcriptHistory.at(-1)?.text).toBe('今天是全网最低价');
    expect(resumedSession.state.latestCompliance).toMatchObject({ risk: 'warning', productId: 'headphones' });
    expect(resumedSession.state.stats).toMatchObject({ words: 8, warningCount: 1 });
    now = 8_000;
    resumedSession.startListening();
    resumedSession.ingestAudio(Buffer.alloc(2));

    const timeline = timelineStore.exportSession('live-resume-test');
    expect(timeline?.events.filter((event) => event.type === 'session.created')).toHaveLength(1);
    const captureEvents = timeline?.events.filter((event) => event.type === 'capture.started');
    expect(captureEvents?.map((event) => event.offsetMs)).toEqual([0, 6_000]);
    expect(captureEvents?.map((event) => event.payload.audioSampleOffset)).toEqual([0, 2]);
  });

  it('does not archive audio that arrives after stopping capture', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'live-stop-'));
    tempDirectories.push(directory);
    const timelineStore = new FileTimelineStore(directory);
    const session = new LiveSession('live-stop-test', { timelineStore, now: () => 1_000 });
    session.startListening();
    session.stopListening();
    session.ingestAudio(Buffer.alloc(2));
    session.ingestSourceAudio(Buffer.alloc(2), 48_000);

    expect(timelineStore.getAudioByteLength(session.id)).toBe(0);
    expect(timelineStore.getSourceAudioByteLength(session.id)).toBe(0);
  });
});
