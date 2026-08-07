import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SessionTimelineExport } from '../src/shared/types';

export type RecordingArchive = {
  sessionId: string;
  timeline: SessionTimelineExport;
  assets: Array<{ assetId: string; path: string; byteLength: number; sampleRate: number }>;
};

export type ArchiveStatus = {
  configured: boolean;
  available: boolean;
  label: string;
  detail: string;
  pending: number;
  failed: number;
  succeeded: number;
  lastArchivedAt: number | null;
  lastError?: string;
};

export interface RecordingArchiveUploader {
  upload(archive: RecordingArchive): Promise<void>;
  status(): Pick<ArchiveStatus, 'configured' | 'available' | 'label' | 'detail' | 'lastError'>;
}

export interface RecordingArchiveQueue {
  enqueue(sessionId: string): boolean;
}

export interface RecordingArchiveSource {
  exportSession(sessionId: string): SessionTimelineExport | null;
  getAudioPath(sessionId: string): string | null;
  getSourceAudioPath(sessionId: string, trackIndex?: number): string | null;
}

type ArchiveTask = { sessionId: string; status: 'pending' | 'succeeded' | 'failed'; attempts: number; createdAt: number; updatedAt: number; nextAttemptAt: number; lastError?: string };
type ArchiveFile = { schemaVersion: 1; tasks: ArchiveTask[] };

const emptyStatus = (): ArchiveStatus => ({ configured: false, available: true, label: 'TOS 归档待配置', detail: '收音期间只保留本地文件；停止收音后才会进入上传队列。', pending: 0, failed: 0, succeeded: 0, lastArchivedAt: null });

export class DisabledRecordingArchiveUploader implements RecordingArchiveUploader {
  upload(): Promise<void> { return Promise.resolve(); }
  status() { return emptyStatus(); }
}

type HttpArchiveConfig = { url: string; apiKey: string; timeoutMs: number };

function readHttpConfig(env: NodeJS.ProcessEnv): HttpArchiveConfig | null {
  const url = env.TOS_ARCHIVE_GATEWAY_URL?.trim();
  const apiKey = env.TOS_ARCHIVE_GATEWAY_KEY?.trim();
  if (!url || !apiKey) return null;
  try { new URL(url); } catch { return null; }
  const timeout = Number(env.TOS_ARCHIVE_TIMEOUT_MS ?? 10_000);
  return { url, apiKey, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000 };
}

/**
 * Upload gateway adapter. The gateway is responsible for writing to TOS and
 * should accept one JSON manifest followed by streamed PUTs to its returned
 * asset URLs. Keeping this protocol explicit avoids guessing an undocumented
 * TOS API and keeps the live process independent from TOS availability.
 */
export class HttpRecordingArchiveUploader implements RecordingArchiveUploader {
  private lastError: string | undefined;
  private lastArchivedAt: number | undefined;

  constructor(private readonly config: HttpArchiveConfig) {}

  async upload(archive: RecordingArchive): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const manifestResponse = await fetch(this.config.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: archive.sessionId, timeline: archive.timeline, assets: archive.assets.map(({ assetId, byteLength, sampleRate }) => ({ assetId, byteLength, sampleRate })) }),
        signal: controller.signal,
      });
      if (!manifestResponse.ok) throw new Error(`TOS 归档网关返回 ${manifestResponse.status}`);
      const body = await manifestResponse.json() as { uploadUrls?: Record<string, string> };
      for (const asset of archive.assets) {
        const uploadUrl = body.uploadUrls?.[asset.assetId];
        if (!uploadUrl) throw new Error(`TOS 归档网关未返回 ${asset.assetId} 上传地址`);
        if (!existsSync(asset.path)) throw new Error(`归档文件不存在：${asset.assetId}`);
        const response = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.byteLength) }, body: createReadStream(asset.path) as unknown as BodyInit, duplex: 'half' } as RequestInit & { duplex: 'half' });
        if (!response.ok) throw new Error(`TOS 上传 ${asset.assetId} 返回 ${response.status}`);
      }
      this.lastError = undefined;
      this.lastArchivedAt = Date.now();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  status() {
    return { configured: true, available: !this.lastError, label: this.lastError ? 'TOS 归档异常，保留本地副本' : 'TOS 归档已配置，停止收音后上传', detail: this.lastArchivedAt ? `最近归档 ${new Date(this.lastArchivedAt).toLocaleString('zh-CN', { hour12: false })}` : '实时收音不会占用 TOS 上传带宽。', ...(this.lastError ? { lastError: this.lastError } : {}) };
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
  private data: ArchiveFile;
  private flushing = false;

  constructor(source: RecordingArchiveSource, uploader: RecordingArchiveUploader, filePath = path.resolve(process.cwd(), '.data/archive/queue.json')) {
    this.source = source;
    this.uploader = uploader;
    this.filePath = filePath;
    this.data = this.readFile();
  }

  enqueue(sessionId: string): boolean {
    if (this.data.tasks.some((task) => task.sessionId === sessionId && task.status !== 'failed')) return false;
    const now = Date.now();
    this.data.tasks.push({ sessionId, status: 'pending', attempts: 0, createdAt: now, updatedAt: now, nextAttemptAt: now });
    this.writeFile();
    return true;
  }

  async flush(now = Date.now()): Promise<void> {
    if (this.flushing || !this.uploader.status().configured || !this.uploader.status().available) return;
    this.flushing = true;
    const task = this.data.tasks.find((candidate) => candidate.status !== 'succeeded' && candidate.nextAttemptAt <= now);
    if (!task) {
      this.flushing = false;
      return;
    }
    try {
      const timeline = this.source.exportSession(task.sessionId);
      if (!timeline) throw new Error('时间线尚未写入，稍后重试');
      const assets: RecordingArchive['assets'] = [];
      if (timeline.audio) {
        const audioPath = this.source.getAudioPath(task.sessionId);
        if (audioPath) assets.push({ assetId: timeline.audio.assetId, path: audioPath, byteLength: timeline.audio.byteLength, sampleRate: timeline.audio.sampleRate });
      }
      for (const [index, audio] of timeline.sourceAudio.entries()) {
        const audioPath = this.source.getSourceAudioPath(task.sessionId, index);
        if (audioPath) assets.push({ assetId: audio.assetId, path: audioPath, byteLength: audio.byteLength, sampleRate: audio.sampleRate });
      }
      await this.uploader.upload({ sessionId: task.sessionId, timeline, assets });
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
      this.writeFile();
      this.flushing = false;
    }
  }

  status(): ArchiveStatus {
    const base = this.uploader.status();
    const pending = this.data.tasks.filter((task) => task.status === 'pending').length;
    const failed = this.data.tasks.filter((task) => task.status === 'failed').length;
    const succeededTasks = this.data.tasks.filter((task) => task.status === 'succeeded');
    const latestFailure = this.data.tasks.find((task) => task.status === 'failed' && task.lastError)?.lastError;
    return { ...base, pending, failed, succeeded: succeededTasks.length, lastArchivedAt: succeededTasks.reduce<number | null>((latest, task) => Math.max(latest ?? 0, task.updatedAt), null), ...(latestFailure ? { lastError: latestFailure } : {}) };
  }

  tasks(): ArchiveTask[] { return structuredClone(this.data.tasks); }

  private readFile(): ArchiveFile {
    if (!existsSync(this.filePath)) return { schemaVersion: 1, tasks: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as ArchiveFile;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.tasks)) return parsed;
    } catch {
      // Keep local recording usable when an old queue is incomplete.
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

export function createRecordingArchiveQueue(source: RecordingArchiveSource, env: NodeJS.ProcessEnv = process.env): FileRecordingArchiveQueue {
  return new FileRecordingArchiveQueue(source, createRecordingArchiveUploader(env), env.ARCHIVE_QUEUE_PATH ?? path.resolve(process.cwd(), '.data/archive/queue.json'));
}
