import { describe, expect, it } from 'vitest';
import { AuthService, allowsControlTransport, canAccessRoom, hashPassword } from '../../server/auth';
import { readSessionIdleTtlMs } from '../../server/config';

const configuredEnv = {
  AUTH_TOKEN_SECRET: 'this-is-a-test-secret-with-32-characters',
  AUTH_USERS_JSON: JSON.stringify([
    { actorId: 'owner', displayName: '系统审核人', passwordHash: hashPassword('owner-pass-123', 'test-owner-salt'), role: 'reviewer', roomIds: [] },
    { actorId: 'staff-a', displayName: '一号场控', passwordHash: hashPassword('staff-pass-123', 'test-staff-salt'), role: 'operator', roomIds: ['room-default'] },
  ]),
  RULE_REVIEWER_ACTOR_ID: 'owner',
};

describe('AuthService', () => {
  it('binds a signed login token to the configured actor identity', () => {
    const auth = new AuthService(configuredEnv, () => 1_000);
    const login = auth.login('staff-a', 'staff-pass-123');

    expect(auth.authenticate({ token: login.token, claimedActorId: 'owner', remoteAddress: '192.168.0.20' })).toEqual({
      actorId: 'staff-a', displayName: '一号场控', role: 'operator', roomIds: ['room-default'],
    });
    expect(() => auth.authenticate({ token: `${login.token}x`, remoteAddress: '192.168.0.20' })).toThrow('登录凭证无效');
  });

  it('rejects expired login tokens', () => {
    let now = 1_000;
    const auth = new AuthService({ ...configuredEnv, AUTH_TOKEN_TTL_HOURS: '1' }, () => now);
    const login = auth.login('owner', 'owner-pass-123');
    now += 3_600_001;

    expect(() => auth.authenticate({ token: login.token, remoteAddress: '127.0.0.1' })).toThrow('登录已过期');
  });

  it('rejects invalid duration settings at startup', () => {
    expect(() => new AuthService({ ...configuredEnv, AUTH_TOKEN_TTL_HOURS: 'not-a-number' })).toThrow('AUTH_TOKEN_TTL_HOURS 必须是正数');
    expect(() => readSessionIdleTtlMs({ SESSION_IDLE_TTL_MS: 'Infinity' })).toThrow('SESSION_IDLE_TTL_MS 必须是正数');
  });

  it('allows unconfigured control only from the local MacBook', () => {
    const auth = new AuthService({ RULE_REVIEWER_ACTOR_ID: 'owner' });

    expect(auth.authenticate({ claimedActorId: 'owner', remoteAddress: '::1', origin: 'http://localhost:8787' }).role).toBe('reviewer');
    expect(auth.authenticate({ claimedActorId: 'local-staff', remoteAddress: '127.0.0.1', origin: 'http://localhost:8787' }).role).toBe('reviewer');
    expect(auth.authenticate({ claimedActorId: 'owner', remoteAddress: '127.0.0.1' }).role).toBe('reviewer');
    expect(() => auth.authenticate({ claimedActorId: 'owner', remoteAddress: '192.168.0.20' })).toThrow('只允许从 MacBook 本机访问');
    expect(() => auth.authenticate({ claimedActorId: 'owner', remoteAddress: '127.0.0.1', origin: 'https://malicious.example' })).toThrow('只允许本机页面控制');
  });

  it('limits operators to assigned or owned rooms while reviewers can access all rooms', () => {
    const auth = new AuthService(configuredEnv);
    const operator = auth.login('staff-a', 'staff-pass-123').identity;
    const reviewer = auth.login('owner', 'owner-pass-123').identity;

    expect(canAccessRoom(operator, { id: 'room-default', ownerActorId: 'owner' })).toBe(true);
    expect(canAccessRoom(operator, { id: 'room-owned', ownerActorId: 'staff-a' })).toBe(true);
    expect(canAccessRoom(operator, { id: 'room-private', ownerActorId: 'staff-b' })).toBe(false);
    expect(canAccessRoom(reviewer, { id: 'room-private', ownerActorId: 'staff-b' })).toBe(true);
  });

  it('authenticates scrypt password hashes and rejects plaintext account configs', () => {
    const hashedEnv = {
      ...configuredEnv,
      AUTH_USERS_JSON: JSON.stringify([
        { actorId: 'owner', displayName: '系统审核人', passwordHash: hashPassword('owner-pass-123', 'test-owner-salt'), role: 'reviewer', roomIds: [] },
      ]),
    };

    expect(new AuthService(hashedEnv).login('owner', 'owner-pass-123').identity.actorId).toBe('owner');
    expect(() => new AuthService({
      ...configuredEnv,
      AUTH_USERS_JSON: JSON.stringify([{ actorId: 'owner', displayName: '系统审核人', password: 'owner-pass-123', role: 'reviewer' }]),
    })).toThrow('passwordHash');
  });

  it('requires encrypted transport for configured multi-user control', () => {
    expect(allowsControlTransport({ authConfigured: false, encrypted: false, remoteAddress: '192.168.0.20' })).toBe(true);
    expect(allowsControlTransport({ authConfigured: true, encrypted: false, remoteAddress: '192.168.0.20' })).toBe(false);
    expect(allowsControlTransport({ authConfigured: true, encrypted: true, remoteAddress: '192.168.0.20' })).toBe(true);
    expect(allowsControlTransport({ authConfigured: true, encrypted: false, remoteAddress: '127.0.0.1', forwardedProto: 'https' })).toBe(true);
    expect(allowsControlTransport({ authConfigured: true, encrypted: false, remoteAddress: '192.168.0.20', forwardedProto: 'https' })).toBe(false);
    expect(allowsControlTransport({ authConfigured: true, encrypted: false, remoteAddress: '192.168.0.20', allowInsecure: true })).toBe(true);
  });
});
