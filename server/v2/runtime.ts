import { resolve } from 'node:path';
import { PRODUCTS } from '../../src/shared/products';
import type { LiveCommand, LiveEvent, LiveSessionSnapshot, SessionReview, SessionSummary } from '../../src/shared/v2';
import type { Product } from '../../src/shared/types';
import { createDoubaoAnalyzer } from '../services';
import { createDoubaoCoach } from '../providers/doubaoCoach';
import { DoubaoProductComplianceProfiler, localProductComplianceProfile, type ProductComplianceProfiler } from '../providers/productComplianceProfiler';
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
import { RulePackageRegistry } from './rulePackages';
import { RuleActivationIndex } from './ruleActivation';

export type LiveSessionPort = Pick<LiveSession, 'dispatch' | 'snapshot' | 'subscribe'> & { readonly id: string };

export type V2Runtime = {
  readonly store: SqliteFactStore;
  readonly scheduler: BoundedScheduler;
  readonly review: SessionReviewModule;
  readonly delivery: DurableDelivery;
  readonly authorization: AuthorizationModule;
  readonly rules: RuleModule;
  readonly rulePackages: RulePackageRegistry;
  readonly ruleActivation: RuleActivationIndex;
  readonly presenters: PresenterModule;
  getOrCreateSession(input?: { sessionId?: string; roomId?: string; presenterId?: string; presenterName?: string }): LiveSessionPort;
  getOrCreateOperatorSession(input?: { sessionId?: string; roomId?: string; presenterId?: string; presenterName?: string }): LiveSessionPort;
  getSession(sessionId: string): LiveSessionPort | null;
  dispatch(sessionId: string, command: LiveCommand, actorId?: string): Promise<void>;
  snapshot(sessionId: string): LiveSessionSnapshot | null;
  subscribe(sessionId: string, listener: (event: LiveEvent, snapshot: LiveSessionSnapshot) => void): () => void;
  listRooms(): ReturnType<SqliteFactStore['listRooms']>;
  listProducts(roomId: string): Product[];
  upsertProduct(roomId: string, product: Product): Promise<Product>;
  profileProduct(roomId: string, productId: string): Promise<Product>;
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

export function createRuntime(options: { env?: NodeJS.ProcessEnv; rootDir?: string; productProfiler?: ProductComplianceProfiler } = {}): V2Runtime {
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
  const rulePackages = new RulePackageRegistry(store);
  const ruleActivation = new RuleActivationIndex(rules, rulePackages);
  const presenters = new PresenterModule(store);
  const productProfiler = options.productProfiler ?? new DoubaoProductComplianceProfiler(env);
  const deliveryTimer = setInterval(() => { void delivery.flushOnce(); }, 5_000);
  deliveryTimer.unref();
  const sessions = new Map<string, LiveSession>();
  const writers = new Map<string, { source: AudioFileWriter; asr: AudioFileWriter }>();
  const productProfileTasks = new Set<Promise<void>>();
  const seedProducts = PRODUCTS.map((product) => {
    const seeded = { ...product, updatedAt: product.updatedAt || Date.now() };
    return { ...seeded, complianceProfile: product.complianceProfile ?? localProductComplianceProfile(seeded) };
  });
  const roomId = 'room-default';
  store.ensureRoom({ id: roomId, tenantId: 'tenant-local', name: '默认直播间', accountName: '本地账号', ownerActorId: 'owner' });
  if (store.listProducts('tenant-local', roomId).length === 0) seedProducts.forEach((product) => store.upsertProduct('tenant-local', product, roomId));
  for (const room of store.listRooms()) {
    const tenantId = room.tenantId ?? 'tenant-local';
    for (const product of store.listProducts(tenantId, room.id)) {
      if (!product.complianceProfile) store.upsertProduct(tenantId, { ...product, complianceProfile: localProductComplianceProfile(product), updatedAt: Date.now() }, room.id);
    }
  }
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
    let requestedPresenter = presenters.get(persisted?.presenterId ?? input.presenterId ?? '');
    if (!requestedPresenter && persisted?.presenterId) {
      requestedPresenter = store.ensurePresenter({ id: persisted.presenterId, roomId: targetRoom, name: persisted.presenterName || '默认主播', accountName: '本地账号' });
    }
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
      rules: (product) => ruleActivation.compile({ roomId: targetRoom, product, platform: product.complianceProfile?.platformRuleset, industry: product.complianceProfile?.industry }).rules,
      semanticRules: (product) => ruleActivation.compile({ roomId: targetRoom, product, platform: product.complianceProfile?.platformRuleset, industry: product.complianceProfile?.industry }).semanticRules,
      referencePhrases: (activePresenterId, productId) => presenters.references(activePresenterId, productId).slice(0, 10).map((phrase) => ({ text: phrase.text, purpose: phrase.purpose })),
      resolvePresenter: (activePresenterId) => {
        const candidate = presenters.get(activePresenterId);
        return candidate?.roomId === targetRoom ? { id: candidate.id, name: candidate.name } : null;
      },
      onComplianceResult: (result, analyzedProduct) => { rules.learn(targetRoom, sessionId, result, analyzedProduct); },
      onReviewTiming: (timing) => console.info('[realtime-review]', JSON.stringify(timing)),
      session: { sessionId, tenantId, roomId: targetRoom, presenterId, presenterName, product: persisted?.product ?? roomProducts[0], lineup: persisted?.lineup?.length ? persisted.lineup : roomProducts },
    });
    writers.set(sessionId, writer);
    liveSession.subscribe((event) => {
      if (event.type === 'lifecycle.changed' || event.type === 'capture.error') syncBackgroundScheduling();
      if (event.type === 'session.ended') {
        const snapshot = liveSession.snapshot();
        try {
          presenters.archiveSession(snapshot.presenterId, sessionId, snapshot.product.id, snapshot.transcriptHistory);
        } catch (error) {
          console.error('[session-archive]', JSON.stringify({ sessionId, presenterId: snapshot.presenterId, error: error instanceof Error ? error.message : String(error) }));
        }
        void Promise.all([writer.source.finalize(), writer.asr.finalize()]).then(([source, asr]) => {
          if (source.byteLength > 0) store.registerAudioAsset({ id: `audio-source-${sessionId}`, sessionId, path: source.path, encoding: 'pcm_s16le_source', byteLength: source.byteLength, durationMs: source.durationMs, sampleRate: source.sampleRate, channels: source.channels });
          if (asr.byteLength > 0) store.registerAudioAsset({ id: `audio-asr-${sessionId}`, sessionId, path: asr.path, encoding: 'pcm_s16le_asr', byteLength: asr.byteLength, durationMs: asr.durationMs, sampleRate: asr.sampleRate, channels: asr.channels });
        }).catch((error) => console.error('[audio-finalize]', JSON.stringify({ sessionId, error: error instanceof Error ? error.message : String(error) })));
      }
    });
    sessions.set(sessionId, liveSession);
    return liveSession;
  };

  // An operator URL identifies the last working session. Once that session has
  // ended, start the next session in the same room instead of leaving the
  // operator on a read-only ended snapshot.
  const getOrCreateOperatorSession = (input: { sessionId?: string; roomId?: string; presenterId?: string; presenterName?: string } = {}): LiveSession => {
    const requestedId = validSessionId(input.sessionId);
    const requestedSnapshot = requestedId ? (sessions.get(requestedId)?.snapshot() ?? store.getSessionSnapshot(requestedId)) : null;
    if (requestedSnapshot?.lifecycle !== 'ended') return getOrCreateSession(input);

    const activeInRoom = [...sessions.values()]
      .map((session) => session.snapshot())
      .filter((snapshot) => snapshot.roomId === requestedSnapshot.roomId && (snapshot.lifecycle === 'idle' || snapshot.lifecycle === 'paused'))
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (activeInRoom) return getOrCreateSession({ sessionId: activeInRoom.sessionId });

    const persistedActive = store.listSessionSummaries(requestedSnapshot.roomId).find((summary) => summary.lifecycle === 'idle' || summary.lifecycle === 'paused');
    if (persistedActive) return getOrCreateSession({ sessionId: persistedActive.sessionId });

    return getOrCreateSession({ roomId: requestedSnapshot.roomId, presenterId: requestedSnapshot.presenterId, presenterName: requestedSnapshot.presenterName });
  };

  const syncRoomCatalog = async (targetRoom: string, appendProductId?: string): Promise<Product[]> => {
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
      if (appendProductId && catalogIds.has(appendProductId) && !retainedIds.includes(appendProductId)) retainedIds.push(appendProductId);
      return session.dispatch({ type: 'catalog_sync', products: catalog }).then(() => session.dispatch({ type: 'set_lineup', productIds: retainedIds.length > 0 ? retainedIds : catalog.map((product) => product.id) }));
    }));
    return catalog;
  };

  return {
    store, scheduler, review, delivery, authorization, rules, rulePackages, ruleActivation, presenters,
    getOrCreateSession,
    getOrCreateOperatorSession,
    getSession: (sessionId) => sessions.get(sessionId) ?? (store.getSessionSnapshot(sessionId) ? getOrCreateSession({ sessionId }) : null),
    dispatch: async (sessionId, command, actorId) => { const session = getOrCreateSession({ sessionId }); await session.dispatch(command, actorId ? { actorId } : undefined); },
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
      const tenantId = room.tenantId ?? 'tenant-local';
      const existing = store.listProducts(tenantId, targetRoom).find((candidate) => candidate.id === product.id);
      const isNew = !existing;
      const facts = (candidate: Product) => JSON.stringify({ name: candidate.name, category: candidate.category, description: candidate.description, sellingPoints: candidate.sellingPoints, sourceText: candidate.sourceText ?? '' });
      const shouldRefreshProfile = !product.complianceProfile || (product.complianceProfile.source !== 'manual' && Boolean(existing) && facts(existing!) !== facts(product));
      const profile = shouldRefreshProfile ? localProductComplianceProfile(product) : product.complianceProfile!;
      const saved = { ...product, category: profile.category, complianceProfile: profile, source: 'manual' as const, updatedAt: Date.now() };
      store.upsertProduct(tenantId, saved, targetRoom);
      await syncRoomCatalog(targetRoom, isNew ? saved.id : undefined);
      if (shouldRefreshProfile) {
        const task = scheduler.run('model', `product-profile:${targetRoom}`, async () => {
          const generated = await productProfiler.profile(product);
          const current = store.listProducts(tenantId, targetRoom).find((candidate) => candidate.id === product.id);
          if (!current || current.complianceProfile?.updatedAt !== profile.updatedAt || generated.source !== 'doubao') return;
          store.upsertProduct(tenantId, { ...current, category: generated.category, complianceProfile: generated, updatedAt: Date.now() }, targetRoom);
          await syncRoomCatalog(targetRoom);
        }, { priority: 'low' }).catch((error) => console.error('[product-compliance-profile]', JSON.stringify({ roomId: targetRoom, productId: product.id, error: error instanceof Error ? error.message : String(error) })));
        productProfileTasks.add(task);
        void task.finally(() => productProfileTasks.delete(task));
      }
      return saved;
    },
    profileProduct: async (targetRoom, productId) => {
      const room = store.listRooms().find((candidate) => candidate.id === targetRoom);
      if (!room) throw new Error('直播间不存在');
      const product = store.listProducts(room.tenantId ?? 'tenant-local', targetRoom).find((candidate) => candidate.id === productId);
      if (!product) throw new Error('商品不存在或不属于当前直播间');
      const profile = await scheduler.run('model', `product-profile:${targetRoom}`, () => productProfiler.profile({ ...product, complianceProfile: undefined }));
      const saved = { ...product, category: profile.category, complianceProfile: profile, updatedAt: Date.now() };
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
      await Promise.all([...productProfileTasks]);
      store.close();
    },
  };
}
