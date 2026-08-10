// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { PRODUCTS } from './shared/products';
import type { LiveSessionSnapshot } from './shared/v2';
import type { V2ServerFrame } from './shared/v2Protocol';

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
  receive(frame: V2ServerFrame) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>); }
}

function snapshot(): LiveSessionSnapshot {
  return {
    sessionId: 'live-client-test', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '测试主播', lifecycle: 'live',
    product: PRODUCTS[0], lineup: PRODUCTS, partialTranscript: '正在介绍商品', transcriptHistory: [], latestCompliance: null, alerts: [],
    coachSuggestions: [
      { id: 'one', purpose: '塑品', text: '第一段建议', reason: '建立价值', source: 'local-fallback', createdAt: 1 },
      { id: 'two', purpose: '互动', text: '第二段建议', reason: '引导互动', source: 'local-fallback', createdAt: 1 },
      { id: 'three', purpose: '转化', text: '第三段建议', reason: '承接转化', source: 'local-fallback', createdAt: 1 },
    ], coachPending: false, riskProfile: 'balanced', stats: { speakingSeconds: 12, words: 20, blockedCount: 0, warningCount: 0, safeCount: 1 }, contentRevision: 0, latestSequence: 3, createdAt: 1, updatedAt: 2,
  };
}

describe('v2 operator view', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    localStorage.clear();
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('renders three coaching choices and sends typed product commands', async () => {
    render(<App />);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: 'ready', requestId: 'join', sessionId: 'live-client-test', products: PRODUCTS, snapshot: snapshot() });
    expect(await screen.findByText('第一段建议')).toBeTruthy();
    expect(screen.getByText('第二段建议')).toBeTruthy();
    expect(screen.getByText('第三段建议')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /云感降噪耳机/ }));
    await waitFor(() => {
      const frame = JSON.parse(socket.sent.at(-1) as string) as { command: { type: string; productId?: string } };
      expect(frame.command).toEqual({ type: 'select_product', productId: 'headphones' });
    });
  });

  it('joins a presenter screen by alias without reusing a stale local session', () => {
    localStorage.setItem('v2-live-session', 'live-stale-session');
    window.history.replaceState(null, '', '/screen/ABCD1234');

    render(<App />);
    const socket = FakeWebSocket.instances[0];
    socket.open();

    const frame = JSON.parse(socket.sent[0] as string) as { command: Record<string, unknown> };
    expect(frame.command).toMatchObject({ type: 'session.join', role: 'display', displayAlias: 'ABCD1234' });
    expect(frame.command).not.toHaveProperty('sessionId');
  });

  it('loads a folded presenter link and QR code only after the operator opens it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ alias: 'QR12ABCD', sessionId: 'live-client-test', expiresAt: Date.now() + 60_000, path: '/screen/QR12ABCD' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: 'ready', requestId: 'join', sessionId: 'live-client-test', products: PRODUCTS, snapshot: snapshot() });

    expect(screen.queryByAltText('主播屏二维码')).toBeNull();
    fireEvent.click(await screen.findByText('主播屏入口'));

    expect(await screen.findByText('临时入口 QR12ABCD')).toBeTruthy();
    expect(await screen.findByAltText('主播屏二维码')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/sessions/live-client-test/display-link', expect.objectContaining({ method: 'POST' }));
  });

  it('selects a presenter profile as the active presenter for the live session', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input.includes('/rules')) return { ok: true, json: async () => ({ rules: [], audits: [] }) };
      if (input.includes('/presenters/presenter-') && input.includes('/phrases')) return { ok: true, json: async () => [] };
      if (input.endsWith('/presenters')) return { ok: true, json: async () => [
        { id: 'presenter-default', roomId: 'room-default', name: '默认主播', accountName: '本地账号', createdAt: 1, updatedAt: 1 },
        { id: 'presenter-xiaotang', roomId: 'room-default', name: '主播小唐', accountName: '本地账号', createdAt: 1, updatedAt: 1 },
      ] };
      throw new Error(`unexpected request: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: 'ready', requestId: 'join', sessionId: 'live-client-test', products: PRODUCTS, snapshot: snapshot() });
    fireEvent.click(await screen.findByRole('button', { name: '资料管理' }));

    fireEvent.change(await screen.findByDisplayValue('默认主播'), { target: { value: 'presenter-xiaotang' } });
    fireEvent.click(await screen.findByRole('button', { name: '设为本场主播' }));

    const frame = JSON.parse(socket.sent.at(-1) as string) as { command: { type: string; presenterId?: string } };
    expect(frame.command).toEqual({ type: 'select_presenter', presenterId: 'presenter-xiaotang' });
  });
});
