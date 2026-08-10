import { describe, expect, it } from 'vitest';
import { hashPassword } from '../auth';
import { AuthorizationModule } from './authorization';

describe('AuthorizationModule', () => {
  it('allows local control only from the MacBook loopback interface', () => {
    const authorization = new AuthorizationModule({});
    const local = authorization.authenticate({ remoteAddress: '127.0.0.1', claimedActorId: 'local-operator' });

    expect(() => authorization.assert(local, 'room-default', 'deliver')).not.toThrow();
    expect(() => authorization.authenticate({ remoteAddress: '192.168.1.20', claimedActorId: 'local-operator' })).toThrow('只允许从 MacBook 本机访问');
  });

  it('uses signed login tokens and role permissions in multi-user mode', () => {
    const authorization = new AuthorizationModule({
      AUTH_TOKEN_SECRET: 'this-is-a-test-secret-with-32-characters',
      AUTH_USERS_JSON: JSON.stringify([
        { actorId: 'owner', displayName: '审核人', passwordHash: hashPassword('review-pass'), role: 'reviewer', roomIds: [] },
        { actorId: 'operator-1', displayName: '场控一号', passwordHash: hashPassword('operator-pass'), role: 'operator', roomIds: ['room-default'] },
      ]),
    });
    const { token } = authorization.login('operator-1', 'operator-pass');
    const operator = authorization.authenticate({ token, remoteAddress: '192.168.1.20' });

    expect(() => authorization.assert(operator, 'room-default', 'control')).not.toThrow();
    expect(() => authorization.assert(operator, 'room-default', 'review')).toThrow('无权执行此操作');
    expect(() => authorization.authenticate({ remoteAddress: '192.168.1.20', claimedActorId: 'operator-1' })).toThrow('请先登录控制台');
  });
});
