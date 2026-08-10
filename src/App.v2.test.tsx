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

  it('keeps the microphone input device entry visible in the operator controls', async () => {
    render(<App />);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: 'ready', requestId: 'join', sessionId: 'live-client-test', products: PRODUCTS, snapshot: snapshot() });

    expect(await screen.findByRole('button', { name: /选择输入设备/u })).toBeTruthy();
  });

  it('starts capture with the microphone selected by the operator', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
      getAudioTracks: () => [{ getSettings: () => ({ deviceId: 'mic-presenter' }) }],
    });
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'audioinput', deviceId: 'mic-default', label: 'MacBook 麦克风', groupId: '', toJSON: () => ({}) },
          { kind: 'audioinput', deviceId: 'mic-presenter', label: '主播领夹麦', groupId: '', toJSON: () => ({}) },
        ]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    vi.stubGlobal('AudioContext', class {
      readonly destination = {};
      readonly sampleRate = 48_000;
      createMediaStreamSource() { return { connect: vi.fn() }; }
      createScriptProcessor() { return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }; }
      close() { return Promise.resolve(); }
    });

    render(<App />);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: 'ready', requestId: 'join', sessionId: 'live-client-test', products: PRODUCTS, snapshot: { ...snapshot(), lifecycle: 'idle' } });

    fireEvent.click(await screen.findByRole('button', { name: /选择输入设备/u }));
    fireEvent.change(await screen.findByLabelText('收音设备'), { target: { value: 'mic-presenter' } });
    fireEvent.click(screen.getByRole('button', { name: '开始收音' }));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'mic-presenter' } }) }));
  });

  it('pauses the live session when switching to an unavailable microphone fails', async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }], getAudioTracks: () => [{ getSettings: () => ({ deviceId: 'mic-default' }) }] };
    const getUserMedia = vi.fn().mockResolvedValueOnce(stream).mockRejectedValueOnce(new Error('设备不可用'));
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'audioinput', deviceId: 'mic-default', label: 'MacBook 麦克风', groupId: '', toJSON: () => ({}) },
          { kind: 'audioinput', deviceId: 'mic-presenter', label: '主播领夹麦', groupId: '', toJSON: () => ({}) },
        ]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    vi.stubGlobal('AudioContext', class {
      readonly destination = {};
      readonly sampleRate = 48_000;
      createMediaStreamSource() { return { connect: vi.fn() }; }
      createScriptProcessor() { return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }; }
      close() { return Promise.resolve(); }
    });

    render(<App />);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: 'ready', requestId: 'join', sessionId: 'live-client-test', products: PRODUCTS, snapshot: { ...snapshot(), lifecycle: 'idle' } });
    fireEvent.click(await screen.findByRole('button', { name: /选择输入设备/u }));
    fireEvent.click(screen.getByRole('button', { name: '开始收音' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    socket.receive({ type: 'event', event: { sessionId: 'live-client-test', sequence: 4, type: 'lifecycle.changed', occurredAt: 4, payload: { lifecycle: 'live' } }, snapshot: { ...snapshot(), lifecycle: 'live', latestSequence: 4 } });
    await screen.findByRole('button', { name: '暂停' });
    fireEvent.change(screen.getByLabelText('收音设备'), { target: { value: 'mic-presenter' } });

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({ command: { type: 'pause' } }));
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

  it('shows the operator login when the server requires a signed identity', async () => {
    render(<App />);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: 'error', requestId: 'join', message: '请先登录控制台' });

    expect(await screen.findByRole('heading', { name: '登录直播中控' })).toBeTruthy();
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

  it('edits product details in the current live room', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/rules')) return { ok: true, json: async () => ({ rules: [], audits: [] }) };
      if (input.endsWith('/presenters')) return { ok: true, json: async () => [] };
      if (input.endsWith('/products') && !init?.method) return { ok: true, json: async () => PRODUCTS };
      if (input.includes('/products/serum') && init?.method === 'PUT') return { ok: true, json: async () => JSON.parse(init.body as string) };
      throw new Error(`unexpected request: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: 'ready', requestId: 'join', sessionId: 'live-client-test', products: PRODUCTS, snapshot: snapshot() });
    fireEvent.click(await screen.findByRole('button', { name: '资料管理' }));
    fireEvent.click(await screen.findByRole('button', { name: '商品资料' }));
    fireEvent.click(await screen.findByRole('button', { name: `编辑 ${PRODUCTS[0].name}` }));
    fireEvent.change(screen.getByLabelText('商品名称'), { target: { value: '直播间实时更新精华' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并同步本场' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v2/rooms/room-default/products/serum', expect.objectContaining({ method: 'PUT' })));
  });
});
