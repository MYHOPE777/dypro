import { gzipSync, gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { buildAudioFrame, buildFullClientRequest, buildStreamingAsrContext, getStreamingAsrConfig, parseResponseFrame, DoubaoStreamingAsr } from '../../server/providers/doubaoStreamingAsr';

describe('Doubao streaming ASR frames', () => {
  it('builds a gzip JSON full-client request with 16k mono PCM settings', () => {
    const frame = buildFullClientRequest();
    expect(frame.subarray(0, 4)).toEqual(Buffer.from([0x11, 0x10, 0x11, 0x00]));
    const payloadSize = frame.readUInt32BE(4);
    const request = JSON.parse(gunzipSync(frame.subarray(8, 8 + payloadSize)).toString('utf8')) as { audio: { rate: number; channel: number; format: string }; request: { model_name: string; enable_nonstream: boolean; enable_ddc: boolean; result_type: string; end_window_size: number } };
    expect(request.audio).toMatchObject({ rate: 16000, channel: 1, format: 'pcm' });
    expect(request.request).toMatchObject({ model_name: 'bigmodel', enable_nonstream: true, enable_ddc: false, result_type: 'single', end_window_size: 800 });
  });

  it('adds official hotword and correction table fields to corpus', () => {
    const frame = buildFullClientRequest({ hotwordTableId: 'boost-1', correctTableId: 'correct-1', endWindowMs: 600 });
    const payloadSize = frame.readUInt32BE(4);
    const request = JSON.parse(gunzipSync(frame.subarray(8, 8 + payloadSize)).toString('utf8')) as { request: { corpus: Record<string, unknown>; end_window_size: number } };
    expect(request.request.corpus).toEqual({ boosting_table_id: 'boost-1', correct_table_id: 'correct-1' });
    expect(request.request.end_window_size).toBe(600);
  });

  it('serializes official corpus.context hotwords and dialog context', () => {
    const context = buildStreamingAsrContext(['商品 A', '商品 A', 'SKU-01'], ['当前直播商品：商品 A']);
    const frame = buildFullClientRequest({ context, endWindowMs: 800 });
    const payloadSize = frame.readUInt32BE(4);
    const request = JSON.parse(gunzipSync(frame.subarray(8, 8 + payloadSize)).toString('utf8')) as { request: { corpus: { context: string } } };
    expect(JSON.parse(request.request.corpus.context)).toEqual({
      hotwords: [{ word: '商品 A' }, { word: 'SKU-01' }],
      context_type: 'dialog_ctx',
      context_data: [{ text: '当前直播商品：商品 A' }],
    });
  });

  it('marks the final audio chunk with the documented final marker', () => {
    const frame = buildAudioFrame(Buffer.from([1, 2, 3]), true);
    expect(frame[0]).toBe(0x11);
    expect(frame[1]).toBe(0x22);
    expect(frame.readUInt32BE(4)).toBe(gzipSync(Buffer.from([1, 2, 3])).length);
  });

  it('parses the official error frame with error code before payload size', () => {
    const message = Buffer.from('{"message":"invalid request"}');
    const code = Buffer.alloc(4);
    code.writeUInt32BE(45000001, 0);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(message.length, 0);
    const frame = Buffer.concat([Buffer.from([0x11, 0xf0, 0x00, 0x00]), code, size, message]);
    expect(() => parseResponseFrame(frame)).toThrow('45000001');
    expect(() => parseResponseFrame(frame)).toThrow('invalid request');
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

  it('preserves Doubao utterance timing for recording alignment', () => {
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

  it('uses the latest utterance instead of cumulative result text', () => {
    const payload = gzipSync(Buffer.from(JSON.stringify({
      result: { text: '第一句第二句', utterances: [{ text: '第二句', definite: true, start_time: 1000, end_time: 1800 }] },
    })));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length, 0);
    expect(parseResponseFrame(Buffer.concat([Buffer.from([0x11, 0x90, 0x11, 0x00]), size, payload]))).toMatchObject({ text: '第二句', isFinal: true });
  });

  it('keeps early audio until the provider websocket is ready', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const sent: Buffer[] = [];
    const headers: Record<string, string> = {};
    const socket = {
      readyState: WebSocket.CONNECTING as number,
      on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
      send(data: Buffer) { sent.push(data); },
      close() { this.readyState = WebSocket.CLOSED; },
    };
    const onReady = vi.fn();
    const onError = vi.fn();
    const onClosed = vi.fn();
    const stream = new DoubaoStreamingAsr(
      { apiKey: 'api-key', resourceId: 'resource', endpoint: 'wss://speech.example', endWindowMs: 800 },
      { onResult: vi.fn(), onError, onReady, onClosed },
      (_endpoint: string, requestHeaders: Record<string, string>) => { Object.assign(headers, requestHeaders); return socket as never; },
    );

    stream.connect();
    stream.sendAudio(Buffer.from([1, 0, 2, 0]));
    stream.finish();
    expect(sent).toEqual([]);
    socket.readyState = WebSocket.OPEN;
    listeners.get('open')?.();

    expect(sent).toHaveLength(3);
    expect(sent[0].subarray(0, 4)).toEqual(Buffer.from([0x11, 0x10, 0x11, 0x00]));
    expect(headers).toMatchObject({ 'X-Api-Key': 'api-key', 'X-Api-Resource-Id': 'resource' });
    expect(Object.keys(headers).filter((key) => key.toLowerCase().startsWith('x-api-'))).toEqual(expect.arrayContaining(['X-Api-Key', 'X-Api-Resource-Id', 'X-Api-Connect-Id', 'X-Api-Request-Id']));
    expect(sent[1]).toEqual(buildAudioFrame(Buffer.from([1, 0, 2, 0])));
    expect(sent[2][1]).toBe(0x22);
    expect(onReady).toHaveBeenCalledOnce();
    listeners.get('close')?.();
    expect(onError).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it('keeps an idle stream alive with audio-only silence frames', () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const sent: Buffer[] = [];
      const socket = {
        readyState: WebSocket.CONNECTING as number,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        send(data: Buffer) { sent.push(data); },
        close() { this.readyState = WebSocket.CLOSED; },
      };
      const onError = vi.fn();
      const stream = new DoubaoStreamingAsr(
        { apiKey: 'api-key', resourceId: 'resource', endpoint: 'wss://speech.example', endWindowMs: 800 },
        { onResult: vi.fn(), onError },
        () => socket as never,
      );

      stream.connect();
      socket.readyState = WebSocket.OPEN;
      listeners.get('open')?.();
      expect(sent).toHaveLength(1);

      vi.advanceTimersByTime(9_000);

      const keepAliveFrames = sent.slice(1);
      expect(keepAliveFrames.length).toBeGreaterThanOrEqual(3);
      expect(keepAliveFrames.every((frame) => frame[1] === 0x20)).toBe(true);
      expect(keepAliveFrames.every((frame) => gunzipSync(frame.subarray(8)).equals(Buffer.alloc(3200)))).toBe(true);
      expect(onError).not.toHaveBeenCalled();

      stream.close();
      const sentBeforeCleanup = sent.length;
      vi.advanceTimersByTime(3_000);
      expect(sent).toHaveLength(sentBeforeCleanup);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads only the official X-Api-Key configuration', () => {
    expect(getStreamingAsrConfig({ X_API_KEY: ' key ', X_API_RESOURCE_ID: 'resource', SPEECH_ENDPOINT: 'wss://example', END_WINDOW_SIZE: '600' })).toMatchObject({
      apiKey: 'key', resourceId: 'resource', endpoint: 'wss://example', endWindowMs: 600,
    });
    expect(getStreamingAsrConfig({ X_API_KEY: '' })).toBeNull();
  });
});
