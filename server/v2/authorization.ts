import { AuthService, type AuthIdentity } from '../auth';

export type Permission = 'view' | 'control' | 'review' | 'deliver';

export class AuthorizationModule {
  readonly mode: 'local' | 'authenticated';
  private readonly auth: AuthService;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.auth = new AuthService(env);
    this.mode = this.auth.configured ? 'authenticated' : 'local';
  }

  login(actorId: string, password: string): ReturnType<AuthService['login']> {
    return this.auth.login(actorId, password);
  }

  authenticate(input: Parameters<AuthService['authenticate']>[0]): AuthIdentity {
    return this.auth.authenticate(input);
  }

  assertControlTransport(input: Parameters<AuthService['assertControlTransport']>[0]): void {
    this.auth.assertControlTransport(input);
  }

  assert(identity: AuthIdentity, roomId: string, permission: Permission): void {
    if (identity.role === 'reviewer') return;
    const canUseRoom = identity.roomIds.includes(roomId);
    const canOperate = permission === 'view' || permission === 'control';
    if (!canUseRoom || !canOperate) throw new Error('无权执行此操作');
  }
}
