import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileRecordingArchiveQueue, HttpRecordingArchiveUploader } from '../../server/recordingArchive';
import type { RecordingArchive, RecordingArchiveUploader, RecordingArchiveSource } from '../../server/recordingArchive';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('FileRecordingArchiveQueue', () => {
  it('keeps a staged recording local until an operator approves the upload', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'recording-archive-'));
    directories.push(directory);
    const audioPath = path.join(directory, 'audio.pcm');
    writeFileSync(audioPath, Buffer.from([0, 1]));
    const source: RecordingArchiveSource = {
      exportSession: () => ({ schemaVersion: 1, sessionId: 'live-test', timezone: 'Asia/Shanghai', createdAt: 1, recordingStartedAt: 2, audio: { assetId: 'asr', encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1, bitsPerSample: 16, byteLength: 2, sampleCount: 1, durationMs: 1, pcmUrl: '', wavUrl: '' }, sourceAudio: [], events: [] }),
      getAudioPath: () => audioPath,
      getSourceAudioPath: () => null,
    };
    const uploader: RecordingArchiveUploader = { upload: vi.fn().mockResolvedValue(undefined), status: () => ({ configured: true, available: true, label: 'ok', detail: 'ok' }) };
    const queue = new FileRecordingArchiveQueue(source, uploader, path.join(directory, 'queue.json'));

    expect(uploader.upload).not.toHaveBeenCalled();
    queue.stage('live-test');
    await queue.flush();
    expect(uploader.upload).not.toHaveBeenCalled();
    expect(queue.sessionStatus('live-test')).toMatchObject({ state: 'approval-required' });
    queue.approve('live-test', 'operator-1');
    await queue.flush();
    expect(uploader.upload).toHaveBeenCalledOnce();
    expect(uploader.upload).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'live-test', assets: [{ assetId: 'asr', path: audioPath, byteLength: 2, sampleRate: 16_000 }], approval: expect.objectContaining({ actorId: 'operator-1' }) }), expect.any(AbortSignal));
  });

  it('keeps a failed archive local and retryable', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'recording-archive-'));
    directories.push(directory);
    const source: RecordingArchiveSource = { exportSession: () => ({ schemaVersion: 1, sessionId: 'live-test', timezone: 'Asia/Shanghai', createdAt: 1, recordingStartedAt: 2, audio: null, sourceAudio: [], events: [] }), getAudioPath: () => null, getSourceAudioPath: () => null };
    const uploader: RecordingArchiveUploader = { upload: vi.fn().mockRejectedValue(new Error('网络断开')), status: () => ({ configured: true, available: true, label: 'ok', detail: 'ok' }) };
    const queue = new FileRecordingArchiveQueue(source, uploader, path.join(directory, 'queue.json'));
    queue.stage('live-test');
    queue.approve('live-test', 'operator-1');
    await queue.flush();
    expect(queue.status()).toMatchObject({ failed: 1, pending: 0, lastError: '网络断开' });
  });

  it('waits while realtime capture has resumed', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'recording-archive-'));
    directories.push(directory);
    let isListening = true;
    const source: RecordingArchiveSource = { exportSession: () => ({ schemaVersion: 1, sessionId: 'live-test', timezone: 'Asia/Shanghai', createdAt: 1, recordingStartedAt: 2, audio: null, sourceAudio: [], events: [] }), getAudioPath: () => null, getSourceAudioPath: () => null };
    const uploader: RecordingArchiveUploader = { upload: vi.fn().mockResolvedValue(undefined), status: () => ({ configured: true, available: true, label: 'ok', detail: 'ok' }) };
    const queue = new FileRecordingArchiveQueue(source, uploader, path.join(directory, 'queue.json'), () => !isListening);
    queue.stage('live-test');
    queue.approve('live-test', 'operator-1');

    await queue.flush();
    expect(uploader.upload).not.toHaveBeenCalled();
    isListening = false;
    await queue.flush();
    expect(uploader.upload).toHaveBeenCalledOnce();
  });

  it('archives the same session again after capture resumes and stops a second time', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'recording-archive-'));
    directories.push(directory);
    const source: RecordingArchiveSource = { exportSession: () => ({ schemaVersion: 1, sessionId: 'live-test', timezone: 'Asia/Shanghai', createdAt: 1, recordingStartedAt: 2, audio: null, sourceAudio: [], events: [] }), getAudioPath: () => null, getSourceAudioPath: () => null };
    const uploader: RecordingArchiveUploader = { upload: vi.fn().mockResolvedValue(undefined), status: () => ({ configured: true, available: true, label: 'ok', detail: 'ok' }) };
    const queue = new FileRecordingArchiveQueue(source, uploader, path.join(directory, 'queue.json'));

    expect(queue.stage('live-test')).toBe(true);
    expect(queue.approve('live-test', 'operator-1')).toBe(true);
    await queue.flush();
    expect(queue.stage('live-test')).toBe(true);
    await queue.flush();
    expect(uploader.upload).toHaveBeenCalledOnce();
    expect(queue.approve('live-test', 'operator-1')).toBe(true);
    await queue.flush();
    expect(uploader.upload).toHaveBeenCalledTimes(2);
  });

  it('requires a new approval after an archived session note or transcript changes', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'recording-archive-resync-'));
    directories.push(directory);
    const source: RecordingArchiveSource = { exportSession: () => ({ schemaVersion: 1, sessionId: 'live-test', timezone: 'Asia/Shanghai', createdAt: 1, recordingStartedAt: 2, audio: null, sourceAudio: [], events: [] }), getAudioPath: () => null, getSourceAudioPath: () => null };
    const uploader: RecordingArchiveUploader = { upload: vi.fn().mockResolvedValue(undefined), status: () => ({ configured: true, available: true, label: 'ok', detail: 'ok' }) };
    const queue = new FileRecordingArchiveQueue(source, uploader, path.join(directory, 'queue.json'));

    queue.stage('live-test');
    queue.approve('live-test', 'operator-1');
    await queue.flush();
    expect(queue.sessionStatus('live-test')).toMatchObject({ state: 'synced' });

    expect(queue.stage('live-test')).toBe(true);
    expect(queue.sessionStatus('live-test')).toMatchObject({ state: 'approval-required' });
    await queue.flush();
    expect(uploader.upload).toHaveBeenCalledOnce();
    queue.approve('live-test', 'operator-1');
    await queue.flush();

    expect(uploader.upload).toHaveBeenCalledTimes(2);
    expect(queue.sessionStatus('live-test')).toMatchObject({ state: 'synced' });
  });

  it('cancels an in-flight upload and requires approval for changed local content', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'recording-archive-resync-active-'));
    directories.push(directory);
    let revision = 1;
    const source: RecordingArchiveSource = { exportSession: () => ({ schemaVersion: 1, sessionId: 'live-test', timezone: 'Asia/Shanghai', createdAt: revision, recordingStartedAt: 2, audio: null, sourceAudio: [], events: [] }), getAudioPath: () => null, getSourceAudioPath: () => null };
    const upload = vi.fn<RecordingArchiveUploader['upload']>()
      .mockImplementationOnce((_archive, signal) => new Promise<void>((resolve) => { signal?.addEventListener('abort', () => resolve(), { once: true }); }))
      .mockResolvedValueOnce(undefined);
    const uploader: RecordingArchiveUploader = { upload, status: () => ({ configured: true, available: true, label: 'ok', detail: 'ok' }) };
    const queue = new FileRecordingArchiveQueue(source, uploader, path.join(directory, 'queue.json'));

    queue.stage('live-test');
    queue.approve('live-test', 'operator-1');
    const flushing = queue.flush();
    revision = 2;
    queue.stage('live-test');
    await flushing;

    expect(queue.sessionStatus('live-test')).toMatchObject({ state: 'approval-required' });
    await queue.flush();
    expect(upload).toHaveBeenCalledOnce();
    queue.approve('live-test', 'operator-1');
    await queue.flush();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0]?.[0].timeline.createdAt).toBe(1);
    expect(upload.mock.calls[1]?.[0].timeline.createdAt).toBe(2);
    expect(queue.sessionStatus('live-test')).toMatchObject({ state: 'synced' });
  });

  it('pauses an in-flight upload when capture resumes', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'recording-archive-pause-'));
    directories.push(directory);
    const source: RecordingArchiveSource = { exportSession: () => ({ schemaVersion: 1, sessionId: 'live-test', timezone: 'Asia/Shanghai', createdAt: 1, recordingStartedAt: 2, audio: null, sourceAudio: [], events: [] }), getAudioPath: () => null, getSourceAudioPath: () => null };
    let resolveUpload: (() => void) | undefined;
    const uploader: RecordingArchiveUploader = { upload: vi.fn((_archive, signal) => new Promise<void>((resolve) => { resolveUpload = resolve; signal?.addEventListener('abort', () => resolve()); })), status: () => ({ configured: true, available: true, label: 'ok', detail: 'ok' }) };
    const queue = new FileRecordingArchiveQueue(source, uploader, path.join(directory, 'queue.json'));

    expect(queue.stage('live-test')).toBe(true);
    expect(queue.approve('live-test', 'operator-1')).toBe(true);
    const flushing = queue.flush();
    queue.pause('live-test');
    resolveUpload?.();
    await flushing;

    expect(uploader.upload).toHaveBeenCalledOnce();
    expect(queue.tasks()[0]).toMatchObject({ sessionId: 'live-test', status: 'pending', attempts: 0 });
  });

  it('migrates unfinished automatic uploads to manual approval after restart', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'recording-archive-migration-'));
    directories.push(directory);
    const queuePath = path.join(directory, 'queue.json');
    writeFileSync(queuePath, JSON.stringify({ schemaVersion: 1, tasks: [{ sessionId: 'live-test', status: 'pending', attempts: 0, createdAt: 1, updatedAt: 1, nextAttemptAt: 1 }] }));
    const source: RecordingArchiveSource = { exportSession: () => ({ schemaVersion: 1, sessionId: 'live-test', timezone: 'Asia/Shanghai', createdAt: 1, recordingStartedAt: 2, audio: null, sourceAudio: [], events: [] }), getAudioPath: () => null, getSourceAudioPath: () => null };
    const uploader: RecordingArchiveUploader = { upload: vi.fn().mockResolvedValue(undefined), status: () => ({ configured: true, available: true, label: 'ok', detail: 'ok' }) };
    const queue = new FileRecordingArchiveQueue(source, uploader, queuePath);

    await queue.flush();

    expect(uploader.upload).not.toHaveBeenCalled();
    expect(queue.sessionStatus('live-test')).toMatchObject({ state: 'approval-required' });
    expect(JSON.parse(readFileSync(queuePath, 'utf8'))).toMatchObject({ schemaVersion: 2, tasks: [{ sessionId: 'live-test', status: 'approval-required' }] });
  });
});

describe('HttpRecordingArchiveUploader', () => {
  it('does not report an intentional cancellation as a gateway failure', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const uploader = new HttpRecordingArchiveUploader({ url: 'https://archive.example/manifest', apiKey: 'secret', timeoutMs: 500 });
    const archive: RecordingArchive = { sessionId: 'live-test', timeline: { schemaVersion: 1, sessionId: 'live-test', timezone: 'Asia/Shanghai', createdAt: 1, recordingStartedAt: 2, audio: null, sourceAudio: [], events: [] }, assets: [], approval: { actorId: 'operator-1', approvedAt: 3 } };
    const controller = new AbortController();

    const uploading = uploader.upload(archive, controller.signal);
    controller.abort();

    await expect(uploading).rejects.toMatchObject({ name: 'AbortError' });
    expect(uploader.status()).toMatchObject({ configured: true, available: true });
    expect(uploader.status().lastError).toBeUndefined();
  });

  it('keeps a failed uploader retryable instead of permanently disabling the queue', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('网络断开')).mockResolvedValueOnce(new Response(JSON.stringify({ uploadUrls: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const uploader = new HttpRecordingArchiveUploader({ url: 'https://archive.example/manifest', apiKey: 'secret', timeoutMs: 500 });
    const archive: RecordingArchive = { sessionId: 'live-test', timeline: { schemaVersion: 1, sessionId: 'live-test', timezone: 'Asia/Shanghai', createdAt: 1, recordingStartedAt: 2, audio: null, sourceAudio: [], events: [] }, assets: [], approval: { actorId: 'operator-1', approvedAt: 3 } };

    await expect(uploader.upload(archive)).rejects.toThrow('网络断开');
    expect(uploader.status()).toMatchObject({ configured: true, available: false, lastError: '网络断开' });
    await expect(uploader.upload(archive)).resolves.toBeUndefined();
    expect(uploader.status().lastError).toBeUndefined();
  });
});
