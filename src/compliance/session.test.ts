import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LiveSession } from '../../server/session';
import { FileTimelineStore } from '../../server/timelineStore';
import { FileProductCatalog } from '../../server/productCatalog';
import { FileRuleCatalog } from '../../server/ruleCatalog';
import { FilePresenterPhraseLibrary } from '../../server/presenterPhraseLibrary';
import type WebSocket from 'ws';
import type { ComplianceResult } from '../shared/types';
import type { AnalysisInput } from './engine';
import type { DoubaoStreamingAsr, StreamingAsrOptions } from '../../server/providers/doubaoStreamingAsr';

function fakeSocket() {
  return { readyState: 1, send: () => undefined } as unknown as WebSocket;
}

function recordingSocket(messages: string[]) {
  return { readyState: 1, send: (message: string) => messages.push(message) } as unknown as WebSocket;
}

describe('LiveSession', () => {
  it('uses an unguessable id for a new display session', () => {
    expect(new LiveSession().id).toMatch(/^live-[a-f0-9]{24}$/u);
  });

  it('keeps the selected product as the context for the next compliance result', async () => {
    const session = new LiveSession('test-session');
    session.addClient(fakeSocket(), 'operator');
    session.selectProduct('headphones');
    session.ingestTranscript('这款耳机全网最低价，错过今天就没有了！');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.state.product.id).toBe('headphones');
    expect(session.state.latestCompliance?.productId).toBe('headphones');
    expect(session.state.latestCompliance?.risk).toBe('warning');
    expect(session.state.latestCompliance?.analysisMs).toEqual(expect.any(Number));
    expect(session.state.latestCompliance?.analysisMs).toBeGreaterThanOrEqual(0);
    expect(session.state.stats.warningCount).toBe(1);
    expect(session.state.alerts).toHaveLength(1);
  });

  it('learns a reviewable rule from a high-confidence live finding', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'session-rule-learning-'));
    try {
      const products = new FileProductCatalog(path.join(directory, 'products.json'));
      const rules = new FileRuleCatalog(products, path.join(directory, 'rules.json'));
      const analyzer = {
        analyze: async ({ transcript, productId }: { transcript: string; productId: string }): Promise<ComplianceResult> => ({
          id: 'live-finding', productId, risk: 'warning', title: '价格宣传风险', reason: '该价格范围无法直接核验。',
          alternative: '当前活动价格以商品页面为准。', policyRef: '价格宣传规范', confidence: 0.97,
          source: 'doubao', transcript, matchedTerms: ['全平台最低'], ruleKind: 'term', createdAt: Date.now(),
        }),
      };
      const session = new LiveSession('live-rule-learning', { productCatalog: products, ruleCatalog: rules, analyzer });

      session.ingestTranscript('今天就是全平台最低');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rules.list('room-default')).toEqual([
        expect.objectContaining({ pattern: '全平台最低', status: 'pending_review', origin: 'learned' }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('passes the selected risk profile and product-scoped rolling context into semantic checks', async () => {
    const inputs: AnalysisInput[] = [];
    const analyzer = {
      analyze: async (input: AnalysisInput): Promise<ComplianceResult> => {
        inputs.push(structuredClone(input));
        return {
          id: `result-${inputs.length}`, productId: input.productId, risk: 'safe', title: '可继续', reason: '未发现风险',
          alternative: '继续介绍', policyRef: '基础检查', confidence: 0.9, source: 'local-fallback', transcript: input.transcript, createdAt: Date.now(),
        };
      },
    };
    const session = new LiveSession('live-context-profile', { analyzer });
    session.setRiskProfile('optimized');

    session.ingestTranscript('人的发动机每天都在工作');
    session.ingestTranscript('所以要注意汽油的状态');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inputs[1]).toMatchObject({ riskProfile: 'optimized', context: { segmentCount: 2 } });
    expect(inputs[1]?.context?.text).toContain('人的发动机每天都在工作');
    expect(inputs[1]?.context?.text).toContain('所以要注意汽油的状态');
    expect(session.state.riskProfile).toBe('optimized');
  });

  it('automatically selects a product mentioned in a final transcript before compliance analysis', async () => {
    const messages: string[] = [];
    const session = new LiveSession('auto-product-session');
    session.addClient(recordingSocket(messages), 'operator');

    session.ingestTranscript('接下来给大家介绍云感降噪耳机');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.state.product.id).toBe('headphones');
    expect(session.state.latestCompliance?.productId).toBe('headphones');
    const statuses = messages.map((message) => JSON.parse(message) as { type: string; message?: string });
    expect(statuses.some((message) => message.type === 'system.status' && message.message === '已自动切换商品：云感降噪耳机')).toBe(true);
  });

  it('waits for a final transcript before automatically selecting a product', () => {
    const session = new LiveSession('partial-auto-product-session');
    session.ingestTranscript('接下来给大家介绍云感降噪耳机', false);
    expect(session.state.product.id).toBe('serum');
  });

  it('does not switch products for generic descriptive speech', () => {
    const session = new LiveSession('generic-auto-product-session');
    session.selectProduct('headphones');
    session.ingestTranscript('这款商品质地清爽，适合日常使用');
    expect(session.state.product.id).toBe('headphones');
  });

  it('marks a transcript speaker and persists a purpose-labelled coach suggestion', async () => {
    const session = new LiveSession('speaker-coach-session', {
      coach: {
        suggest: async () => ({ id: 'coach-1', purpose: '互动', text: '评论区告诉我你最关心哪一点。', reason: '引导互动', source: 'doubao', createdAt: Date.now(), latencyMs: 12 }),
      },
    });

    session.ingestTranscript('这款精华适合日常护肤');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const segmentId = session.state.transcriptHistory[0]?.id;
    expect(segmentId).toBeTruthy();
    expect(session.annotateSpeaker(segmentId!, 'other')?.speaker).toBe('other');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.state.transcriptHistory[0]?.speaker).toBe('other');
    expect(session.state.coachSuggestion).toMatchObject({ purpose: '互动', source: 'doubao' });
  });

  it('enters listening state without provider credentials for a demo session', () => {
    const session = new LiveSession('demo-session');
    session.startListening();
    expect(session.state.isListening).toBe(true);
    session.stopListening();
    expect(session.state.isListening).toBe(false);
  });

  it('keeps capture local and enqueues the archive only after stopping', async () => {
    const enqueue = vi.fn();
    const session = new LiveSession('archive-session', { archiveQueue: { enqueue } });

    session.startListening();
    session.ingestAudio(Buffer.from([0, 0]));
    expect(enqueue).not.toHaveBeenCalled();
    session.stopListening();
    await new Promise((resolve) => setImmediate(resolve));
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith('archive-session');
  });

  it('pauses and resumes one live session without archiving until it ends', async () => {
    const enqueue = vi.fn();
    const session = new LiveSession('lifecycle-session', { archiveQueue: { enqueue } });

    session.startListening();
    expect(session.state).toMatchObject({ isListening: true, captureState: 'live' });
    session.pauseListening();
    expect(session.state).toMatchObject({ isListening: false, captureState: 'paused' });
    expect(enqueue).not.toHaveBeenCalled();

    session.resumeListening();
    expect(session.state).toMatchObject({ isListening: true, captureState: 'live' });
    session.endLive();
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.state).toMatchObject({ isListening: false, captureState: 'ended' });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('archives host speech to the selected presenter library when the live ends', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'session-presenter-archive-'));
    try {
      const timelineStore = new FileTimelineStore(path.join(directory, 'timeline'));
      const phraseLibrary = new FilePresenterPhraseLibrary(path.join(directory, 'phrases.json'));
      const presenter = phraseLibrary.createPresenter({ roomId: 'room-default', accountName: '护肤账号', name: '主播小唐' });
      const session = new LiveSession('live-presenter-archive', { timelineStore, phraseLibrary, presenter });

      session.startListening();
      session.ingestTranscript('这是主播本场的塑品话术');
      session.endLive();
      await new Promise((resolve) => setImmediate(resolve));

      expect(phraseLibrary.listPhrases(presenter.id)).toEqual([
        expect.objectContaining({ text: '这是主播本场的塑品话术', sourceSessionId: 'live-presenter-archive' }),
      ]);
      expect(session.state).toMatchObject({ presenterId: presenter.id, presenterName: '主播小唐' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('archives a final ASR segment delivered while the stream is draining', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'session-presenter-drain-'));
    try {
      const timelineStore = new FileTimelineStore(path.join(directory, 'timeline'));
      const phraseLibrary = new FilePresenterPhraseLibrary(path.join(directory, 'phrases.json'));
      const presenter = phraseLibrary.createPresenter({ roomId: 'room-default', accountName: '护肤账号', name: '主播小唐' });
      const streamingAsrFactory = (options: StreamingAsrOptions) => ({
        connect: () => undefined,
        finish: () => {
          options.onResult({ text: '收尾补充话术', isFinal: true });
          options.onClosed?.();
        },
        close: () => undefined,
        sendAudio: () => undefined,
      }) as unknown as DoubaoStreamingAsr;
      const session = new LiveSession('live-presenter-drain', { timelineStore, phraseLibrary, presenter, streamingAsrFactory });

      session.startListening();
      session.endLive();
      await Promise.resolve();

      expect(phraseLibrary.listPhrases(presenter.id)).toEqual([
        expect.objectContaining({ text: '收尾补充话术', sourceSessionId: 'live-presenter-drain' }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not let a paused stream error pause the stream created after resume', () => {
    const streamOptions: StreamingAsrOptions[] = [];
    const streamingAsrFactory = (options: StreamingAsrOptions) => {
      streamOptions.push(options);
      return { connect: () => undefined, finish: () => undefined, close: () => undefined, sendAudio: () => undefined } as unknown as DoubaoStreamingAsr;
    };
    const session = new LiveSession('stale-asr-error-session', { streamingAsrFactory });

    session.startListening();
    session.pauseListening();
    session.resumeListening();
    streamOptions[0]?.onError(new Error('旧连接延迟报错'));

    expect(session.state).toMatchObject({ isListening: true, captureState: 'live' });
  });

  it('turns a provider concurrency error into an actionable operator message', () => {
    const streamOptions: StreamingAsrOptions[] = [];
    const streamingAsrFactory = (options: StreamingAsrOptions) => {
      streamOptions.push(options);
      return { connect: () => undefined, finish: () => undefined, close: () => undefined, sendAudio: () => undefined } as unknown as DoubaoStreamingAsr;
    };
    const messages: string[] = [];
    const session = new LiveSession('asr-concurrency-session', { streamingAsrFactory });
    session.addClient(recordingSocket(messages), 'operator');

    session.startListening();
    streamOptions[0]?.onError(new Error('豆包大模型流式语音识别错误 45000292: {"error":"quota exceeded for types: concurrency"}（Logid test-logid）'));

    const status = messages.map((message) => JSON.parse(message) as { type: string; message?: string }).filter((message) => message.type === 'system.status').at(-1);
    expect(session.state).toMatchObject({ isListening: false, captureState: 'paused' });
    expect(status?.message).toContain('并发额度已满');
    expect(status?.message).not.toContain('45000292');
    expect(status?.message).not.toContain('Logid');
  });

  it('recovers from the provider next-packet timeout without pausing capture', () => {
    vi.useFakeTimers();
    try {
      const streamOptions: StreamingAsrOptions[] = [];
      const streams: Array<{ connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
      const streamingAsrFactory = (options: StreamingAsrOptions) => {
        streamOptions.push(options);
        const stream = { connect: vi.fn(), finish: vi.fn(), close: vi.fn(), sendAudio: vi.fn() };
        streams.push(stream);
        return stream as unknown as DoubaoStreamingAsr;
      };
      const messages: string[] = [];
      const session = new LiveSession('asr-next-packet-timeout-session', { streamingAsrFactory });
      session.addClient(recordingSocket(messages), 'operator');

      session.startListening();
      streamOptions[0]?.onError(new Error('豆包大模型流式语音识别错误 45000081: {"error":"[Timeout waiting next packet] waiting next packet timeout: 8.000000 seconds, session has ended"}（Logid test-logid）'));
      streamOptions[0]?.onResult({ text: '旧连接不应进入转录', isFinal: true });
      vi.advanceTimersByTime(1_000);
      streamOptions[0]?.onError(new Error('旧连接迟到的重复错误'));

      const statuses = messages.map((message) => JSON.parse(message) as { type: string; message?: string }).filter((message) => message.type === 'system.status');
      expect(session.state).toMatchObject({ isListening: true, captureState: 'live' });
      expect(streams).toHaveLength(2);
      expect(streams[0]?.close).toHaveBeenCalledOnce();
      expect(streams[1]?.connect).toHaveBeenCalledOnce();
      expect(session.state.transcriptHistory).toHaveLength(0);
      expect(statuses.some((status) => status.message?.includes('正在恢复豆包大模型流式语音识别'))).toBe(true);
      expect(statuses.every((status) => !status.message?.includes('45000081') && !status.message?.includes('Logid'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses only after bounded next-packet timeout recovery attempts are exhausted', () => {
    vi.useFakeTimers();
    try {
      const streamOptions: StreamingAsrOptions[] = [];
      const streamingAsrFactory = (options: StreamingAsrOptions) => {
        streamOptions.push(options);
        return { connect: vi.fn(), finish: vi.fn(), close: vi.fn(), sendAudio: vi.fn() } as unknown as DoubaoStreamingAsr;
      };
      const messages: string[] = [];
      const session = new LiveSession('asr-recovery-exhausted-session', { streamingAsrFactory });
      session.addClient(recordingSocket(messages), 'operator');
      const timeout = () => new Error('豆包大模型流式语音识别错误 45000081: {"error":"[Timeout waiting next packet]"}（Logid retry-logid）');

      session.startListening();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        streamOptions[attempt]?.onError(timeout());
        vi.advanceTimersByTime(2_000);
        expect(session.state).toMatchObject({ isListening: true, captureState: 'live' });
      }
      streamOptions[3]?.onError(timeout());

      const status = messages.map((message) => JSON.parse(message) as { type: string; message?: string }).filter((message) => message.type === 'system.status').at(-1);
      expect(streamOptions).toHaveLength(4);
      expect(session.state).toMatchObject({ isListening: false, captureState: 'paused' });
      expect(status?.message).toContain('连续恢复失败');
      expect(status?.message).not.toContain('45000081');
      expect(status?.message).not.toContain('Logid');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps raw next-packet timeout details in the timeline log', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'session-asr-recovery-'));
    try {
      const timelineStore = new FileTimelineStore(directory);
      const streamOptions: StreamingAsrOptions[] = [];
      const streamingAsrFactory = (options: StreamingAsrOptions) => {
        streamOptions.push(options);
        return { connect: vi.fn(), finish: vi.fn(), close: vi.fn(), sendAudio: vi.fn() } as unknown as DoubaoStreamingAsr;
      };
      const session = new LiveSession('asr-recovery-log-session', { streamingAsrFactory, timelineStore });

      session.startListening();
      streamOptions[0]?.onError(new Error('豆包大模型流式语音识别错误 45000081: {"error":"[Timeout waiting next packet]"}（Logid timeline-logid）'));

      const recovery = timelineStore.exportSession(session.id)?.events.find((event) => event.type === 'asr.recovery.started');
      expect(recovery?.payload).toMatchObject({ providerCode: '45000081', logId: 'timeline-logid', attempt: 1, delayMs: 250 });
      expect(recovery?.payload.message).toContain('Timeout waiting next packet');
      session.pauseListening();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts semantic checks concurrently and keeps the newest result current', async () => {
    const pending = new Map<string, (result: ComplianceResult) => void>();
    const analyzer = {
      analyze: vi.fn((input: { transcript: string }) => new Promise<ComplianceResult>((resolve) => pending.set(input.transcript, resolve))),
    };
    const session = new LiveSession('concurrent-analysis-session', { analyzer });
    const result = (transcript: string, risk: ComplianceResult['risk']): ComplianceResult => ({
      id: `result-${transcript}`, productId: 'serum', risk, title: risk, reason: risk, alternative: risk,
      policyRef: 'test', confidence: 0.9, source: 'doubao', transcript, createdAt: Date.now(),
    });

    session.ingestTranscript('第一句');
    session.ingestTranscript('第二句');
    await Promise.resolve();
    expect(analyzer.analyze).toHaveBeenCalledTimes(2);

    pending.get('第二句')?.(result('第二句', 'warning'));
    await Promise.resolve();
    pending.get('第一句')?.(result('第一句', 'safe'));
    await Promise.resolve();

    expect(session.state.latestCompliance?.transcript).toBe('第二句');
  });

  it('can correct a transcript that has moved out of the live history window', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'session-review-'));
    try {
      const timelineStore = new FileTimelineStore(directory);
      const session = new LiveSession('session-review-old-segment', { timelineStore });
      for (let index = 0; index < 21; index += 1) session.ingestTranscript(`第${index}句`);
      const corrected = session.correctTranscript('segment-0', '第一句', 'operator-a', { learn: false });

      expect(corrected?.text).toBe('第一句');
      expect(timelineStore.exportSession(session.id)?.events.at(-1)?.payload).toMatchObject({ segmentId: 'segment-0', correctedText: '第一句' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
