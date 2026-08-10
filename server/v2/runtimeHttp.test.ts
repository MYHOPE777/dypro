import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { V2ServerFrame } from '../../src/shared/v2Protocol';
import { PRODUCTS } from '../../src/shared/products';
import { hashPassword } from '../auth';
import { createV2Http } from './http';
import { createRuntime, type V2Runtime } from './runtime';

class Inbox {
  private readonly frames: V2ServerFrame[] = [];
  private readonly waiters: Array<(frame: V2ServerFrame) => void> = [];
  constructor(socket: WebSocket) {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as V2ServerFrame;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame); else this.frames.push(frame);
    });
  }
  next(): Promise<V2ServerFrame> {
    const frame = this.frames.shift();
    return frame ? Promise.resolve(frame) : new Promise((resolve) => this.waiters.push(resolve));
  }
  async until(predicate: (frame: V2ServerFrame) => boolean): Promise<V2ServerFrame> {
    for (;;) { const frame = await this.next(); if (predicate(frame)) return frame; }
  }
}

describe('v2 HTTP/WebSocket runtime', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  it('resumes background delivery whenever no session is live or ending', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-runtime-background-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    cleanups.push(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
    const first = runtime.getOrCreateSession({ sessionId: 'live-background-a' });
    const second = runtime.getOrCreateSession({ sessionId: 'live-background-b' });

    await first.dispatch({ type: 'start' });
    await second.dispatch({ type: 'start' });
    expect(runtime.scheduler.snapshot().background.paused).toBe(true);
    await first.dispatch({ type: 'pause' });
    expect(runtime.scheduler.snapshot().background.paused).toBe(true);
    await second.dispatch({ type: 'pause' });
    expect(runtime.scheduler.snapshot().background.paused).toBe(false);
  });

  it('reopens a persisted session with its original room dependencies', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-runtime-reopen-room-'));
    const env = { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') };
    const first = createRuntime({ rootDir: directory, env });
    first.getOrCreateSession({ sessionId: 'live-reopen-room', roomId: 'room-private' });
    first.rules.create('room-private', 'owner', {
      name: '私有直播间规则', pattern: '私有风险词', risk: 'blocked', title: '命中私有规则',
      reason: '仅用于验证重启后的直播间绑定', alternative: '安全表达', policyRef: '测试规则',
    });
    await first.close();

    const second = createRuntime({ rootDir: directory, env });
    cleanups.push(async () => { await second.close(); rmSync(directory, { recursive: true, force: true }); });
    const restored = second.getSession('live-reopen-room');
    expect(restored?.snapshot().roomId).toBe('room-private');

    await restored!.dispatch({ type: 'start' });
    await restored!.dispatch({ type: 'demo_transcript', text: '这句话包含私有风险词' });

    expect(restored?.snapshot().latestCompliance).toMatchObject({ source: 'custom-rule', risk: 'blocked', title: '命中私有规则' });
  });

  it('keeps product details isolated per live room through the public API', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-room-products-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    runtime.getOrCreateSession({ sessionId: 'live-room-a-products', roomId: 'room-store-a' });
    runtime.getOrCreateSession({ sessionId: 'live-room-b-products', roomId: 'room-store-b' });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
    const base = PRODUCTS[0];

    const save = (roomId: string, name: string, price: string) => fetch(`http://127.0.0.1:${port}/api/v2/rooms/${roomId}/products/${base.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, name, price }),
    });
    expect((await save('room-store-a', 'A 店专属精华', '¥99')).status).toBe(200);
    expect((await save('room-store-b', 'B 店专属精华', '¥139')).status).toBe(200);

    const roomA = await (await fetch(`http://127.0.0.1:${port}/api/v2/rooms/room-store-a/products`)).json() as typeof PRODUCTS;
    const roomB = await (await fetch(`http://127.0.0.1:${port}/api/v2/rooms/room-store-b/products`)).json() as typeof PRODUCTS;
    expect(roomA.find((product) => product.id === base.id)).toMatchObject({ name: 'A 店专属精华', price: '¥99' });
    expect(roomB.find((product) => product.id === base.id)).toMatchObject({ name: 'B 店专属精华', price: '¥139' });

    const operator = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => operator.once('open', resolve));
    const inbox = new Inbox(operator);
    operator.send(JSON.stringify({ requestId: 'join-room-products', command: { type: 'session.join', sessionId: 'live-room-a-products', roomId: 'room-store-a', role: 'operator' } }));
    const ready = await inbox.until((frame) => frame.type === 'ready');
    expect(ready.type === 'ready' && ready.products.find((product) => product.id === base.id)?.name).toBe('A 店专属精华');
    operator.close();
  });

  it('broadcasts live product edits and retains the selected product in session history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-live-product-edit-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const session = runtime.getOrCreateSession({ sessionId: 'live-product-edit', roomId: 'room-product-live' });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
    const operator = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => operator.once('open', resolve));
    const inbox = new Inbox(operator);
    operator.send(JSON.stringify({ requestId: 'join-live-product', command: { type: 'session.join', sessionId: session.id, roomId: 'room-product-live', role: 'operator' } }));
    const ready = await inbox.until((frame) => frame.type === 'ready');
    if (ready.type !== 'ready') throw new Error('missing ready frame');
    operator.send(JSON.stringify({ requestId: 'start-live-product', command: { type: 'start' } }));
    await inbox.until((frame) => frame.type === 'event' && frame.event.type === 'lifecycle.changed');

    const edited = { ...PRODUCTS[0], name: '直播中更新的精华', price: '¥109' };
    const updateResponse = await fetch(`http://127.0.0.1:${port}/api/v2/rooms/room-product-live/products/${edited.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edited),
    });
    expect(updateResponse.status).toBe(200);
    const lineupUpdate = await inbox.until((frame) => frame.type === 'event' && frame.event.type === 'lineup.updated');
    expect(lineupUpdate.type === 'event' && lineupUpdate.snapshot.product).toMatchObject({ id: edited.id, name: '直播中更新的精华', price: '¥109' });

    operator.send(JSON.stringify({ requestId: 'select-live-product', command: { type: 'select_product', productId: 'headphones' } }));
    const selection = await inbox.until((frame) => frame.type === 'event' && frame.event.type === 'product.selected');
    expect(selection.type === 'event' && selection.snapshot.product.id).toBe('headphones');
    operator.send(JSON.stringify({ requestId: 'end-live-product', command: { type: 'end' } }));
    await inbox.until((frame) => frame.type === 'event' && frame.event.type === 'session.ended');

    const history = await (await fetch(`http://127.0.0.1:${port}/api/v2/sessions/${session.id}`)).json() as { roomId: string; product: { id: string }; lineup: Array<{ name: string }> };
    expect(history).toMatchObject({ roomId: 'room-product-live', product: { id: 'headphones' } });
    expect(history.lineup.some((product) => product.name === '直播中更新的精华')).toBe(true);
    operator.close();
  });

  it('archives original-rate and 16k ASR audio as separate assets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-runtime-audio-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    cleanups.push(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
    const session = runtime.getOrCreateSession({ sessionId: 'live-dual-audio' });

    await session.dispatch({ type: 'start' });
    await session.dispatch({ type: 'audio', track: 'source', pcm: new Uint8Array(9_600), sampleRate: 48_000, channels: 1 });
    await session.dispatch({ type: 'audio', track: 'asr', pcm: new Uint8Array(3_200), sampleRate: 16_000, channels: 1 });
    await session.dispatch({ type: 'end' });
    await vi.waitFor(() => expect(runtime.store.listAudioAssets(session.id)).toHaveLength(2));

    expect(runtime.store.listAudioAssets(session.id).map((asset) => [asset.encoding, asset.sampleRate, asset.durationMs])).toEqual([
      ['pcm_s16le_source', 48_000, 100],
      ['pcm_s16le_asr', 16_000, 100],
    ]);
    expect(runtime.getReview(session.id)?.summary).toMatchObject({ audioBytes: 9_600, audioDurationMs: 100 });
  });

  it('broadcasts ordered events and enforces a single capture owner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-runtime-'));
    const runtime: V2Runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const first = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => first.once('open', resolve));
    const firstInbox = new Inbox(first);
    first.send(JSON.stringify({ requestId: 'join-1', command: { type: 'session.join', roomId: 'room-default', role: 'operator' } }));
    const ready = await firstInbox.until((frame) => frame.type === 'ready');
    if (ready.type !== 'ready') throw new Error('missing ready frame');
    first.send(JSON.stringify({ requestId: 'start-1', command: { type: 'start' } }));
    const started = await firstInbox.until((frame) => frame.type === 'event' && frame.event.type === 'lifecycle.changed');
    expect(started.type === 'event' && started.event.sequence).toBe(2);

    const second = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => second.once('open', resolve));
    const secondInbox = new Inbox(second);
    second.send(JSON.stringify({ requestId: 'join-2', command: { type: 'session.join', sessionId: ready.sessionId, roomId: 'room-default', role: 'operator' } }));
    await secondInbox.until((frame) => frame.type === 'ready');
    second.send(JSON.stringify({ requestId: 'start-2', command: { type: 'start' } }));
    const denied = await secondInbox.until((frame) => frame.type === 'error');
    expect(denied.type === 'error' && denied.message).toContain('另一控制台');

    first.send(JSON.stringify({ requestId: 'demo', command: { type: 'demo_transcript', text: '这款商品保证立刻见效' } }));
    const transcript = await firstInbox.until((frame) => frame.type === 'event' && frame.event.type === 'transcript.final');
    const compliance = await firstInbox.until((frame) => frame.type === 'event' && frame.event.type === 'compliance.updated');
    expect(transcript.type === 'event' && compliance.type === 'event' && compliance.event.sequence).toBeGreaterThan(transcript.type === 'event' ? transcript.event.sequence : 0);
    first.send(JSON.stringify({ requestId: 'end', command: { type: 'end' } }));
    await firstInbox.until((frame) => frame.type === 'event' && frame.event.type === 'session.ended');
    first.close(); second.close();
  });

  it('joins the original session through a generated presenter alias', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-display-link-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const session = runtime.getOrCreateSession({ sessionId: 'live-display-link', roomId: 'room-default' });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const response = await fetch(`http://127.0.0.1:${port}/api/v2/sessions/${session.id}/display-link`, { method: 'POST' });
    const link = await response.json() as { alias: string; path: string };
    expect(response.status).toBe(200);
    expect(link.path).toBe(`/screen/${link.alias}`);

    const display = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => display.once('open', resolve));
    const inbox = new Inbox(display);
    display.send(JSON.stringify({ requestId: 'join-display', command: { type: 'session.join', displayAlias: link.alias, roomId: 'room-default', role: 'display' } }));
    const ready = await inbox.until((frame) => frame.type === 'ready');
    expect(ready.type === 'ready' && ready.sessionId).toBe(session.id);
    display.close();
  });

  it('rejects an expired presenter alias without creating another session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-expired-display-link-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const session = runtime.getOrCreateSession({ sessionId: 'live-expired-link', roomId: 'room-default' });
    const expired = runtime.store.getOrCreateDisplayLink(session.id, 1, 1);
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const display = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => display.once('open', resolve));
    const inbox = new Inbox(display);
    display.send(JSON.stringify({ requestId: 'join-expired', command: { type: 'session.join', displayAlias: expired.alias, roomId: 'room-default', role: 'display' } }));
    const error = await inbox.until((frame) => frame.type === 'error');

    expect(error.type === 'error' && error.message).toContain('主播屏地址已失效');
    expect(runtime.listSessions('room-default')).toHaveLength(1);
    display.close();
  });

  it('rejects commands for an unknown session instead of creating one implicitly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-unknown-session-command-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const response = await fetch(`http://127.0.0.1:${port}/api/v2/sessions/missing-session/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: { type: 'start' } }),
    });

    expect(response.status).toBe(404);
    expect(runtime.listSessions()).toHaveLength(0);
  });

  it('requires signed operator identity and keeps review actions reviewer-only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-auth-runtime-'));
    const env = {
      V2_DB_PATH: join(directory, 'app.sqlite'),
      V2_AUDIO_DIR: join(directory, 'audio'),
      AUTH_TOKEN_SECRET: 'this-is-a-runtime-test-secret-with-32-characters',
      ALLOW_INSECURE_AUTH: 'true',
      AUTH_USERS_JSON: JSON.stringify([
        { actorId: 'owner', displayName: '审核人', passwordHash: hashPassword('review-pass'), role: 'reviewer', roomIds: [] },
        { actorId: 'operator-1', displayName: '场控一号', passwordHash: hashPassword('operator-pass'), role: 'operator', roomIds: ['room-default'] },
      ]),
    };
    const runtime = createRuntime({ rootDir: directory, env });
    runtime.store.ensureRoom({ id: 'room-private', tenantId: 'tenant-local', ownerActorId: 'another-operator', name: '其他直播间' });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const loginResponse = await fetch(`http://127.0.0.1:${port}/api/v2/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actorId: 'operator-1', password: 'operator-pass' }),
    });
    const login = await loginResponse.json() as { token: string };
    expect(loginResponse.status).toBe(200);

    const roomsResponse = await fetch(`http://127.0.0.1:${port}/api/v2/rooms`, { headers: { Authorization: `Bearer ${login.token}` } });
    const rooms = await roomsResponse.json() as Array<{ id: string }>;
    expect(rooms.map((room) => room.id)).toEqual(['room-default']);

    const sessionsResponse = await fetch(`http://127.0.0.1:${port}/api/v2/sessions?roomId=room-default`, { headers: { Authorization: `Bearer ${login.token}` } });
    expect(sessionsResponse.status).toBe(403);

    const operator = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => operator.once('open', resolve));
    const inbox = new Inbox(operator);
    operator.send(JSON.stringify({ requestId: 'join-authenticated', command: { type: 'session.join', roomId: 'room-default', role: 'operator', token: login.token } }));
    const ready = await inbox.until((frame) => frame.type === 'ready');
    expect(ready.type).toBe('ready');
    operator.close();
  });
});
