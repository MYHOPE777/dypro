import { describe, expect, it } from 'vitest';
import { BoundedScheduler } from './scheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('BoundedScheduler', () => {
  it('limits model work globally and per session while realtime remains immediate', async () => {
    const scheduler = new BoundedScheduler({ modelGlobal: 4, modelPerSession: 2, background: 1 });
    const held = deferred<string>();
    const heldSecond = deferred<string>();
    const first = scheduler.run('model', 'session-a', () => held.promise);
    const second = scheduler.run('model', 'session-a', () => heldSecond.promise);
    const queued = scheduler.run('model', 'session-a', async () => 'a3');
    const otherSession = scheduler.run('model', 'session-b', async () => 'b1');
    const realtime = scheduler.run('realtime', 'session-a', async () => 'instant');

    await expect(realtime).resolves.toBe('instant');
    await expect(otherSession).resolves.toBe('b1');
    expect(scheduler.snapshot().model.queued).toBe(1);
    heldSecond.resolve('a2');
    await expect(second).resolves.toBe('a2');
    held.resolve('a1');
    await expect(first).resolves.toBe('a1');
    await expect(queued).resolves.toBe('a3');
    expect(scheduler.snapshot().model.running).toBe(0);
  });

  it('pauses background work without affecting realtime or model work', async () => {
    const scheduler = new BoundedScheduler({ modelGlobal: 1, modelPerSession: 1, background: 1 });
    scheduler.pauseBackground();
    const background = scheduler.run('background', 'session-a', async () => 'uploaded');
    await expect(scheduler.run('realtime', 'session-a', async () => 'local')).resolves.toBe('local');
    expect(scheduler.snapshot().background.queued).toBe(1);
    scheduler.resumeBackground();
    await expect(background).resolves.toBe('uploaded');
  });
});
