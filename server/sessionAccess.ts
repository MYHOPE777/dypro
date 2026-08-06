const SESSION_ID_PATTERN = /^live-[a-z0-9-]{4,32}$/u;

export function canDisplayJoin(
  sessionId: string | undefined,
  requestedRoomId: string,
  activeRoomId: string | null,
  persistedRoomId: string | null,
): boolean {
  const knownRoomId = activeRoomId ?? persistedRoomId;
  return Boolean(sessionId && SESSION_ID_PATTERN.test(sessionId) && knownRoomId === requestedRoomId);
}

export class CaptureLease<Client extends object> {
  private readonly owners = new Map<string, Client>();

  acquire(sessionId: string, client: Client): boolean {
    const owner = this.owners.get(sessionId);
    if (owner && owner !== client) return false;
    this.owners.set(sessionId, client);
    return true;
  }

  owns(sessionId: string, client: Client): boolean {
    return this.owners.get(sessionId) === client;
  }

  release(sessionId: string, client: Client): boolean {
    if (!this.owns(sessionId, client)) return false;
    this.owners.delete(sessionId);
    return true;
  }

  clear(sessionId: string): void {
    this.owners.delete(sessionId);
  }
}
