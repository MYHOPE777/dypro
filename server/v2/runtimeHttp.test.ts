import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { V2ServerFrame } from '../../src/shared/v2Protocol';
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
});
