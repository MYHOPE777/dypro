import { randomUUID } from 'node:crypto';

export type DisplayLink = {
  alias: string;
  sessionId: string;
  roomId: string;
  expiresAt: number;
};

const ALIAS_LENGTH = 8;
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1_000;

export class DisplayLinkRegistry {
  private readonly links = new Map<string, DisplayLink>();
  private readonly sessionLinks = new Map<string, string>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  getOrCreate(sessionId: string, roomId: string): DisplayLink {
    this.removeExpired();
    const existingAlias = this.sessionLinks.get(sessionId);
    const existing = existingAlias ? this.links.get(existingAlias) : undefined;
    if (existing && existing.roomId === roomId) return { ...existing };

    let alias = '';
    do {
      alias = randomUUID().replaceAll('-', '').slice(0, ALIAS_LENGTH).toUpperCase();
    } while (this.links.has(alias));
    const link = { alias, sessionId, roomId, expiresAt: this.now() + this.ttlMs };
    this.links.set(alias, link);
    this.sessionLinks.set(sessionId, alias);
    return { ...link };
  }

  resolve(alias: string): DisplayLink | null {
    this.removeExpired();
    const link = this.links.get(alias.toUpperCase());
    return link ? { ...link } : null;
  }

  private removeExpired(): void {
    const currentTime = this.now();
    for (const [alias, link] of this.links) {
      if (link.expiresAt > currentTime) continue;
      this.links.delete(alias);
      if (this.sessionLinks.get(link.sessionId) === alias) this.sessionLinks.delete(link.sessionId);
    }
  }
}

export const DISPLAY_LINK_TTL_MS = DEFAULT_TTL_MS;
