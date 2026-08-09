import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PresenterPhrase } from '../src/shared/types';
import type { PhraseMutationListener } from './presenterPhraseLibrary';

type PhraseSyncConfig = { url: string; apiKey: string; timeoutMs: number };
type PhraseSyncTask = { id: string; event: { action: Parameters<PhraseMutationListener>[0]['action']; phrase: PresenterPhrase; occurredAt: number }; status: 'pending' | 'failed' | 'succeeded'; attempts: number; createdAt: number; updatedAt: number; nextAttemptAt: number; lastError?: string };
type PhraseSyncFile = { schemaVersion: 1; tasks: PhraseSyncTask[] };

export type PhraseSyncStatus = { configured: boolean; pending: number; failed: number; succeeded: number; lastSyncedAt: number | null; lastError?: string };

function configFromEnv(env: NodeJS.ProcessEnv): PhraseSyncConfig | null {
  const url = env.PHRASE_LIBRARY_SYNC_URL?.trim();
  const apiKey = env.PHRASE_LIBRARY_SYNC_KEY?.trim();
  if (!url || !apiKey) return null;
  try { new URL(url); } catch { return null; }
  const timeout = Number(env.PHRASE_LIBRARY_SYNC_TIMEOUT_MS ?? 5_000);
  return { url, apiKey, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5_000 };
}

export class FilePhraseSyncQueue {
  private data: PhraseSyncFile;
  private flushing = false;

  constructor(private readonly config: PhraseSyncConfig | null, private readonly filePath = path.resolve(process.cwd(), '.data/phrases/sync-queue.json')) {
    this.data = this.readFile();
  }

  enqueue(event: PhraseSyncTask['event']): boolean {
    const duplicate = this.data.tasks.some((task) => task.event.phrase.id === event.phrase.id && task.event.phrase.version === event.phrase.version && task.event.action === event.action);
    if (duplicate) return false;
    const now = Date.now();
    this.data.tasks.push({ id: `phrase-sync-${randomUUID()}`, event: structuredClone(event), status: 'pending', attempts: 0, createdAt: now, updatedAt: now, nextAttemptAt: now });
    this.trimCompleted();
    this.writeFile();
    return true;
  }

  async flush(now = Date.now()): Promise<void> {
    if (this.flushing || !this.config) return;
    const task = this.data.tasks.find((candidate) => candidate.status !== 'succeeded' && candidate.nextAttemptAt <= now);
    if (!task) return;
    this.flushing = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(this.config.url, { method: 'POST', headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, event: task.event }), signal: controller.signal });
      if (!response.ok) throw new Error(`话术同步网关返回 ${response.status}`);
      task.status = 'succeeded'; task.updatedAt = Date.now(); task.lastError = undefined;
    } catch (error) {
      task.status = 'failed'; task.attempts += 1; task.updatedAt = Date.now(); task.nextAttemptAt = task.updatedAt + Math.min(30 * 60_000, 2_000 * (2 ** Math.min(task.attempts, 10))); task.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer); this.trimCompleted(); this.writeFile(); this.flushing = false;
    }
  }

  status(): PhraseSyncStatus {
    const succeeded = this.data.tasks.filter((task) => task.status === 'succeeded');
    const lastError = [...this.data.tasks].reverse().find((task) => task.status === 'failed' && task.lastError)?.lastError;
    return { configured: this.config !== null, pending: this.data.tasks.filter((task) => task.status === 'pending').length, failed: this.data.tasks.filter((task) => task.status === 'failed').length, succeeded: succeeded.length, lastSyncedAt: succeeded.reduce<number | null>((latest, task) => Math.max(latest ?? 0, task.updatedAt), null), ...(lastError ? { lastError } : {}) };
  }

  private trimCompleted(): void {
    this.data.tasks = [...this.data.tasks.filter((task) => task.status !== 'succeeded'), ...this.data.tasks.filter((task) => task.status === 'succeeded').slice(-500)];
  }

  private readFile(): PhraseSyncFile {
    if (!existsSync(this.filePath)) return { schemaVersion: 1, tasks: [] };
    try { const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PhraseSyncFile; if (parsed.schemaVersion === 1 && Array.isArray(parsed.tasks)) return parsed; } catch { /* local-first fallback */ }
    return { schemaVersion: 1, tasks: [] };
  }

  private writeFile(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}

export function createPhraseSyncQueue(env: NodeJS.ProcessEnv = process.env): FilePhraseSyncQueue {
  return new FilePhraseSyncQueue(configFromEnv(env), env.PHRASE_LIBRARY_SYNC_QUEUE_PATH ?? path.resolve(process.cwd(), '.data/phrases/sync-queue.json'));
}
