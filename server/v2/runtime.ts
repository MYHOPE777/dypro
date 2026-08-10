import { resolve } from 'node:path';
import { PRODUCTS } from '../../src/shared/products';
import type { LiveCommand, LiveEvent, LiveSessionSnapshot, SessionReview, SessionSummary } from '../../src/shared/v2';
import type { Product } from '../../src/shared/types';
import { createDoubaoAnalyzer } from '../services';
import { createDoubaoCoach } from '../providers/doubaoCoach';
import { buildStreamingAsrContext } from '../providers/doubaoStreamingAsr';
import { CaptureModule } from './capture';
import { AudioFileWriter } from './audio';
import { BoundedScheduler } from './scheduler';
import { LiveSession } from './liveSession';
import { SessionReviewModule } from './sessionReview';
import { SqliteFactStore } from './store';
import { DurableDelivery, deliveryGatewaysFromEnv } from './delivery';
import { AuthorizationModule } from './authorization';
import { RuleModule } from './rules';
import { PresenterModule } from './presenters';

export type LiveSessionPort = Pick<LiveSession, 'dispatch' | 'snapshot' | 'subscribe'> & { readonly id: string };

export type V2Runtime = {
  readonly store: SqliteFactStore;
  readonly scheduler: BoundedScheduler;
  readonly review: SessionReviewModule;
  readonly delivery: DurableDelivery;
  readonly authorization: AuthorizationModule;
  readonly rules: RuleModule;
  readonly presenters: PresenterModule;
  getOrCreateSession(input?: { sessionId?: string; roomId?: string; presenterId?: string; presenterName?: string }): LiveSessionPort;
  getSession(sessionId: string): LiveSessionPort | null;
  dispatch(sessionId: string, command: LiveCommand): Promise<void>;
  snapshot(sessionId: string): LiveSessionSnapshot | null;
  subscribe(sessionId: string, listener: (event: LiveEvent, snapshot: LiveSessionSnapshot) => void): () => void;
  listRooms(): ReturnType<SqliteFactStore['listRooms']>;
  listProducts(roomId: string): Product[];
  upsertProduct(roomId: string, product: Product): Promise<Product>;
  removeProduct(roomId: string, productId: string): Promise<Product[]>;
  listSessions(roomId?: string): SessionSummary[];
  getReview(sessionId: string): SessionReview | null;
  createDisplayLink(sessionId: string): { alias: string; sessionId: string; expiresAt: number };
  resolveDisplayLink(alias: string): string | null;
  close(): Promise<void>;
};

function validSessionId(value: string | undefined): string | undefined {
  return value && /^[a-zA-Z0-9_-]{4,96}$/u.test(value) ? value : undefined;
}

export function createRuntime(options: { env?: NodeJS.ProcessEnv; rootDir?: string } = {}): V2Runtime {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? resolve(process.cwd());
  const dbPath = env.V2_DB_PATH?.trim() || resolve(rootDir, '.data-v2/app.sqlite');
  const audioRoot = env.V2_AUDIO_DIR?.trim() || resolve(rootDir, '.data-v2/audio');
  const store = new SqliteFactStore({ filename: dbPath, audioRoot });
  const scheduler = new BoundedScheduler({ modelGlobal: 4, modelPerSession: 2, background: 1 });
  const review = new SessionReviewModule(store);
  const delivery = new DurableDelivery(store, scheduler, deliveryGatewaysFromEnv(env));
  const authorization = new AuthorizationModule(env);
  const rules = new RuleModule(store);
  const presenters = new PresenterModule(store);
  const deliveryTimer = setInterval(() => { void delivery.flushOnce(); }, 5_000);
  deliveryTimer.unref();
  const sessions = new Map<string, LiveSession>();
  const writers = new Map<string, { source: AudioFileWriter; asr: AudioFileWriter }>();
  const seedProducts = PRODUCTS.map((product) => ({ ...product, updatedAt: product.updatedAt || Date.now() }));
  const roomId = 'room-default';
  store.ensureRoom({ id: roomId, tenantId: 'tenant-local', name: '默认直播间', accountName: '本地账号', ownerActorId: 'owner' });
  if (store.listProducts('tenant-local', roomId).length === 0) seedProducts.forEach((product) => store.upsertProduct('tenant-local', product, roomId));
  presenters.ensureDefault(roomId);

  const ensureRoomCatalog = (targetRoom: string, tenantId: string): Product[] => {
    const existing = store.listProducts(tenantId, targetRoom);
    if (existing.length > 0) return existing;
    seedProducts.forEach((product) => store.upsertProduct(tenantId, product, targetRoom));
    return store.listProducts(tenantId, targetRoom);
  };

  const syncBackgroundScheduling = (): void => {
    const captureCritical = [...sessions.values()].some((candidate) => {
      const lifecycle = candidate.snapshot().lifecycle;
      return lifecycle === 'live' || lifecycle === 'ending';
    });
    if (captureCritical) scheduler.pauseBackground(); else scheduler.resumeBackground();
  };

  const getOrCreateSession = (input: { sessionId?: string; roomId?: string; presenterId?: string; presenterName?: string } = {}): LiveSession => {
    const requestedId = validSessionId(input.sessionId);
    if (requestedId && sessions.has(requestedId)) return sessions.get(requestedId)!;
    const persisted = requestedId ? store.getSessionSnapshot(requestedId) : null;
    const targetRoom = persisted?.roomId ?? (input.roomId && /^[a-zA-Z0-9_-]{2,96}$/u.test(input.roomId) ? input.roomId : roomId);
    const tenantId = persisted?.tenantId ?? 'tenant-local';
    store.ensureRoom({ id: targetRoom, tenantId, name: targetRoom === roomId ? '默认直播间' : targetRoom, accountName: '本地账号', ownerActorId: 'owner' });
    const roomProducts = ensureRoomCatalog(targetRoom, tenantId);
    const sessionId = requestedId ?? `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const defaultPresenter = presenters.ensureDefault(targetRoom);
    const requestedPresenter = presenters.get(persisted?.presenterId ?? input.presenterId ?? '');
    const presenter = requestedPresenter?.roomId === targetRoom ? requestedPresenter : defaultPresenter;
    const presenterId = presenter.id;
    const presenterName = persisted?.presenterName ?? (input.presenterName?.trim() || presenter.name);
    const writer = {
      source: new AudioFileWriter(audioRoot, tenantId, targetRoom, sessionId, 'source.pcm'),
      asr: new AudioFileWriter(audioRoot, tenantId, targetRoom, sessionId, 'asr-16k.pcm'),
    };
    let liveSession!: LiveSession;
    const capture = new CaptureModule({
      onPartial: (result) => liveSession.receiveAsr({ ...result, text: store.applySpeechCorrections(targetRoom, result.text).text }),
      onFinal: (result) => liveSession.receiveAsr({ ...result, text: store.applySpeechCorrections(targetRoom, result.text).text }),
      onError: (error) => liveSession.captureFailure(error),
      onAudio: (pcm, sampleRate, channels, track) => writer[track].append(pcm, sampleRate, channels),
      asrContext: () => {
        const active = liveSession.snapshot().product;
        return buildStreamingAsrContext(store.speechCorrectionHotwords(targetRoom), [active.name, active.category, ...active.sellingPoints]);
      },
    });
    liveSession = new LiveSession({
      store, scheduler, products: () => store.listProducts(tenantId, targetRoom), capture,
      analyzer: createDoubaoAnalyzer(env),
      coach: createDoubaoCoach(env),
      rules: () => rules.active(targetRoom),
      referencePhrases: (activePresenterId, productId) => presenters.references(activePresenterId, productId).slice(0, 10).map((phrase) => ({ text: phrase.text, purpose: phrase.purpose })),
      resolvePresenter: (activePresenterId) => {
        const candidate = presenters.get(activePresenterId);
        return candidate?.roomId === targetRoom ? { id: candidate.id, name: candidate.name } : null;
      },
      onComplianceResult: (result) => { rules.learn(targetRoom, sessionId, result); },
      onReviewTiming: (timing) => console.info('[realtime-review]', JSON.stringify(timing)),
      session: { sessionId, tenantId, roomId: targetRoom, presenterId, presenterName, product: persisted?.product ?? roomProducts[0], lineup: persisted?.lineup?.length ? persisted.lineup : roomProducts },
    });
    writers.set(sessionId, writer);
    liveSession.subscribe((event) => {
      if (event.type === 'lifecycle.changed' || event.type === 'capture.error') syncBackgroundScheduling();
      if (event.type === 'session.ended') {
        const snapshot = liveSession.snapshot();
        presenters.archiveSession(snapshot.presenterId, sessionId, snapshot.product.id, snapshot.transcriptHistory);
        void Promise.all([writer.source.finalize(), writer.asr.finalize()]).then(([source, asr]) => {
          if (source.byteLength > 0) store.registerAudioAsset({ id: `audio-source-${sessionId}`, sessionId, path: source.path, encoding: 'pcm_s16le_source', byteLength: source.byteLength, durationMs: source.durationMs, sampleRate: source.sampleRate, channels: source.channels });
          if (asr.byteLength > 0) store.registerAudioAsset({ id: `audio-asr-${sessionId}`, sessionId, path: asr.path, encoding: 'pcm_s16le_asr', byteLength: asr.byteLength, durationMs: asr.durationMs, sampleRate: asr.sampleRate, channels: asr.channels });
        }).catch(() => undefined);
      }
    });
    sessions.set(sessionId, liveSession);
    return liveSession;
  };

  const syncRoomCatalog = async (targetRoom: string): Promise<Product[]> => {
    const room = store.listRooms().find((candidate) => candidate.id === targetRoom);
    if (!room) throw new Error('直播间不存在');
    const catalog = store.listProducts(room.tenantId ?? 'tenant-local', targetRoom);
    await Promise.all([...sessions.values()].filter((session) => {
      const snapshot = session.snapshot();
      return snapshot.roomId === targetRoom && snapshot.lifecycle !== 'ended';
    }).map((session) => {
      const snapshot = session.snapshot();
      const catalogIds = new Set(catalog.map((product) => product.id));
      const retainedIds = snapshot.lineup.map((product) => product.id).filter((productId) => catalogIds.has(productId));
      return session.dispatch({ type: 'catalog_sync', products: catalog }).then(() => session.dispatch({ type: 'set_lineup', productIds: retainedIds.length > 0 ? retainedIds : catalog.map((product) => product.id) }));
    }));
    return catalog;
  };

  return {
    store, scheduler, review, delivery, authorization, rules, presenters,
    getOrCreateSession,
    getSession: (sessionId) => sessions.get(sessionId) ?? (store.getSessionSnapshot(sessionId) ? getOrCreateSession({ sessionId }) : null),
    dispatch: async (sessionId, command) => { const session = getOrCreateSession({ sessionId }); await session.dispatch(command); },
    snapshot: (sessionId) => sessions.get(sessionId)?.snapshot() ?? store.getSessionSnapshot(sessionId),
    subscribe: (sessionId, listener) => getOrCreateSession({ sessionId }).subscribe(listener),
    listRooms: () => store.listRooms(),
    listProducts: (targetRoom) => {
      const room = store.listRooms().find((candidate) => candidate.id === targetRoom);
      if (!room) return [];
      return store.listProducts(room.tenantId ?? 'tenant-local', targetRoom);
    },
    upsertProduct: async (targetRoom, product) => {
      const room = store.listRooms().find((candidate) => candidate.id === targetRoom);
      if (!room) throw new Error('直播间不存在');
      const saved = { ...product, source: 'manual' as const, updatedAt: Date.now() };
      store.upsertProduct(room.tenantId ?? 'tenant-local', saved, targetRoom);
      await syncRoomCatalog(targetRoom);
      return saved;
    },
    removeProduct: async (targetRoom, productId) => {
      const catalog = store.listProducts(store.listRooms().find((candidate) => candidate.id === targetRoom)?.tenantId ?? 'tenant-local', targetRoom);
      if (!catalog.some((product) => product.id === productId)) throw new Error('商品不存在或不属于当前直播间');
      if (catalog.length <= 1) throw new Error('直播间至少需要保留一个商品');
      store.removeRoomProduct(targetRoom, productId);
      return syncRoomCatalog(targetRoom);
    },
    listSessions: (targetRoomId) => review.listSessions(targetRoomId),
    getReview: (sessionId) => review.getReview(sessionId),
    createDisplayLink: (sessionId) => { if (!store.getSessionSnapshot(sessionId)) throw new Error('直播场次不存在'); return store.getOrCreateDisplayLink(sessionId); },
    resolveDisplayLink: (alias) => store.resolveDisplayLink(alias),
    close: async () => {
      clearInterval(deliveryTimer);
      await Promise.all([...sessions.values()].filter((session) => session.snapshot().lifecycle !== 'ended').map((session) => session.dispatch({ type: 'stop' })));
      await Promise.all([...writers.entries()].map(async ([sessionId, writer]) => {
        const [source, asr] = await Promise.all([writer.source.finalize().catch(() => null), writer.asr.finalize().catch(() => null)]);
        if (source && source.byteLength > 0) store.registerAudioAsset({ id: `audio-source-${sessionId}`, sessionId, path: source.path, encoding: 'pcm_s16le_source', byteLength: source.byteLength, durationMs: source.durationMs, sampleRate: source.sampleRate, channels: source.channels });
        if (asr && asr.byteLength > 0) store.registerAudioAsset({ id: `audio-asr-${sessionId}`, sessionId, path: asr.path, encoding: 'pcm_s16le_asr', byteLength: asr.byteLength, durationMs: asr.durationMs, sampleRate: asr.sampleRate, channels: asr.channels });
      }));
      store.close();
    },
  };
}
