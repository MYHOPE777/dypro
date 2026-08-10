import { describe, expect, it } from 'vitest';
import { SpeakerDiarizer, extractSpeakerFeature } from '../../server/speakerDiarizer';
import { LiveSession } from '../../server/session';
import { FileTimelineStore } from '../../server/timelineStore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

  it('attaches candidate identities to live transcript segments and carries a binding forward', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'speaker-session-'));
    try {
      let now = 1_000;
      const session = new LiveSession('speaker-session', { timelineStore: new FileTimelineStore(directory), now: () => now });
      session.startListening();
      session.ingestAudio(tone(220, 400));
      session.ingestTranscript('主播的一句', true, { startTimeMs: 0, endTimeMs: 380 });
      now += 400;
      session.ingestAudio(tone(1_200, 400));
      session.ingestTranscript('嘉宾的一句', true, { startTimeMs: 400, endTimeMs: 780 });

      const [hostCandidate, guestCandidate] = session.state.transcriptHistory;
      expect(hostCandidate).toMatchObject({ speakerId: 'speaker-1', speakerSource: 'automatic', speaker: 'host' });
      expect(guestCandidate).toMatchObject({ speakerId: 'speaker-2', speakerSource: 'automatic', speaker: 'host' });

      session.annotateSpeaker(guestCandidate!.id, 'other');
      expect(session.state.transcriptHistory[1]).toMatchObject({ speakerId: 'speaker-2', speakerSource: 'manual', speaker: 'other' });
      now += 400;
      session.ingestAudio(tone(1_200, 400));
      session.ingestTranscript('嘉宾继续说', true, { startTimeMs: 800, endTimeMs: 1_180 });
      expect(session.state.transcriptHistory[2]).toMatchObject({ speakerId: 'speaker-2', speakerSource: 'manual', speaker: 'other' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
