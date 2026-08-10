import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamingAsrResult } from '../providers/doubaoStreamingAsr';
import { CaptureModule, type CaptureAsrFactory, type CaptureAsrStream } from './capture';

type Controls = { onResult: (result: StreamingAsrResult) => void; onError: (error: Error) => void; onReady: () => void; onClosed: () => void };

describe('CaptureModule', () => {
  afterEach(() => vi.useRealTimers());

  it('reconnects after 45000081 without pausing the live session', async () => {
    vi.useFakeTimers();
    const controls: Controls[] = [];
    const streams: CaptureAsrStream[] = [];
    const factory: CaptureAsrFactory = (options) => {
      controls.push(options);
      const stream: CaptureAsrStream = { connect: vi.fn(), sendAudio: vi.fn(), finish: vi.fn(), close: vi.fn() };
      streams.push(stream);
      return stream;
    };
    const errors: string[] = [];
    const capture = new CaptureModule({ onPartial: () => undefined, onFinal: () => undefined, onError: (error) => errors.push(error.message), createAsr: factory });
    capture.start();
    controls[0].onError(new Error('豆包大模型流式语音识别错误 45000081: Timeout waiting next packet'));
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(streams).toHaveLength(2);
    expect(streams[1].connect).toHaveBeenCalledOnce();
    controls[1].onReady();
    capture.pushAudio(new Uint8Array([1, 2]), 16_000);
    expect(streams[1].sendAudio).toHaveBeenCalledOnce();
  });

  it('surfaces quota errors immediately instead of retrying blindly', async () => {
    vi.useFakeTimers();
    const controls: Controls[] = [];
    const factory: CaptureAsrFactory = (options) => { controls.push(options); return { connect() {}, sendAudio() {}, finish() {}, close() {} }; };
    const errors: string[] = [];
    const capture = new CaptureModule({ onPartial: () => undefined, onFinal: () => undefined, onError: (error) => errors.push(error.message), createAsr: factory });
    capture.start();
    controls[0].onError(new Error('豆包大模型流式语音识别错误 45000292: quota exceeded for types: concurrency'));
    await vi.runAllTimersAsync();
    expect(controls).toHaveLength(1);
    expect(errors[0]).toContain('quota exceeded');
  });

  it('keeps ASR timestamps monotonic across reconnects and pauses', async () => {
    vi.useFakeTimers();
    const controls: Controls[] = [];
    const results: StreamingAsrResult[] = [];
    const factory: CaptureAsrFactory = (options) => {
      controls.push(options);
      return { connect: () => options.onReady(), sendAudio: () => undefined, finish: () => options.onClosed(), close: () => undefined };
    };
    const capture = new CaptureModule({ onPartial: () => undefined, onFinal: (result) => results.push(result), onError: () => undefined, createAsr: factory });

    capture.start();
    capture.pushAudio(new Uint8Array(3_200), 16_000, 1);
    controls[0].onResult({ text: '第一段', isFinal: true, startTimeMs: 0, endTimeMs: 100 });
    controls[0].onError(new Error('连接已断开'));
    await vi.advanceTimersByTimeAsync(250);
    capture.pushAudio(new Uint8Array(1_600), 16_000, 1);
    controls[1].onResult({ text: '第二段', isFinal: true, startTimeMs: 0, endTimeMs: 50 });
    capture.pause();
    capture.resume();
    capture.pushAudio(new Uint8Array(1_600), 16_000, 1);
    controls[2].onResult({ text: '第三段', isFinal: true, startTimeMs: 0, endTimeMs: 50 });

    expect(results.map((result) => [result.startTimeMs, result.endTimeMs])).toEqual([[0, 100], [100, 150], [150, 200]]);
  });

  it('refreshes learned ASR context whenever a stream connects', async () => {
    vi.useFakeTimers();
    const contexts: Array<string | undefined> = [];
    let currentContext = '第一版纠错词';
    const factory: CaptureAsrFactory = (options) => {
      contexts.push(options.context);
      return { connect: () => options.onReady(), sendAudio: () => undefined, finish: () => options.onClosed(), close: () => undefined };
    };
    const capture = new CaptureModule({ onPartial: () => undefined, onFinal: () => undefined, onError: () => undefined, createAsr: factory, asrContext: () => currentContext });

    capture.start();
    currentContext = '第二版纠错词';
    capture.pause();
    capture.resume();

    expect(contexts).toEqual(['第一版纠错词', '第二版纠错词']);
  });

  it('pauses after recoverable disconnect attempts are exhausted', async () => {
    vi.useFakeTimers();
    const controls: Controls[] = [];
    const factory: CaptureAsrFactory = (options) => { controls.push(options); return { connect() {}, sendAudio() {}, finish() {}, close() {} }; };
    const errors: string[] = [];
    const capture = new CaptureModule({ onPartial: () => undefined, onFinal: () => undefined, onError: (error) => errors.push(error.message), createAsr: factory });
    capture.start();
    for (const delay of [250, 750, 1_500]) {
      controls.at(-1)!.onError(new Error('连接已断开'));
      await vi.advanceTimersByTimeAsync(delay);
    }
    controls.at(-1)!.onError(new Error('连接已断开'));
    expect(errors).toEqual(['连接已断开']);
    expect(controls).toHaveLength(4);
  });

  it('processes thirty minutes of continuous PCM frames and drains cleanly', async () => {
    const frame = new Uint8Array(640);
    const frameCount = 30 * 60 * 50;
    let asrFrames = 0;
    let asrBytes = 0;
    let persistedFrames = 0;
    let controls: Controls | null = null;
    const factory: CaptureAsrFactory = (options) => {
      controls = options;
      return {
        connect: () => options.onReady(),
        sendAudio: (audio) => { asrFrames += 1; asrBytes += audio.byteLength; },
        finish: () => options.onClosed(),
        close: () => undefined,
      };
    };
    const errors: string[] = [];
    const capture = new CaptureModule({
      onPartial: () => undefined,
      onFinal: () => undefined,
      onError: (error) => errors.push(error.message),
      onAudio: () => { persistedFrames += 1; },
      createAsr: factory,
    });

    capture.start();
    expect(controls).not.toBeNull();
    for (let index = 0; index < frameCount; index += 1) capture.pushAudio(frame, 16_000, 1);
    await capture.end();

    expect(errors).toEqual([]);
    expect(asrFrames).toBe(frameCount);
    expect(persistedFrames).toBe(frameCount);
    expect(asrBytes).toBe(57_600_000);
  });
});
