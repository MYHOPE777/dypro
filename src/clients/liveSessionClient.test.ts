// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTS } from '../shared/products';
import type { LiveEvent, LiveSessionSnapshot } from '../shared/v2';
import type { V2ServerFrame } from '../shared/v2Protocol';
import { LiveSessionClient } from './liveSessionClient';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(payload: unknown) { this.sent.push(payload); }
  close() { this.readyState = 3; }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  disconnect() { this.readyState = 3; this.onclose?.(); }
  receive(frame: V2ServerFrame) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>); }
}

function snapshot(sequence: number, words = 0): LiveSessionSnapshot {
  return {
    sessionId: 'live-reconnect', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '测试主播', lifecycle: 'live',
    product: PRODUCTS[0], lineup: PRODUCTS, partialTranscript: '', transcriptHistory: [], transcriptAnnotations: [], latestCompliance: null, alerts: [], coachSuggestions: [], coachPending: false,
    riskProfile: 'strict', stats: { speakingSeconds: 0, words, blockedCount: 0, warningCount: 0, safeCount: 0 }, contentRevision: 0, latestSequence: sequence, createdAt: 1, updatedAt: sequence,
  };
}

function event(sequence: number): LiveEvent {
  return { sessionId: 'live-reconnect', sequence, type: 'transcript.partial', occurredAt: sequence, payload: { text: `事件 ${sequence}` } };
}

describe('LiveSessionClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    localStorage.clear();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('deduplicates events and refills the latest snapshot after reconnecting', () => {
    const client = new LiveSessionClient({ roomId: 'room-default', role: 'display' });
    const received: LiveSessionSnapshot[] = [];
    client.subscribe((next) => received.push(next));
    client.connect();

    const first = FakeWebSocket.instances[0];
    first.open();
    first.receive({ type: 'ready', requestId: 'join-1', sessionId: 'live-reconnect', products: PRODUCTS, snapshot: snapshot(2, 2) });
    first.receive({ type: 'event', event: event(3), snapshot: snapshot(3, 3) });
    first.receive({ type: 'event', event: event(3), snapshot: snapshot(3, 999) });
    expect(received.map((item) => item.stats.words)).toEqual([2, 3]);

    first.disconnect();
    vi.advanceTimersByTime(1_000);
    const second = FakeWebSocket.instances[1];
    second.open();
    const join = JSON.parse(second.sent[0] as string) as { command: { sessionId?: string } };
    expect(join.command.sessionId).toBe('live-reconnect');
    second.receive({ type: 'ready', requestId: 'join-2', sessionId: 'live-reconnect', products: PRODUCTS, snapshot: snapshot(5, 5) });

    expect(client.snapshot?.latestSequence).toBe(5);
    expect(received.at(-1)?.stats.words).toBe(5);
    client.close();
  });

  it('authenticates operator joins with the stored signed token', () => {
    localStorage.setItem('v2-auth-token', 'signed-operator-token');
    const client = new LiveSessionClient({ roomId: 'room-default', role: 'operator' });

    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    const join = JSON.parse(socket.sent[0] as string) as { command: { token?: string } };
    expect(join.command.token).toBe('signed-operator-token');
    client.close();
  });

  it('refreshes the room catalog without changing the session lineup', () => {
    const client = new LiveSessionClient({ roomId: 'room-default', role: 'operator' });
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: 'ready', requestId: 'join', sessionId: 'live-reconnect', products: PRODUCTS, snapshot: snapshot(2) });
    const extra = { ...PRODUCTS[2], id: 'new-product', name: '新商品' };
    socket.receive({ type: 'event', event: { sessionId: 'live-reconnect', sequence: 3, type: 'catalog.updated', occurredAt: 3, payload: { products: JSON.stringify([...PRODUCTS, extra]) } }, snapshot: snapshot(3) });

    expect(client.products.at(-1)).toMatchObject({ id: 'new-product', name: '新商品' });
    expect(client.snapshot?.lineup).toHaveLength(PRODUCTS.length);
    client.close();
  });
});
