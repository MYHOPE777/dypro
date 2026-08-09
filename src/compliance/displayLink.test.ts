import { describe, expect, it } from 'vitest';
import { DisplayLinkRegistry } from '../../server/displayLink';

describe('DisplayLinkRegistry', () => {
  it('reuses a short-lived link for the same session', () => {
    let now = 1_000;
    const registry = new DisplayLinkRegistry(10_000, () => now);
    const first = registry.getOrCreate('live-session-1', 'room-default');
    const second = registry.getOrCreate('live-session-1', 'room-default');

    expect(first).toEqual(second);
    expect(first.alias).toMatch(/^[A-Z0-9]{8}$/u);
    expect(registry.resolve(first.alias)).toEqual(first);

    now += 10_001;
    expect(registry.resolve(first.alias)).toBeNull();
  });

  it('does not reuse an expired alias after recreating the session link', () => {
    let now = 1_000;
    const registry = new DisplayLinkRegistry(100, () => now);
    const first = registry.getOrCreate('live-session-1', 'room-default');
    now += 101;
    const second = registry.getOrCreate('live-session-1', 'room-default');

    expect(second.alias).not.toBe(first.alias);
    expect(registry.resolve(first.alias)).toBeNull();
    expect(registry.resolve(second.alias)).toEqual(second);
  });
});
