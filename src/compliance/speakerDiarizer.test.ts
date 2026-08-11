import { describe, expect, it } from 'vitest';
import { SpeakerDiarizer, extractSpeakerFeature } from '../../server/speakerDiarizer';
import { LiveSession, type CapturePort } from '../../server/v2/liveSession';
import { SqliteFactStore } from '../../server/v2/store';
import { BoundedScheduler } from '../../server/v2/scheduler';
import { DEFAULT_PRODUCT, PRODUCTS } from '../shared/products';

function tone(frequency: number, durationMs: number): Buffer {
  const samples = Math.floor((durationMs / 1_000) * 16_000);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((index / 16_000) * Math.PI * 2 * frequency) * 0x2fff), index * 2);
  }
  return pcm;
}

describe('SpeakerDiarizer', () => {
  it('extracts stable, cheap acoustic features from PCM', () => {
    const feature = extractSpeakerFeature(tone(220, 40));
    expect(feature?.rms).toBeGreaterThan(0.1);
    expect(feature?.zeroCrossingRate).toBeGreaterThan(0);
    expect(feature?.peak).toBeGreaterThan(0.2);
  });

  it('groups alternating voices into separate candidate speakers', () => {
    const diarizer = new SpeakerDiarizer();
    diarizer.pushAudio(tone(220, 400), 0);
    const first = diarizer.assign(0, 380, 400);
    diarizer.pushAudio(tone(1_200, 400), 400);
    const second = diarizer.assign(400, 780, 800);

    expect(first?.speakerId).toBe('speaker-1');
    expect(second?.speakerId).toBe('speaker-2');
    expect(second?.confidence).toBeGreaterThan(0.5);
  });

  it('reuses a candidate when the same voice returns', () => {
    const diarizer = new SpeakerDiarizer();
    diarizer.pushAudio(tone(220, 300), 0);
    const first = diarizer.assign(0, 280, 300);
    diarizer.pushAudio(tone(1_200, 300), 300);
    diarizer.assign(300, 580, 600);
    diarizer.pushAudio(tone(220, 300), 600);
    const third = diarizer.assign(600, 880, 900);

    expect(third?.speakerId).toBe(first?.speakerId);
  });

  it('attaches candidate identities to live transcript segments and carries a binding forward', async () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const capture: CapturePort = { start: () => undefined, pause: () => undefined, resume: () => undefined, end: async () => undefined, pushAudio: () => undefined };
    const session = new LiveSession({
      store, capture, products: PRODUCTS,
      scheduler: new BoundedScheduler({ modelGlobal: 2, modelPerSession: 2, background: 1 }),
      session: { sessionId: 'speaker-session', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '主播', product: DEFAULT_PRODUCT, lineup: PRODUCTS },
    });
    await session.dispatch({ type: 'start' });
    await session.dispatch({ type: 'audio', track: 'asr', pcm: tone(220, 400), sampleRate: 16_000, channels: 1 });
    session.receiveAsr({ text: '主播的一句', isFinal: true, startTimeMs: 0, endTimeMs: 380 });
    await session.dispatch({ type: 'audio', track: 'asr', pcm: tone(1_200, 400), sampleRate: 16_000, channels: 1 });
    session.receiveAsr({ text: '嘉宾的一句', isFinal: true, startTimeMs: 400, endTimeMs: 780 });
    await Promise.resolve();

    const [hostCandidate, guestCandidate] = session.snapshot().transcriptHistory;
    expect(hostCandidate).toMatchObject({ speakerId: 'speaker-1', speakerSource: 'automatic', speaker: 'host' });
    expect(guestCandidate).toMatchObject({ speakerId: 'speaker-2', speakerSource: 'automatic', speaker: 'host' });

    await session.dispatch({ type: 'assign_speaker', segmentId: guestCandidate!.id, speaker: 'other' });
    expect(session.snapshot().transcriptHistory[1]).toMatchObject({ speakerId: 'speaker-2', speakerSource: 'manual', speaker: 'other' });
    await session.dispatch({ type: 'audio', track: 'asr', pcm: tone(1_200, 400), sampleRate: 16_000, channels: 1 });
    session.receiveAsr({ text: '嘉宾继续说', isFinal: true, startTimeMs: 800, endTimeMs: 1_180 });
    await Promise.resolve();
    expect(session.snapshot().transcriptHistory[2]).toMatchObject({ speakerId: 'speaker-2', speakerSource: 'manual', speaker: 'other' });

    await session.dispatch({ type: 'audio', track: 'asr', pcm: tone(1_200, 400), sampleRate: 16_000, channels: 1 });
    session.receiveAsr({ text: '耳机商品', isFinal: true, startTimeMs: 1_200, endTimeMs: 1_580 });
    await Promise.resolve();
    expect(session.snapshot().transcriptHistory.at(-1)).toMatchObject({ speakerId: 'speaker-2', speaker: 'other' });
    expect(session.snapshot().product.id).toBe(DEFAULT_PRODUCT.id);
    store.close();
  });
});
