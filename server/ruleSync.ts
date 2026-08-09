import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ComplianceRule, RuleAuditEntry } from '../src/shared/types';

export type RuleSyncConfig = { url: string; apiKey: string; timeoutMs: number };
export type RuleMutationEvent = {
  action: RuleAuditEntry['action'];
  rule: ComplianceRule;
  occurredAt: number;
};

type RuleSyncTask = {
  id: string;
  event: RuleMutationEvent;
  status: 'pending' | 'failed' | 'succeeded';
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  lastError?: string;
};

type RuleSyncFile = { schemaVersion: 1; tasks: RuleSyncTask[] };

export type RuleSyncStatus = {
  configured: boolean;
  pending: number;
  failed: number;
  succeeded: number;
  lastSyncedAt: number | null;
  lastError?: string;
};

function readConfig(env: NodeJS.ProcessEnv): RuleSyncConfig | null {
  const url = env.RULE_SYNC_URL?.trim();
  const apiKey = env.RULE_SYNC_KEY?.trim();
  if (!url || !apiKey) return null;
  try { new URL(url); } catch { return null; }
  const timeout = Number(env.RULE_SYNC_TIMEOUT_MS ?? 5_000);
  return { url, apiKey, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5_000 };
}

export class FileRuleSyncQueue {
  private data: RuleSyncFile;
  private flushing = false;

  constructor(
    private readonly config: RuleSyncConfig | null,
    private readonly filePath = path.resolve(process.cwd(), '.data/rules/sync-queue.json'),
  ) {
    this.data = this.readFile();
  }

  enqueue(event: RuleMutationEvent): boolean {
    const duplicate = this.data.tasks.some((task) => task.event.rule.id === event.rule.id
      && task.event.rule.version === event.rule.version
      && task.event.action === event.action
      && task.event.occurredAt === event.occurredAt);
    if (duplicate) return false;
    const now = Date.now();
    this.data.tasks.push({
      id: `rule-sync-${randomUUID()}`,
      event: structuredClone(event),
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    });
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
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, event: task.event }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`规则同步网关返回 ${response.status}`);
      task.status = 'succeeded';
      task.updatedAt = Date.now();
      task.lastError = undefined;
    } catch (error) {
      task.status = 'failed';
      task.attempts += 1;
      task.updatedAt = Date.now();
      task.nextAttemptAt = task.updatedAt + Math.min(30 * 60_000, 2_000 * (2 ** Math.min(task.attempts, 10)));
      task.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
      this.trimCompleted();
      this.writeFile();
      this.flushing = false;
    }
  }

  status(): RuleSyncStatus {
    const succeeded = this.data.tasks.filter((task) => task.status === 'succeeded');
    const latestFailure = [...this.data.tasks].reverse().find((task) => task.status === 'failed' && task.lastError)?.lastError;
    return {
      configured: this.config !== null,
      pending: this.data.tasks.filter((task) => task.status === 'pending').length,
      failed: this.data.tasks.filter((task) => task.status === 'failed').length,
      succeeded: succeeded.length,
      lastSyncedAt: succeeded.reduce<number | null>((latest, task) => Math.max(latest ?? 0, task.updatedAt), null),
      ...(latestFailure ? { lastError: latestFailure } : {}),
    };
  }

  private trimCompleted(): void {
    const pending = this.data.tasks.filter((task) => task.status !== 'succeeded');
    const completed = this.data.tasks.filter((task) => task.status === 'succeeded').slice(-500);
    this.data.tasks = [...pending, ...completed];
  }

  private readFile(): RuleSyncFile {
    if (!existsSync(this.filePath)) return { schemaVersion: 1, tasks: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as RuleSyncFile;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.tasks)) return parsed;
    } catch {
      // Preserve live operation when the local queue cannot be read.
    }
    return { schemaVersion: 1, tasks: [] };
  }

  private writeFile(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}

export function createRuleSyncQueue(env: NodeJS.ProcessEnv = process.env): FileRuleSyncQueue {
  return new FileRuleSyncQueue(
    readConfig(env),
    env.RULE_SYNC_QUEUE_PATH ?? path.resolve(process.cwd(), '.data/rules/sync-queue.json'),
  );
}
