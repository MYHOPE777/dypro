import { mkdir, appendFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function wavHeader(byteLength: number, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = channels * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(byteLength, 40);
  return header;
}

export class AudioFileWriter {
  readonly path: string;
  private queue = Promise.resolve();
  private byteLength = 0;
  private sampleRate = 16_000;
  private channels = 1;

  constructor(root: string, tenantId: string, roomId: string, sessionId: string, filename = 'capture.pcm') {
    this.path = join(root, tenantId, roomId, sessionId, filename);
  }

  append(pcm: Uint8Array, sampleRate: number, channels: number): void {
    if (pcm.byteLength === 0) return;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.byteLength += pcm.byteLength;
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, pcm);
    });
  }

  async finalize(): Promise<{ path: string; byteLength: number; durationMs: number; sampleRate: number; channels: number }> {
    await this.queue;
    const metadata = await stat(this.path).catch(() => ({ size: this.byteLength }));
    const bytes = metadata.size;
    return { path: this.path, byteLength: bytes, durationMs: Math.round(bytes / Math.max(1, this.sampleRate * this.channels * 2) * 1_000), sampleRate: this.sampleRate, channels: this.channels };
  }
}
