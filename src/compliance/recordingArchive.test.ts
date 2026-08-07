import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileRecordingArchiveQueue } from '../../server/recordingArchive';
import type { RecordingArchiveUploader, RecordingArchiveSource } from '../../server/recordingArchive';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('FileRecordingArchiveQueue', () => {
  it('does not upload while the recording is being collected and archives after enqueue', async () => {
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
    queue.enqueue('live-test');
    await queue.flush();
    expect(uploader.upload).toHaveBeenCalledOnce();
    expect(uploader.upload).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'live-test', assets: [{ assetId: 'asr', path: audioPath, byteLength: 2, sampleRate: 16_000 }] }));
  });

  it('keeps a failed archive local and retryable', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'recording-archive-'));
    directories.push(directory);
    const source: RecordingArchiveSource = { exportSession: () => ({ schemaVersion: 1, sessionId: 'live-test', timezone: 'Asia/Shanghai', createdAt: 1, recordingStartedAt: 2, audio: null, sourceAudio: [], events: [] }), getAudioPath: () => null, getSourceAudioPath: () => null };
    const uploader: RecordingArchiveUploader = { upload: vi.fn().mockRejectedValue(new Error('网络断开')), status: () => ({ configured: true, available: true, label: 'ok', detail: 'ok' }) };
    const queue = new FileRecordingArchiveQueue(source, uploader, path.join(directory, 'queue.json'));
    queue.enqueue('live-test');
    await queue.flush();
    expect(queue.status()).toMatchObject({ failed: 1, pending: 0, lastError: '网络断开' });
  });
});
