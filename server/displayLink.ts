import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type DisplayLink = {
  alias: string;
  sessionId: string;
  roomId: string;
  expiresAt: number;
};

const ALIAS_LENGTH = 8;
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1_000;
type DisplayLinkFile = { schemaVersion: 1; links: DisplayLink[] };

export class DisplayLinkRegistry {
  private readonly links = new Map<string, DisplayLink>();
  private readonly sessionLinks = new Map<string, string>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly filePath?: string,
  ) {
    this.loadFile();
  }

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
    this.writeFile();
    return { ...link };
  }

  resolve(alias: string): DisplayLink | null {
    this.removeExpired();
    const link = this.links.get(alias.toUpperCase());
    return link ? { ...link } : null;
  }

  private removeExpired(): void {
    const currentTime = this.now();
    let changed = false;
    for (const [alias, link] of this.links) {
      if (link.expiresAt > currentTime) continue;
      this.links.delete(alias);
      if (this.sessionLinks.get(link.sessionId) === alias) this.sessionLinks.delete(link.sessionId);
      changed = true;
    }
    if (changed) this.writeFile();
  }

  private loadFile(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as DisplayLinkFile;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.links)) return;
      for (const candidate of parsed.links) {
        if (!candidate || typeof candidate.alias !== 'string' || !/^[A-Z0-9]{8}$/u.test(candidate.alias)
          || typeof candidate.sessionId !== 'string' || typeof candidate.roomId !== 'string'
          || typeof candidate.expiresAt !== 'number' || candidate.expiresAt <= this.now()) continue;
        const link = { ...candidate, alias: candidate.alias.toUpperCase() };
        this.links.set(link.alias, link);
        const existingAlias = this.sessionLinks.get(link.sessionId);
        const existing = existingAlias ? this.links.get(existingAlias) : null;
        if (!existing || existing.expiresAt < link.expiresAt) this.sessionLinks.set(link.sessionId, link.alias);
      }
    } catch {
      // An unreadable local registry should not block the operator console.
    }
  }

  private writeFile(): void {
    if (!this.filePath) return;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    const data: DisplayLinkFile = { schemaVersion: 1, links: [...this.links.values()] };
    writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}

export const DISPLAY_LINK_TTL_MS = DEFAULT_TTL_MS;
