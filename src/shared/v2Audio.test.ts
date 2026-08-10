import { describe, expect, it } from 'vitest';
import { decodeAudioFrame, encodeAudioFrame } from './v2Audio';

describe('v2 binary audio frames', () => {
  it('preserves track, source format and PCM bytes', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const frame = encodeAudioFrame({ track: 'source', sampleRate: 48_000, channels: 2, pcm });

    expect(decodeAudioFrame(frame)).toEqual({ track: 'source', sampleRate: 48_000, channels: 2, pcm });
  });
});
