import { describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT, PRODUCTS } from '../../src/shared/products';
import type { ComplianceResult } from '../../src/shared/types';
import { SqliteFactStore } from './store';
import { BoundedScheduler } from './scheduler';
import { LiveSession, type CapturePort, type ReviewAnalyzer } from './liveSession';

class FakeCapture implements CapturePort {
  endPromise: Promise<void> = Promise.resolve();
  private resolveEnd: (() => void) | null = null;
  startCount = 0;
  pauseCount = 0;
  resumeCount = 0;
  endCalls = 0;
  start(): void { this.startCount += 1; }
  pause(): void { this.pauseCount += 1; }
  resume(): void { this.resumeCount += 1; }
  end(): Promise<void> { this.endCalls += 1; return this.endPromise; }
  holdEnd(): void { this.endPromise = new Promise<void>((resolve) => { this.resolveEnd = resolve; }); }
  finishEnd(): void { this.resolveEnd?.(); this.resolveEnd = null; }
  pushAudio(): void { /* no-op fake */ }
}

const result = (productId: string, risk: ComplianceResult['risk']): ComplianceResult => ({
  id: `result-${productId}-${risk}`, segmentId: 'segment-1', productId, risk, title: risk, reason: risk, alternative: 'safe', policyRef: 'test', confidence: 1, source: 'doubao', transcript: '测试', createdAt: Date.now(),
});

describe('LiveSession', () => {
  function makeSession(overrides: Partial<{ analyzer: ReviewAnalyzer; capture: CapturePort }> = {}) {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const capture = overrides.capture ?? new FakeCapture();
    const session = new LiveSession({
      store,
      scheduler: new BoundedScheduler({ modelGlobal: 4, modelPerSession: 2, background: 1 }),
      products: PRODUCTS,
      capture,
      ...(overrides.analyzer ? { analyzer: overrides.analyzer } : {}),
      session: { sessionId: 'session-live', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '测试主播', product: DEFAULT_PRODUCT, lineup: PRODUCTS },
    });
    return { store, capture, session };
  }

  it('exposes lifecycle through dispatch and waits for capture drain before ending', async () => {
    const capture = new FakeCapture();
    capture.holdEnd();
    const { store, session } = makeSession({ capture });
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));
    await session.dispatch({ type: 'start' });
    expect(session.snapshot().lifecycle).toBe('live');
    await session.dispatch({ type: 'pause' });
    expect(session.snapshot().lifecycle).toBe('paused');
    await session.dispatch({ type: 'resume' });
    expect(session.snapshot().lifecycle).toBe('live');
    const ending = session.dispatch({ type: 'end' });
    expect(session.snapshot().lifecycle).toBe('ending');
    capture.finishEnd();
    await ending;
    expect(session.snapshot().lifecycle).toBe('ended');
    expect(events).toContain('session.ended');
    store.close();
  });

  it('coalesces repeated end commands while capture is draining', async () => {
    const capture = new FakeCapture();
    capture.holdEnd();
    const { store, session } = makeSession({ capture });
    await session.dispatch({ type: 'start' });

    const firstEnd = session.dispatch({ type: 'end' });
    const secondEnd = session.dispatch({ type: 'end' });
    expect(capture.endCalls).toBe(1);
    expect(session.snapshot().lifecycle).toBe('ending');

    capture.finishEnd();
    await Promise.all([firstEnd, secondEnd]);
    expect(session.snapshot().lifecycle).toBe('ended');
    expect(store.listSessionEvents(session.id).filter((event) => event.type === 'session.ended')).toHaveLength(1);
    store.close();
  });

  it('finishes ending even when a non-critical event subscriber fails', async () => {
    const { store, session } = makeSession();
    session.subscribe((event) => {
      if (event.type === 'session.ended') throw new Error('archive failed');
    });
    await session.dispatch({ type: 'start' });

    await expect(session.dispatch({ type: 'end' })).resolves.toBeUndefined();
    expect(session.snapshot().lifecycle).toBe('ended');
    store.close();
  });

  it('does not let a delayed model result for an old product replace the current result', async () => {
    let resolveModel!: (value: ComplianceResult) => void;
    const analyzer: ReviewAnalyzer = { analyze: () => new Promise((resolve) => { resolveModel = resolve; }) };
    const { store, session } = makeSession({ analyzer });
    await session.dispatch({ type: 'start' });
    await session.dispatch({ type: 'demo_transcript', text: '这句正在分析', isFinal: true });
    await session.dispatch({ type: 'select_product', productId: 'headphones' });
    resolveModel(result('serum', 'blocked'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.snapshot().latestCompliance?.productId).not.toBe('serum');
    store.close();
  });

  it('does not let a delayed model result overwrite an edited active product', async () => {
    let resolveModel!: (value: ComplianceResult) => void;
    const analyzer: ReviewAnalyzer = { analyze: () => new Promise((resolve) => { resolveModel = resolve; }) };
    const store = new SqliteFactStore({ filename: ':memory:' });
    let products = PRODUCTS;
    const session = new LiveSession({
      store,
      scheduler: new BoundedScheduler({ modelGlobal: 4, modelPerSession: 2, background: 1 }),
      products: () => products,
      capture: new FakeCapture(),
      analyzer,
      session: { sessionId: 'session-product-edit', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '测试主播', product: DEFAULT_PRODUCT, lineup: PRODUCTS },
    });
    await session.dispatch({ type: 'start' });
    await session.dispatch({ type: 'demo_transcript', text: '正在按旧商品资料分析', isFinal: true });
    products = PRODUCTS.map((product) => product.id === DEFAULT_PRODUCT.id ? { ...product, description: '直播中刚刚更新的商品资料', updatedAt: product.updatedAt + 1 } : product);
    await session.dispatch({ type: 'set_lineup', productIds: products.map((product) => product.id) });

    resolveModel(result('serum', 'blocked'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.snapshot().product.description).toBe('直播中刚刚更新的商品资料');
    expect(session.snapshot().latestCompliance?.risk).not.toBe('blocked');
    store.close();
  });

  it('drops a delayed semantic result after a newer transcript arrives', async () => {
    const pending: Array<(value: ComplianceResult) => void> = [];
    const analyzer: ReviewAnalyzer = { analyze: () => new Promise((resolve) => pending.push(resolve)) };
    const { store, session } = makeSession({ analyzer });
    await session.dispatch({ type: 'start' });
    await session.dispatch({ type: 'demo_transcript', text: '第一句正在分析', isFinal: true });
    await session.dispatch({ type: 'demo_transcript', text: '第二句已经更新上下文', isFinal: true });

    pending[0](result('serum', 'blocked'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.snapshot().alerts).toEqual([]);
    expect(session.snapshot().stats.blockedCount).toBe(0);
    pending[1](result('serum', 'safe'));
    store.close();
  });

  it('resets semantic context when the active product changes', async () => {
    const contexts: string[] = [];
    const analyzer: ReviewAnalyzer = { analyze: async (input) => {
      contexts.push(input.context?.text ?? '');
      return result(input.productId, 'safe');
    } };
    const { store, session } = makeSession({ analyzer });
    await session.dispatch({ type: 'start' });
    await session.dispatch({ type: 'demo_transcript', text: '精华商品的上一段介绍', isFinal: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.dispatch({ type: 'select_product', productId: 'headphones' });
    await session.dispatch({ type: 'demo_transcript', text: '耳机商品的当前介绍', isFinal: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(contexts.at(-1)).toContain('耳机商品的当前介绍');
    expect(contexts.at(-1)).not.toContain('精华商品的上一段介绍');
    store.close();
  });

  it('accepts the last final transcript while ending is draining', async () => {
    const capture = new FakeCapture();
    capture.holdEnd();
    const { store, session } = makeSession({ capture });
    await session.dispatch({ type: 'start' });
    const ending = session.dispatch({ type: 'end' });
    session.receiveAsr({ text: '这是最后一句', isFinal: true, startTimeMs: 10, endTimeMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    capture.finishEnd();
    await ending;
    expect(session.snapshot().transcriptHistory.at(-1)?.text).toBe('这是最后一句');
    expect(session.snapshot().lifecycle).toBe('ended');
    store.close();
  });

  it('recovers an orphaned live session as paused and continues with unique segment ids', async () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const creation = { sessionId: 'session-restart', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '测试主播', product: DEFAULT_PRODUCT, lineup: PRODUCTS };
    store.createSession(creation);
    store.appendSessionEvent('session-restart', { type: 'lifecycle.changed', occurredAt: 2, payload: { lifecycle: 'live' } });
    store.appendSessionEvent('session-restart', {
      type: 'transcript.final',
      occurredAt: 3,
      payload: { segment: JSON.stringify({ id: 'session-restart-segment-4', text: '重启前的话术', isFinal: true, timestamp: 3, offsetMs: 1_000, startOffsetMs: 0, endOffsetMs: 1_000, speaker: 'host' }) },
    });
    const capture = new FakeCapture();
    const recovered = new LiveSession({ store, scheduler: new BoundedScheduler({ modelGlobal: 4, modelPerSession: 2, background: 1 }), products: PRODUCTS, capture, session: creation });

    expect(recovered.snapshot().lifecycle).toBe('paused');
    await recovered.dispatch({ type: 'resume' });
    await recovered.dispatch({ type: 'demo_transcript', text: '重启后的话术' });

    expect(capture.resumeCount).toBe(1);
    expect(recovered.snapshot().transcriptHistory.map((segment) => segment.text)).toEqual(['重启前的话术', '重启后的话术']);
    expect(new Set(recovered.snapshot().transcriptHistory.map((segment) => segment.id)).size).toBe(2);
    expect(recovered.snapshot().transcriptHistory.at(-1)?.id).toBe('session-restart-segment-5');
    store.close();
  });

  it('switches the active presenter with both id and display name', async () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const session = new LiveSession({
      store,
      scheduler: new BoundedScheduler({ modelGlobal: 4, modelPerSession: 2, background: 1 }),
      products: PRODUCTS,
      capture: new FakeCapture(),
      resolvePresenter: (presenterId) => presenterId === 'presenter-xiaotang' ? { id: presenterId, name: '主播小唐' } : null,
      session: { sessionId: 'session-presenter-switch', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '默认主播', product: DEFAULT_PRODUCT, lineup: PRODUCTS },
    });

    await session.dispatch({ type: 'select_presenter', presenterId: 'presenter-xiaotang' });

    expect(session.snapshot()).toMatchObject({ presenterId: 'presenter-xiaotang', presenterName: '主播小唐' });
    store.close();
  });
});
