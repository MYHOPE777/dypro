import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ComplianceRule, LiveRoom } from '../src/shared/types';
import type { KnowledgeBaseIndexer, KnowledgeBaseStatus, KnowledgeRuleDocument } from './knowledgeBase';

type SyncTask = {
  id: string;
  key: string;
  document: KnowledgeRuleDocument;
  status: 'pending' | 'succeeded' | 'failed';
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  lastError?: string;
};

type SyncFile = { schemaVersion: 1; tasks: SyncTask[] };

export type KnowledgeSyncStatus = KnowledgeBaseStatus & {
  pending: number;
  failed: number;
  succeeded: number;
  lastSyncedAt: number | null;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function defaultFile(): SyncFile {
  return { schemaVersion: 1, tasks: [] };
}

export class FileKnowledgeSyncQueue {
  private readonly filePath: string;
  private readonly indexer: KnowledgeBaseIndexer;
  private data: SyncFile;
  private flushing = false;

  constructor(indexer: KnowledgeBaseIndexer, filePath = path.resolve(process.cwd(), '.data/knowledge/sync.json')) {
    this.indexer = indexer;
    this.filePath = filePath;
    this.data = this.readFile();
  }

  enqueue(rule: ComplianceRule, room?: Pick<LiveRoom, 'id' | 'name' | 'accountName'>, requestedOperation?: 'upsert' | 'remove'): boolean {
    const operation = requestedOperation ?? (rule.enabled ? 'upsert' : 'remove');
    if (operation === 'upsert' && rule.status !== 'published') return false;
    const key = `${rule.id}:v${rule.version}:t${rule.updatedAt}:${operation}`;
    if (this.data.tasks.some((task) => task.key === key)) return false;
    const document: KnowledgeRuleDocument = { rule: clone(rule), room: room ? clone(room) : undefined, operation };
    const now = Date.now();
    this.data.tasks.push({ id: `knowledge-sync-${randomUUID()}`, key, document, status: 'pending', attempts: 0, createdAt: now, updatedAt: now, nextAttemptAt: now });
    this.writeFile();
    return true;
  }

  async flush(now = Date.now()): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      if (!this.indexer.indexStatus().configured) return;
      const due = this.data.tasks.filter((task) => task.status !== 'succeeded' && task.nextAttemptAt <= now).slice(0, 10);
      for (const task of due) {
        try {
          await this.indexer.index(task.document);
          task.status = 'succeeded';
          task.updatedAt = Date.now();
          task.lastError = undefined;
        } catch (error) {
          task.status = 'failed';
          task.attempts += 1;
          task.updatedAt = Date.now();
          task.nextAttemptAt = task.updatedAt + Math.min(15 * 60_000, 1_000 * (2 ** Math.min(task.attempts, 10)));
          task.lastError = error instanceof Error ? error.message : String(error);
        }
        this.writeFile();
      }
    } finally {
      this.flushing = false;
    }
  }

  status(): KnowledgeSyncStatus {
    const base = this.indexer.indexStatus();
    const pending = this.data.tasks.filter((task) => task.status === 'pending').length;
    const failed = this.data.tasks.filter((task) => task.status === 'failed').length;
    const succeededTasks = this.data.tasks.filter((task) => task.status === 'succeeded');
    const lastSyncedAt = succeededTasks.reduce<number | null>((latest, task) => Math.max(latest ?? 0, task.updatedAt), null);
    const latestFailure = this.data.tasks.find((task) => task.status === 'failed' && task.lastError)?.lastError;
    return {
      ...base,
      label: !base.configured ? '规则同步待配置' : failed > 0 ? '规则同步有失败任务' : pending > 0 ? '规则同步排队中' : '规则同步已完成',
      detail: latestFailure ? `最近失败：${latestFailure}` : base.detail,
      pending,
      failed,
      succeeded: succeededTasks.length,
      lastSyncedAt,
    };
  }

  tasks(): SyncTask[] {
    return clone(this.data.tasks);
  }

  private readFile(): SyncFile {
    if (!existsSync(this.filePath)) return defaultFile();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as SyncFile;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.tasks)) return parsed;
    } catch {
      // A corrupt queue must not stop local rule evaluation.
    }
    return defaultFile();
  }

  private writeFile(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}
