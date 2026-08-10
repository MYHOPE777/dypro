import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SessionArchiveSync, SessionTimelineExport } from '../src/shared/types';

export type RecordingArchive = {
  sessionId: string;
  timeline: SessionTimelineExport;
  assets: Array<{ assetId: string; path: string; byteLength: number; sampleRate: number }>;
  approval: { actorId: string; approvedAt: number };
};

export type ArchiveStatus = {
  configured: boolean;
  available: boolean;
  label: string;
  detail: string;
  awaitingApproval: number;
  pending: number;
  failed: number;
  succeeded: number;
  lastArchivedAt: number | null;
  lastError?: string;
};

export interface RecordingArchiveUploader {
  upload(archive: RecordingArchive, signal?: AbortSignal): Promise<void>;
  status(): Pick<ArchiveStatus, 'configured' | 'available' | 'label' | 'detail' | 'lastError'>;
}

export interface RecordingArchiveQueue {
  stage(sessionId: string): boolean;
  approve(sessionId: string, actorId: string): boolean;
  pause?(sessionId: string): void;
}

export interface RecordingArchiveSource {
  exportSession(sessionId: string): SessionTimelineExport | null;
  getAudioPath(sessionId: string): string | null;
  getSourceAudioPath(sessionId: string, trackIndex?: number): string | null;
}

type ArchiveTask = { sessionId: string; status: 'approval-required' | 'pending' | 'succeeded' | 'failed'; attempts: number; createdAt: number; updatedAt: number; nextAttemptAt: number; approvedAt?: number; approvedBy?: string; lastError?: string };
type ArchiveFile = { schemaVersion: 2; tasks: ArchiveTask[] };
type LegacyArchiveFile = { schemaVersion: 1; tasks: Array<Omit<ArchiveTask, 'status'> & { status: 'pending' | 'succeeded' | 'failed' }> };

const emptyStatus = (): ArchiveStatus => ({ configured: false, available: true, label: '场次上传待配置', detail: '音频和文案先保存在本机，人工确认后才会上传。', awaitingApproval: 0, pending: 0, failed: 0, succeeded: 0, lastArchivedAt: null });

export class DisabledRecordingArchiveUploader implements RecordingArchiveUploader {
  upload(): Promise<void> { return Promise.resolve(); }
  status() { return emptyStatus(); }
}

type HttpArchiveConfig = { url: string; apiKey: string; timeoutMs: number };

function readHttpConfig(env: NodeJS.ProcessEnv): HttpArchiveConfig | null {
  const url = env.SESSION_ARCHIVE_GATEWAY_URL?.trim() || env.TOS_ARCHIVE_GATEWAY_URL?.trim();
  const apiKey = env.SESSION_ARCHIVE_GATEWAY_KEY?.trim() || env.TOS_ARCHIVE_GATEWAY_KEY?.trim();
  if (!url || !apiKey) return null;
  try { new URL(url); } catch { return null; }
  const timeout = Number(env.TOS_ARCHIVE_TIMEOUT_MS ?? 10_000);
  return { url, apiKey, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000 };
}

/**
 * The approved-session gateway writes structured content to the business
 * database and knowledge base, then returns object-storage upload URLs.
 */
export class HttpRecordingArchiveUploader implements RecordingArchiveUploader {
  private lastError: string | undefined;
  private lastArchivedAt: number | undefined;

  constructor(private readonly config: HttpArchiveConfig) {}

  async upload(archive: RecordingArchive, signal?: AbortSignal): Promise<void> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.config.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    try {
      const manifestResponse = await fetch(this.config.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: archive.sessionId, timeline: archive.timeline, approval: archive.approval, destinations: ['database', 'knowledge-base', 'object-storage'], assets: archive.assets.map(({ assetId, byteLength, sampleRate }) => ({ assetId, byteLength, sampleRate })) }),
        signal: requestSignal,
      });
      if (!manifestResponse.ok) throw new Error(`场次上传网关返回 ${manifestResponse.status}`);
      const body = await manifestResponse.json() as { uploadUrls?: Record<string, string> };
      for (const asset of archive.assets) {
        const uploadUrl = body.uploadUrls?.[asset.assetId];
        if (!uploadUrl) throw new Error(`场次上传网关未返回 ${asset.assetId} 上传地址`);
        if (!existsSync(asset.path)) throw new Error(`归档文件不存在：${asset.assetId}`);
        const uploadController = new AbortController();
        const uploadTimer = setTimeout(() => uploadController.abort(), this.config.timeoutMs);
        const uploadSignal = signal ? AbortSignal.any([signal, uploadController.signal]) : uploadController.signal;
        try {
          const response = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.byteLength) }, body: createReadStream(asset.path) as unknown as BodyInit, signal: uploadSignal, duplex: 'half' } as RequestInit & { duplex: 'half' });
          if (!response.ok) throw new Error(`TOS 上传 ${asset.assetId} 返回 ${response.status}`);
        } finally {
          clearTimeout(uploadTimer);
        }
      }
      this.lastError = undefined;
      this.lastArchivedAt = Date.now();
    } catch (error) {
      if (!signal?.aborted) this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  status() {
    return { configured: true, available: !this.lastError, label: this.lastError ? '场次上传异常，后台将重试' : '人工确认上传已配置', detail: this.lastArchivedAt ? `最近上传 ${new Date(this.lastArchivedAt).toLocaleString('zh-CN', { hour12: false })}` : '未确认的场次只保存在本机。', ...(this.lastError ? { lastError: this.lastError } : {}) };
  }
}

export function createRecordingArchiveUploader(env: NodeJS.ProcessEnv = process.env): RecordingArchiveUploader {
  const config = readHttpConfig(env);
  return config ? new HttpRecordingArchiveUploader(config) : new DisabledRecordingArchiveUploader();
}

export class FileRecordingArchiveQueue {
  private readonly filePath: string;
  private readonly source: RecordingArchiveSource;
  private readonly uploader: RecordingArchiveUploader;
  private readonly canArchive: (sessionId: string) => boolean;
  private data: ArchiveFile;
  private flushing = false;
  private readonly activeUploads = new Map<string, AbortController>();
  private readonly pausedSessions = new Set<string>();
  private readonly changedSessions = new Set<string>();

  constructor(source: RecordingArchiveSource, uploader: RecordingArchiveUploader, filePath = path.resolve(process.cwd(), '.data/archive/queue.json'), canArchive: (sessionId: string) => boolean = () => true) {
    this.source = source;
    this.uploader = uploader;
    this.filePath = filePath;
    this.canArchive = canArchive;
    this.data = this.readFile();
  }

  stage(sessionId: string): boolean {
    if (this.activeUploads.has(sessionId)) {
      this.changedSessions.add(sessionId);
      this.pause(sessionId);
    }
    const now = Date.now();
    const existing = [...this.data.tasks].reverse().find((task) => task.sessionId === sessionId);
    if (existing) {
      existing.status = 'approval-required';
      existing.attempts = 0;
      existing.updatedAt = now;
      existing.nextAttemptAt = now;
      existing.approvedAt = undefined;
      existing.approvedBy = undefined;
      existing.lastError = undefined;
    } else {
      this.data.tasks.push({ sessionId, status: 'approval-required', attempts: 0, createdAt: now, updatedAt: now, nextAttemptAt: now });
    }
    this.writeFile();
    return true;
  }

  approve(sessionId: string, actorId: string): boolean {
    const task = [...this.data.tasks].reverse().find((candidate) => candidate.sessionId === sessionId);
    if (!task) this.stage(sessionId);
    const target = [...this.data.tasks].reverse().find((candidate) => candidate.sessionId === sessionId)!;
    if (target.status === 'pending' || this.activeUploads.has(sessionId)) return false;
    const now = Date.now();
    target.status = 'pending';
    target.attempts = 0;
    target.updatedAt = now;
    target.nextAttemptAt = now;
    target.approvedAt = now;
    target.approvedBy = actorId;
    target.lastError = undefined;
    this.writeFile();
    return true;
  }

  sessionStatus(sessionId: string): SessionArchiveSync {
    const task = [...this.data.tasks].reverse().find((candidate) => candidate.sessionId === sessionId);
    if (!task) return { state: 'local-only', updatedAt: null };
    return {
      state: task.status === 'succeeded' ? 'synced' : task.status,
      updatedAt: task.updatedAt,
      ...(task.lastError ? { lastError: task.lastError } : {}),
    };
  }

  pause(sessionId: string): void {
    const controller = this.activeUploads.get(sessionId);
    if (!controller) return;
    this.pausedSessions.add(sessionId);
    controller.abort();
  }

  async flush(now = Date.now()): Promise<void> {
    if (this.flushing || !this.uploader.status().configured) return;
    this.flushing = true;
    const task = this.data.tasks.find((candidate) => (candidate.status === 'pending' || candidate.status === 'failed') && candidate.nextAttemptAt <= now && this.canArchive(candidate.sessionId));
    if (!task) {
      this.flushing = false;
      return;
    }
    const uploadController = new AbortController();
    this.activeUploads.set(task.sessionId, uploadController);
    try {
      const timeline = this.source.exportSession(task.sessionId);
      if (!timeline) throw new Error('时间线尚未写入，稍后重试');
      if (!task.approvedAt || !task.approvedBy) throw new Error('场次尚未人工确认上传');
      const assets: RecordingArchive['assets'] = [];
      if (timeline.audio) {
        const audioPath = this.source.getAudioPath(task.sessionId);
        if (audioPath) assets.push({ assetId: timeline.audio.assetId, path: audioPath, byteLength: timeline.audio.byteLength, sampleRate: timeline.audio.sampleRate });
      }
      for (const [index, audio] of timeline.sourceAudio.entries()) {
        const audioPath = this.source.getSourceAudioPath(task.sessionId, index);
        if (audioPath) assets.push({ assetId: audio.assetId, path: audioPath, byteLength: audio.byteLength, sampleRate: audio.sampleRate });
      }
      if (!this.canArchive(task.sessionId)) return;
      await this.uploader.upload({ sessionId: task.sessionId, timeline, assets, approval: { actorId: task.approvedBy, approvedAt: task.approvedAt } }, uploadController.signal);
      if (this.changedSessions.has(task.sessionId)) {
        task.status = 'approval-required';
        task.nextAttemptAt = Date.now();
        task.updatedAt = Date.now();
        task.approvedAt = undefined;
        task.approvedBy = undefined;
        task.lastError = undefined;
      } else if (this.pausedSessions.has(task.sessionId)) {
        task.status = 'pending';
        task.nextAttemptAt = Date.now();
        task.updatedAt = Date.now();
        task.lastError = undefined;
      } else {
        task.status = 'succeeded';
        task.updatedAt = Date.now();
        task.lastError = undefined;
      }
    } catch (error) {
      if (this.changedSessions.has(task.sessionId)) {
        task.status = 'approval-required';
        task.nextAttemptAt = Date.now();
        task.updatedAt = Date.now();
        task.approvedAt = undefined;
        task.approvedBy = undefined;
        task.lastError = undefined;
      } else if (this.pausedSessions.has(task.sessionId)) {
        task.status = 'pending';
        task.nextAttemptAt = Date.now();
        task.updatedAt = Date.now();
        task.lastError = undefined;
      } else {
        task.status = 'failed';
        task.attempts += 1;
        task.updatedAt = Date.now();
        task.nextAttemptAt = task.updatedAt + Math.min(30 * 60_000, 2_000 * (2 ** Math.min(task.attempts, 10)));
        task.lastError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.activeUploads.delete(task.sessionId);
      this.pausedSessions.delete(task.sessionId);
      this.changedSessions.delete(task.sessionId);
      this.writeFile();
      this.flushing = false;
    }
  }

  status(): ArchiveStatus {
    const base = this.uploader.status();
    const awaitingApproval = this.data.tasks.filter((task) => task.status === 'approval-required').length;
    const pending = this.data.tasks.filter((task) => task.status === 'pending').length;
    const failed = this.data.tasks.filter((task) => task.status === 'failed').length;
    const succeededTasks = this.data.tasks.filter((task) => task.status === 'succeeded');
    const latestFailure = this.data.tasks.find((task) => task.status === 'failed' && task.lastError)?.lastError;
    return { ...base, awaitingApproval, pending, failed, succeeded: succeededTasks.length, lastArchivedAt: succeededTasks.reduce<number | null>((latest, task) => Math.max(latest ?? 0, task.updatedAt), null), ...(latestFailure ? { lastError: latestFailure } : {}) };
  }

  tasks(): ArchiveTask[] { return structuredClone(this.data.tasks); }

  private readFile(): ArchiveFile {
    if (!existsSync(this.filePath)) return { schemaVersion: 2, tasks: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as ArchiveFile | LegacyArchiveFile;
      if (!Array.isArray(parsed.tasks)) throw new Error('invalid archive queue');
      if (parsed.schemaVersion === 2) return parsed;
      if (parsed.schemaVersion === 1) {
        const migrated: ArchiveFile = {
          schemaVersion: 2,
          tasks: parsed.tasks.map((task) => task.status === 'succeeded'
            ? { ...task, status: 'succeeded' }
            : { ...task, status: 'approval-required', attempts: 0, nextAttemptAt: Date.now(), lastError: undefined, approvedAt: undefined, approvedBy: undefined }),
        };
        this.writeData(migrated);
        return migrated;
      }
    } catch {
      // Keep local recording usable when an old queue is incomplete.
    }
    return { schemaVersion: 2, tasks: [] };
  }

  private writeFile(): void {
    this.writeData(this.data);
  }

  private writeData(data: ArchiveFile): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}

export function createRecordingArchiveQueue(source: RecordingArchiveSource, env: NodeJS.ProcessEnv = process.env, canArchive: (sessionId: string) => boolean = () => true): FileRecordingArchiveQueue {
  return new FileRecordingArchiveQueue(source, createRecordingArchiveUploader(env), env.ARCHIVE_QUEUE_PATH ?? path.resolve(process.cwd(), '.data/archive/queue.json'), canArchive);
}
