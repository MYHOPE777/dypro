import { describe, expect, it } from 'vitest';
import { wavHeader } from './audio';

describe('WAV playback wrapper', () => {
  it('describes the original PCM without changing sample bytes', () => {
    const header = wavHeader(9_600, 48_000, 1);
    expect(header.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(header.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(header.readUInt32LE(24)).toBe(48_000);
    expect(header.readUInt32LE(40)).toBe(9_600);
  });
});
