import { describe, expect, it } from 'vitest';
import { canDisplayJoin, CaptureLease } from '../../server/sessionAccess';

describe('display session access', () => {
  it('only joins sessions that already exist in memory or persisted history', () => {
    expect(canDisplayJoin(undefined, 'room-default', null, null)).toBe(false);
    expect(canDisplayJoin('live-unknown-session', 'room-default', null, null)).toBe(false);
    expect(canDisplayJoin('invalid-session', 'room-default', 'room-default', null)).toBe(false);
    expect(canDisplayJoin('live-active-session', 'room-other', 'room-default', null)).toBe(false);
    expect(canDisplayJoin('live-active-session', 'room-default', 'room-default', null)).toBe(true);
    expect(canDisplayJoin('live-persisted-session', 'room-default', null, 'room-default')).toBe(true);
  });
});

describe('session capture lease', () => {
  it('allows only one client to own audio capture for a session', () => {
    const lease = new CaptureLease<object>();
    const firstClient = {};
    const secondClient = {};

    expect(lease.acquire('live-active-session', firstClient)).toBe(true);
    expect(lease.acquire('live-active-session', secondClient)).toBe(false);
    expect(lease.owns('live-active-session', firstClient)).toBe(true);
    expect(lease.release('live-active-session', secondClient)).toBe(false);
    expect(lease.release('live-active-session', firstClient)).toBe(true);
    expect(lease.acquire('live-active-session', secondClient)).toBe(true);
  });
});
