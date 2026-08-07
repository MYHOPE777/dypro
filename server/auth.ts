import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readAuthTokenTtlMs } from './config';

export type AuthRole = 'operator' | 'reviewer';

export type AuthIdentity = {
  actorId: string;
  displayName: string;
  role: AuthRole;
  roomIds: string[];
  tenantId?: string;
  tenantIds?: string[];
};

type AuthUser = AuthIdentity & { passwordHash: string };
type TokenPayload = AuthIdentity & { expiresAt: number };

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLocalBrowserOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

function safeActorId(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/u.test(value) ? value : 'local-operator';
}

function parseRoomIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((roomId) => typeof roomId !== 'string' || !/^room-[a-z0-9-]{4,64}$/u.test(roomId))) {
    throw new Error('认证账号的 roomIds 必须是合法直播间 ID 数组');
  }
  return [...new Set(value)];
}

function parseTenantId(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,63}$/u.test(value)) throw new Error('认证账号的 tenantId 格式无效');
  return value;
}

function parseTenantIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('认证账号的 tenantIds 必须是数组');
  const tenantIds = value.map(parseTenantId).filter((tenantId): tenantId is string => Boolean(tenantId));
  if (tenantIds.length === 0) throw new Error('认证账号的 tenantIds 不能为空');
  return [...new Set(tenantIds)];
}

export function canAccessRoom(identity: AuthIdentity, room: { id: string; ownerActorId: string; tenantId?: string }): boolean {
  if (room.tenantId && identity.tenantId && room.tenantId !== identity.tenantId) return false;
  if (room.tenantId && identity.tenantIds && !identity.tenantIds.includes(room.tenantId)) return false;
  return identity.role === 'reviewer' || room.ownerActorId === identity.actorId || identity.roomIds.includes(room.id);
}

export function allowsControlTransport(input: {
  authConfigured: boolean;
  encrypted: boolean;
  remoteAddress?: string;
  forwardedProto?: string;
  allowInsecure?: boolean;
}): boolean {
  if (!input.authConfigured || input.allowInsecure || input.encrypted) return true;
  const forwardedProto = input.forwardedProto?.split(',')[0]?.trim().toLowerCase();
  return isLoopback(input.remoteAddress) && forwardedProto === 'https';
}

function secureEqual(first: string, second: string): boolean {
  return timingSafeEqual(createHash('sha256').update(first).digest(), createHash('sha256').update(second).digest());
}

function isPasswordHash(value: string): boolean {
  const [scheme, salt, digest, extra] = value.split('$');
  return scheme === 'scrypt' && Boolean(salt && digest && !extra && /^[a-zA-Z0-9_-]+$/u.test(salt) && /^[a-zA-Z0-9_-]+$/u.test(digest));
}

export function hashPassword(password: string, salt = randomBytes(16).toString('base64url')): string {
  if (password.length < 8) throw new Error('密码至少需要 8 位');
  if (!salt || !/^[a-zA-Z0-9_-]+$/u.test(salt)) throw new Error('密码盐格式无效');
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString('base64url')}`;
}

function verifyPassword(password: string, passwordHash: string): boolean {
  if (!isPasswordHash(passwordHash)) return false;
  const [, salt, expected] = passwordHash.split('$');
  return secureEqual(scryptSync(password, salt, 32).toString('base64url'), expected);
}

function parseUsers(raw: string | undefined): AuthUser[] {
  if (!raw?.trim()) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('AUTH_USERS_JSON 必须是账号数组');
  const users = parsed.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('AUTH_USERS_JSON 包含无效账号');
    const user = value as Record<string, unknown>;
    const actorId = safeActorId(user.actorId);
    const displayName = typeof user.displayName === 'string' ? user.displayName.trim() : '';
    const passwordHash = typeof user.passwordHash === 'string' ? user.passwordHash : '';
    const roomIds = parseRoomIds(user.roomIds);
    const tenantId = parseTenantId(user.tenantId);
    const tenantIds = parseTenantIds(user.tenantIds);
    const role: AuthRole | null = user.role === 'reviewer' ? 'reviewer' : user.role === 'operator' ? 'operator' : null;
    if (actorId !== user.actorId || !displayName || !isPasswordHash(passwordHash) || !role) throw new Error('认证账号需要合法 actorId、名称、scrypt passwordHash 和角色');
    return { actorId, displayName, passwordHash, role, roomIds, ...(tenantId ? { tenantId } : {}), ...(tenantIds ? { tenantIds } : {}) };
  });
  if (new Set(users.map((user) => user.actorId)).size !== users.length) throw new Error('AUTH_USERS_JSON 存在重复 actorId');
  return users;
}

export class AuthService {
  private readonly users: Map<string, AuthUser>;
  private readonly tokenSecret: string;
  private readonly reviewerActorId: string;
  private readonly tokenTtlMs: number;
  private readonly now: () => number;
  readonly configured: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now) {
    const users = parseUsers(env.AUTH_USERS_JSON);
    this.tokenSecret = env.AUTH_TOKEN_SECRET?.trim() ?? '';
    if ((users.length > 0) !== Boolean(this.tokenSecret)) throw new Error('AUTH_USERS_JSON 与 AUTH_TOKEN_SECRET 必须同时配置');
    if (this.tokenSecret && this.tokenSecret.length < 32) throw new Error('AUTH_TOKEN_SECRET 至少需要 32 个字符');
    this.users = new Map(users.map((user) => [user.actorId, user]));
    this.reviewerActorId = env.RULE_REVIEWER_ACTOR_ID ?? 'owner';
    this.tokenTtlMs = readAuthTokenTtlMs(env);
    this.now = now;
    this.configured = users.length > 0;
    if (this.configured && this.users.get(this.reviewerActorId)?.role !== 'reviewer') {
      throw new Error('RULE_REVIEWER_ACTOR_ID 必须对应 reviewer 账号');
    }
  }

  login(actorId: string, password: string): { identity: AuthIdentity; token: string } {
    if (!this.configured) throw new Error('当前为本机控制模式，无需登录');
    const user = this.users.get(actorId);
    if (!user || !verifyPassword(password, user.passwordHash)) throw new Error('账号或密码不正确');
    const identity: AuthIdentity = { actorId: user.actorId, displayName: user.displayName, role: user.role, roomIds: user.roomIds, ...(user.tenantId ? { tenantId: user.tenantId } : {}), ...(user.tenantIds ? { tenantIds: user.tenantIds } : {}) };
    return { identity, token: this.sign({ ...identity, expiresAt: this.now() + this.tokenTtlMs }) };
  }

  authenticate(input: { token?: string; claimedActorId?: unknown; remoteAddress?: string; origin?: string }): AuthIdentity {
    if (!this.configured) {
      if (!isLoopback(input.remoteAddress)) throw new Error('未配置多人账号时，控制台只允许从 MacBook 本机访问');
      if (!isLocalBrowserOrigin(input.origin)) throw new Error('未配置多人账号时，只允许本机页面控制');
      const actorId = safeActorId(input.claimedActorId);
      return { actorId, displayName: actorId, role: 'reviewer', roomIds: [] };
    }
    if (!input.token) throw new Error('请先登录控制台');
    return this.verify(input.token);
  }

  private sign(payload: TokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.tokenSecret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private verify(token: string): AuthIdentity {
    const [encoded, signature, extra] = token.split('.');
    if (!encoded || !signature || extra) throw new Error('登录凭证无效');
    const expected = createHmac('sha256', this.tokenSecret).update(encoded).digest('base64url');
    if (!secureEqual(signature, expected)) throw new Error('登录凭证无效');
    let payload: TokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload;
    } catch {
      throw new Error('登录凭证无效');
    }
    const user = this.users.get(payload.actorId);
    if (!user || payload.expiresAt <= this.now() || payload.role !== user.role || payload.displayName !== user.displayName || JSON.stringify(payload.roomIds) !== JSON.stringify(user.roomIds) || payload.tenantId !== user.tenantId || JSON.stringify(payload.tenantIds) !== JSON.stringify(user.tenantIds)) throw new Error('登录已过期，请重新登录');
    return { actorId: user.actorId, displayName: user.displayName, role: user.role, roomIds: user.roomIds, ...(user.tenantId ? { tenantId: user.tenantId } : {}), ...(user.tenantIds ? { tenantIds: user.tenantIds } : {}) };
  }
}
