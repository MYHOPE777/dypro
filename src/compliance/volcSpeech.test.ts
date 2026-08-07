import { gzipSync, gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { buildAudioFrame, buildFullClientRequest, parseResponseFrame, VolcSpeechStream } from '../../server/providers/volcSpeech';

describe('Volc realtime speech frames', () => {
  it('builds a gzip JSON full-client request with 16k mono PCM settings', () => {
    const frame = buildFullClientRequest();
    expect(frame.subarray(0, 4)).toEqual(Buffer.from([0x11, 0x10, 0x11, 0x00]));
    const payloadSize = frame.readUInt32BE(4);
    const request = JSON.parse(gunzipSync(frame.subarray(8, 8 + payloadSize)).toString('utf8')) as { audio: { rate: number; channel: number; format: string } };
    expect(request.audio).toMatchObject({ rate: 16000, channel: 1, format: 'pcm' });
  });

  it('marks the final audio chunk with the documented negative sequence flag', () => {
    const frame = buildAudioFrame(Buffer.from([1, 2, 3]), true, -4);
    expect(frame[0]).toBe(0x11);
    expect(frame[1]).toBe(0x22);
    expect(frame.readInt32BE(4)).toBe(-4);
  });

  it('reads a final server response that includes a sequence number', () => {
    const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text: '最后一句', definite: true } })));
    const header = Buffer.from([0x11, 0x93, 0x11, 0x00]);
    const sequence = Buffer.alloc(4);
    sequence.writeInt32BE(7, 0);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length, 0);
    const result = parseResponseFrame(Buffer.concat([header, sequence, size, payload]));
    expect(result).toEqual({ text: '最后一句', isFinal: true });
  });

  it('preserves Volc utterance timing for recording alignment', () => {
    const payload = gzipSync(Buffer.from(JSON.stringify({
      result: { text: '带时间的一句', utterances: [{ text: '带时间的一句', definite: true, start_time: 240, end_time: 1680 }] },
    })));
    const header = Buffer.from([0x11, 0x91, 0x11, 0x00]);
    const sequence = Buffer.alloc(4);
    sequence.writeInt32BE(8, 0);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length, 0);

    expect(parseResponseFrame(Buffer.concat([header, sequence, size, payload]))).toEqual({
      text: '带时间的一句',
      isFinal: true,
      startTimeMs: 240,
      endTimeMs: 1680,
    });
  });

  it('keeps early audio until the provider websocket is ready', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const sent: Buffer[] = [];
    const socket = {
      readyState: WebSocket.CONNECTING as number,
      on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
      send(data: Buffer) { sent.push(data); },
      close() { this.readyState = WebSocket.CLOSED; },
    };
    const onReady = vi.fn();
    const stream = new VolcSpeechStream(
      { appKey: 'app', accessKey: 'access', resourceId: 'resource', endpoint: 'wss://speech.example' },
      { onResult: vi.fn(), onError: vi.fn(), onReady },
      () => socket as never,
    );

    stream.connect();
    stream.sendAudio(Buffer.from([1, 0, 2, 0]));
    expect(sent).toEqual([]);
    socket.readyState = WebSocket.OPEN;
    listeners.get('open')?.();

    expect(sent).toHaveLength(2);
    expect(sent[0].subarray(0, 4)).toEqual(Buffer.from([0x11, 0x10, 0x11, 0x00]));
    expect(sent[1]).toEqual(buildAudioFrame(Buffer.from([1, 0, 2, 0])));
    expect(onReady).toHaveBeenCalledOnce();
  });
});
