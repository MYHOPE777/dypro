import { describe, expect, it, vi } from 'vitest';
import { canSelectInputDevice, switchInputDevice } from './microphoneDevice';

describe('microphone input device switching', () => {
  it('stops the previous stream before starting the selected device', async () => {
    const calls: string[] = [];
    const stop = vi.fn(() => calls.push('stop'));
    const start = vi.fn(async (deviceId: string) => {
      calls.push(`start:${deviceId}`);
      return true;
    });

    await expect(switchInputDevice('bluetooth-mic', { capturing: true, stop, start })).resolves.toBe(true);

    expect(calls).toEqual(['stop', 'start:bluetooth-mic']);
  });

  it('does not restart a stream when choosing a device before testing', async () => {
    const stop = vi.fn();
    const start = vi.fn(async () => true);

    await expect(switchInputDevice('bluetooth-mic', { capturing: false, stop, start })).resolves.toBe(true);

    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('allows device selection while idle or paused, but locks it during live capture', () => {
    expect(canSelectInputDevice('idle', true)).toBe(true);
    expect(canSelectInputDevice('paused', true)).toBe(true);
    expect(canSelectInputDevice('live', true)).toBe(false);
    expect(canSelectInputDevice('idle', false)).toBe(false);
  });
});
