import type { PresenterModule } from './presenters';
import { AudioFileWriter } from './audio';
import type { LiveSession } from './liveSession';
import type { SqliteFactStore } from './store';

export type SessionAudioWriters = {
  source: AudioFileWriter;
  asr: AudioFileWriter;
};

export type SessionResourceBundle = {
  session: LiveSession;
  writers: SessionAudioWriters;
};

/** Owns the in-process live sessions and their capture resources as one unit. */
export class SessionRegistry {
  private readonly resources = new Map<string, SessionResourceBundle>();

  register(sessionId: string, bundle: SessionResourceBundle): void {
    this.resources.set(sessionId, bundle);
  }

  get(sessionId: string): SessionResourceBundle | undefined {
    return this.resources.get(sessionId);
  }

  getSession(sessionId: string): LiveSession | undefined {
    return this.get(sessionId)?.session;
  }

  has(sessionId: string): boolean {
    return this.resources.has(sessionId);
  }

  remove(sessionId: string): SessionResourceBundle | undefined {
    const bundle = this.resources.get(sessionId);
    this.resources.delete(sessionId);
    return bundle;
  }

  list(): LiveSession[] {
    return this.values();
  }

  values(): LiveSession[] {
    return [...this.resources.values()].map(({ session }) => session);
  }

  entries(): Array<[string, SessionResourceBundle]> {
    return [...this.resources.entries()];
  }

  async closeAll(close: (session: LiveSession) => Promise<void>): Promise<void> {
    await Promise.all(this.values().map(close));
  }
}

/** Archives a session and finalizes its audio exactly once. */
export class SessionResourceOwner {
  private readonly finalizations = new Map<string, Promise<void>>();

  constructor(private readonly store: SqliteFactStore, private readonly presenters: PresenterModule) {}

  handleEnded(sessionId: string, bundle: SessionResourceBundle): void {
    const snapshot = bundle.session.snapshot();
    try {
      this.presenters.archiveSession(snapshot.presenterId, sessionId, snapshot.product.id, snapshot.transcriptHistory);
    } catch (error) {
      console.error('[session-archive]', JSON.stringify({ sessionId, presenterId: snapshot.presenterId, error: error instanceof Error ? error.message : String(error) }));
    }
    void this.finalize(sessionId, bundle.writers).catch((error) => {
      console.error('[audio-finalize]', JSON.stringify({ sessionId, error: error instanceof Error ? error.message : String(error) }));
    });
  }

  finalize(sessionId: string, writers: SessionAudioWriters): Promise<void> {
    const current = this.finalizations.get(sessionId);
    if (current) return current;
    const task = Promise.all([writers.source.finalize().catch(() => null), writers.asr.finalize().catch(() => null)]).then(([source, asr]) => {
      if (source && source.byteLength > 0) this.store.registerAudioAsset({ id: `audio-source-${sessionId}`, sessionId, path: source.path, encoding: 'pcm_s16le_source', byteLength: source.byteLength, durationMs: source.durationMs, sampleRate: source.sampleRate, channels: source.channels });
      if (asr && asr.byteLength > 0) this.store.registerAudioAsset({ id: `audio-asr-${sessionId}`, sessionId, path: asr.path, encoding: 'pcm_s16le_asr', byteLength: asr.byteLength, durationMs: asr.durationMs, sampleRate: asr.sampleRate, channels: asr.channels });
    });
    this.finalizations.set(sessionId, task);
    return task;
  }

  async finalizeAll(entries: Array<[string, SessionResourceBundle]>): Promise<void> {
    await Promise.all(entries.map(([sessionId, bundle]) => this.finalize(sessionId, bundle.writers).catch(() => undefined)));
  }
}

export class ShutdownCoordinator {
  constructor(private readonly registry: SessionRegistry, private readonly owner: SessionResourceOwner, private readonly productProfileTasks: Set<Promise<void>>) {}

  async stop(): Promise<void> {
    await this.registry.closeAll(async (session) => {
      if (session.snapshot().lifecycle !== 'ended') await session.dispatch({ type: 'stop' });
    });
    await this.owner.finalizeAll(this.registry.entries());
    await Promise.all([...this.productProfileTasks]);
  }
}
