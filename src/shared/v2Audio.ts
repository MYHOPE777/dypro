export type AudioTrack = 'source' | 'asr';
export type DecodedAudioFrame = { track: AudioTrack; sampleRate: number; channels: number; pcm: Uint8Array };

const HEADER_BYTES = 12;
const MAGIC = 0x46413256;

export function encodeAudioFrame(input: DecodedAudioFrame): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(input.sampleRate) || input.sampleRate < 8_000 || input.sampleRate > 192_000) throw new Error('音频采样率无效');
  if (!Number.isInteger(input.channels) || input.channels < 1 || input.channels > 8) throw new Error('音频声道数无效');
  const frame = new Uint8Array(HEADER_BYTES + input.pcm.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, input.track === 'source' ? 1 : 2);
  view.setUint8(5, input.channels);
  view.setUint32(8, input.sampleRate, true);
  frame.set(input.pcm, HEADER_BYTES);
  return frame;
}

export function decodeAudioFrame(frame: Uint8Array): DecodedAudioFrame | null {
  if (frame.byteLength <= HEADER_BYTES) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return null;
  const trackValue = view.getUint8(4);
  const channels = view.getUint8(5);
  const sampleRate = view.getUint32(8, true);
  if ((trackValue !== 1 && trackValue !== 2) || channels < 1 || channels > 8 || sampleRate < 8_000 || sampleRate > 192_000) return null;
  return { track: trackValue === 1 ? 'source' : 'asr', sampleRate, channels, pcm: frame.slice(HEADER_BYTES) };
}
