export type Permission = 'view' | 'control' | 'review' | 'deliver';
type AccessEntry = { actorId: string; roomIds: string[]; permissions: Permission[] };

function parseEntries(raw: string | undefined): AccessEntry[] {
  if (!raw?.trim()) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.actorId !== 'string' || !Array.isArray(candidate.roomIds) || !Array.isArray(candidate.permissions)) return [];
      return [{ actorId: candidate.actorId, roomIds: candidate.roomIds.filter((item): item is string => typeof item === 'string'), permissions: candidate.permissions.filter((item): item is Permission => item === 'view' || item === 'control' || item === 'review' || item === 'deliver') }];
    });
  } catch { return []; }
}
export class AuthorizationModule {
  readonly mode: 'local' | 'acl';
  private readonly entries: AccessEntry[];

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.entries = parseEntries(env.V2_ACCESS_JSON);
    this.mode = this.entries.length > 0 ? 'acl' : 'local';
  }

  assert(actorId: string, roomId: string, permission: Permission): void {
    if (this.mode === 'local') return;
    const entry = this.entries.find((candidate) => candidate.actorId === actorId);
    if (!entry || (!entry.roomIds.includes('*') && !entry.roomIds.includes(roomId)) || !entry.permissions.includes(permission)) throw new Error('无权执行此操作');
  }
}
