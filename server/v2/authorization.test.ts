import { describe, expect, it } from 'vitest';
import { AuthorizationModule } from './authorization';

describe('AuthorizationModule', () => {
  it('allows local mode and enforces configured room permissions', () => {
    expect(() => new AuthorizationModule({}).assert('anyone', 'room-default', 'control')).not.toThrow();
    const authorization = new AuthorizationModule({ V2_ACCESS_JSON: JSON.stringify([{ actorId: 'reviewer', roomIds: ['room-a'], permissions: ['view', 'review'] }]) });
    expect(() => authorization.assert('reviewer', 'room-a', 'review')).not.toThrow();
    expect(() => authorization.assert('reviewer', 'room-a', 'deliver')).toThrow('无权执行此操作');
    expect(() => authorization.assert('reviewer', 'room-b', 'view')).toThrow('无权执行此操作');
  });
});
