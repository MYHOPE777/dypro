import 'dotenv/config';
import { createReadStream, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, type WebSocket } from 'ws';
import { LiveSession } from './session';
import { FileTimelineStore } from './timelineStore';
import { FileProductCatalog } from './productCatalog';
import { FileRuleCatalog } from './ruleCatalog';
import { FileSpeechCorrectionCatalog } from './speechCorrectionCatalog';
import { parseProductText } from './productParser';
import { AuthService, allowsControlTransport, canAccessRoom, type AuthIdentity } from './auth';
import { readSessionIdleTtlMs } from './config';
import { canDisplayJoin, CaptureLease } from './sessionAccess';
import { DisplayLinkRegistry, DISPLAY_LINK_TTL_MS } from './displayLink';
import { createRecordingArchiveQueue } from './recordingArchive';
import { createRuleSyncQueue } from './ruleSync';
import { FilePresenterPhraseLibrary } from './presenterPhraseLibrary';
import { createPhraseSyncQueue } from './phraseSync';
import { createDoubaoAnalyzer } from './services';
import { getArkKnowledgeSearchStatus } from './providers/ark';
import { getArkConfig, requestArk } from './providers/ark';
import { parseArkJson } from './providers/doubao';
import type { ClientMessage, ComplianceRuleScope, CoachPurpose, RiskLevel, Product, SessionHistorySummary } from '../src/shared/types';

const app = express();
const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true });
const sessions = new Map<string, LiveSession>();
const port = Number(process.env.PORT ?? 8787);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(projectRoot, '../dist/client');
const timelineStore = new FileTimelineStore(process.env.TIMELINE_DATA_DIR ?? path.resolve(projectRoot, '../.data/timeline'));
const productCatalog = new FileProductCatalog(process.env.PRODUCT_CATALOG_PATH ?? path.resolve(projectRoot, '../.data/products/catalog.json'));
const ruleSyncQueue = createRuleSyncQueue(process.env);
const ruleCatalog = new FileRuleCatalog(productCatalog, process.env.RULE_CATALOG_PATH ?? path.resolve(projectRoot, '../.data/rules/catalog.json'), process.env.RULE_REVIEWER_ACTOR_ID ?? 'owner', (event) => { ruleSyncQueue.enqueue(event); });
const phraseSyncQueue = createPhraseSyncQueue(process.env);
const phraseLibrary = new FilePresenterPhraseLibrary(process.env.PHRASE_LIBRARY_PATH ?? path.resolve(projectRoot, '../.data/phrases/catalog.json'), (event) => { phraseSyncQueue.enqueue(event); });
const speechCorrectionCatalog = new FileSpeechCorrectionCatalog(process.env.SPEECH_CORRECTION_CATALOG_PATH ?? path.resolve(projectRoot, '../.data/speech-corrections/catalog.json'));
const authService = new AuthService(process.env);
const requestIdentities = new WeakMap<express.Request, AuthIdentity>();
const loginAttempts = new Map<string, { failures: number; blockedUntil: number }>();
const sessionExpiryTimers = new Map<string, NodeJS.Timeout>();
const captureLeases = new CaptureLease<WebSocket>();
const displayLinks = new DisplayLinkRegistry(
  DISPLAY_LINK_TTL_MS,
  Date.now,
  process.env.DISPLAY_LINK_REGISTRY_PATH ?? path.resolve(projectRoot, '../.data/display-links/registry.json'),
);
const sessionIdleTtlMs = readSessionIdleTtlMs(process.env);
const allowInsecureAuth = process.env.ALLOW_INSECURE_AUTH === 'true';
const complianceAnalyzer = createDoubaoAnalyzer(process.env);
const recordingArchiveQueue = createRecordingArchiveQueue(timelineStore, process.env, (sessionId) => !sessions.get(sessionId)?.state.isListening);
const recordingArchiveTimer = setInterval(() => { void recordingArchiveQueue.flush(); }, 10_000);
recordingArchiveTimer.unref();
const ruleSyncTimer = setInterval(() => { void ruleSyncQueue.flush(); }, 10_000);
ruleSyncTimer.unref();
const phraseSyncTimer = setInterval(() => { void phraseSyncQueue.flush(); }, 10_000);
phraseSyncTimer.unref();
let websocketConnectionsAccepted = 0;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

function safeRoomId(value: unknown): string {
  return typeof value === 'string' && /^room-[a-z0-9-]{4,64}$/u.test(value) ? value : 'room-default';
}

function getOrCreateSession(id?: string, roomId = 'room-default', actorId = 'owner', presenterId?: string): LiveSession {
  const safeId = id && /^live-[a-z0-9-]{4,32}$/u.test(id) ? id : undefined;
  if (safeId && sessions.has(safeId)) {
    const existing = sessions.get(safeId)!;
    if (existing.roomId === roomId) return existing;
  }
  const room = productCatalog.getRoom(roomId);
  const defaultPresenter = phraseLibrary.createPresenter({ roomId, accountName: room?.accountName ?? roomId, name: process.env.DEFAULT_PRESENTER_NAME?.trim() || '默认主播' });
  const requestedPresenter = presenterId ? phraseLibrary.getPresenter(presenterId) : null;
  const presenter = requestedPresenter?.roomId === roomId ? requestedPresenter : defaultPresenter;
  const session = new LiveSession(safeId && !sessions.has(safeId) ? safeId : undefined, { timelineStore, productCatalog, ruleCatalog, speechCorrectionCatalog, phraseLibrary, presenter, archiveQueue: recordingArchiveQueue, analyzer: complianceAnalyzer, roomId, actorId });
  sessions.set(session.id, session);
  return session;
}

function detachSessionClient(session: LiveSession, socket: WebSocket): void {
  if (captureLeases.release(session.id, socket)) session.pauseListening();
  session.removeClient(socket);
  if (session.clientCount !== 0) return;
  session.pauseListening();
  const existingTimer = sessionExpiryTimers.get(session.id);
  if (existingTimer) clearTimeout(existingTimer);
  const sessionId = session.id;
  const timer = setTimeout(() => {
    const expired = sessions.get(sessionId);
    if (expired?.clientCount === 0) {
      expired.endLive();
      sessions.delete(sessionId);
    }
    sessionExpiryTimers.delete(sessionId);
  }, sessionIdleTtlMs);
  timer.unref();
  sessionExpiryTimers.set(sessionId, timer);
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'session.join':
      return (message.sessionId === undefined || (typeof message.sessionId === 'string' && message.sessionId.length <= 64))
        && (message.roomId === undefined || typeof message.roomId === 'string')
        && (message.displayAlias === undefined || (typeof message.displayAlias === 'string' && /^[A-Z0-9]{8}$/u.test(message.displayAlias)))
        && (message.presenterId === undefined || (typeof message.presenterId === 'string' && /^presenter-[a-f0-9]{14}$/u.test(message.presenterId)))
        && (message.actorId === undefined || typeof message.actorId === 'string')
        && (message.token === undefined || typeof message.token === 'string')
        && (message.role === 'operator' || message.role === 'display');
    case 'control.start':
    case 'control.pause':
    case 'control.resume':
    case 'control.end':
    case 'control.stop':
      return true;
    case 'product.select':
      return typeof message.productId === 'string' && message.productId.length <= 64;
    case 'lineup.set':
      return Array.isArray(message.productIds) && message.productIds.length <= 100 && message.productIds.every((productId) => typeof productId === 'string' && productId.length <= 64);
    case 'risk.profile':
      return message.profile === 'strict' || message.profile === 'balanced' || message.profile === 'optimized';
    case 'presenter.select':
      return typeof message.presenterId === 'string' && /^presenter-[a-f0-9]{14}$/u.test(message.presenterId);
    case 'audio':
      return typeof message.data === 'string' && message.data.length <= 2_000_000;
    case 'audio.raw':
      return typeof message.data === 'string' && message.data.length <= 6_000_000 && typeof message.sampleRate === 'number' && Number.isInteger(message.sampleRate) && message.sampleRate >= 8_000 && message.sampleRate <= 96_000;
    case 'demo.transcript':
      return typeof message.text === 'string' && message.text.trim().length > 0 && message.text.length <= 2_000;
    case 'transcript.correct':
      return typeof message.segmentId === 'string' && message.segmentId.length <= 128
        && typeof message.text === 'string' && message.text.trim().length > 0 && message.text.length <= 2_000
        && (message.learn === undefined || typeof message.learn === 'boolean')
        && (message.wrongText === undefined || (typeof message.wrongText === 'string' && message.wrongText.length <= 80))
        && (message.correctText === undefined || (typeof message.correctText === 'string' && message.correctText.length <= 80));
    case 'transcript.speaker':
      return typeof message.segmentId === 'string' && message.segmentId.length <= 128
        && (message.speaker === 'host' || message.speaker === 'other')
        && (message.speakerId === undefined || (typeof message.speakerId === 'string' && /^speaker-[1-4]$/u.test(message.speakerId)));
    default:
      return false;
  }
}

function getLanAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return 'localhost';
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, sessions: sessions.size, clients: [...sessions.values()].reduce((total, session) => total + session.clientCount, 0), websocketConnectionsAccepted, rooms: productCatalog.listRooms().length, streamingAsrConfigured: Boolean(process.env.X_API_KEY), arkResponsesConfigured: Boolean(process.env.ARK_API_KEY && process.env.ARK_MODEL), authMode: authService.configured ? 'multi-user' : 'local-only', ruleSync: ruleSyncQueue.status(), phraseSync: phraseSyncQueue.status() });
});

function actorFromRequest(request: express.Request): string {
  return identityFromRequest(request).actorId;
}

function identityFromRequest(request: express.Request): AuthIdentity {
  const identity = requestIdentities.get(request);
  if (!identity) throw new Error('请求缺少认证身份');
  return identity;
}

function bearerToken(request: express.Request): string | undefined {
  const authorization = request.header('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : undefined;
}

function isEncryptedSocket(socket: { encrypted?: boolean }): boolean {
  return socket.encrypted === true;
}

function assertControlTransport(input: { socket: { remoteAddress?: string; encrypted?: boolean }; headers: { origin?: string; 'x-forwarded-proto'?: string | string[] } }): void {
  const forwarded = input.headers['x-forwarded-proto'];
  const forwardedProto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (!allowsControlTransport({
    authConfigured: authService.configured,
    encrypted: isEncryptedSocket(input.socket),
    remoteAddress: input.socket.remoteAddress,
    forwardedProto,
    allowInsecure: allowInsecureAuth,
  })) throw new Error('多人控制台必须通过 HTTPS/WSS 访问');
}

function routeParam(request: express.Request, name: string): string {
  const value = request.params[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

const requireOperator: express.RequestHandler = (request, response, next) => {
  try {
    assertControlTransport(request);
    const identity = authService.authenticate({
      token: bearerToken(request),
      claimedActorId: request.header('x-actor-id'),
      remoteAddress: request.socket.remoteAddress,
      origin: request.header('origin'),
    });
    requestIdentities.set(request, identity);
    next();
  } catch (error) {
    response.status(401).json({ message: error instanceof Error ? error.message : '身份认证失败' });
  }
};

function assertRoomAccess(identity: AuthIdentity, roomId: string): void {
  const room = productCatalog.getRoom(roomId);
  if (!room || !canAccessRoom(identity, room)) throw new Error('无权访问该直播间');
}

const requireRoomAccess: express.RequestHandler = (request, response, next) => {
  try {
    assertRoomAccess(identityFromRequest(request), routeParam(request, 'roomId'));
    next();
  } catch (error) {
    response.status(403).json({ message: error instanceof Error ? error.message : '直播间权限校验失败' });
  }
};

function ruleRoomId(ruleId: string): string | null {
  return ruleCatalog.versions(ruleId).at(-1)?.roomId ?? null;
}

function presenterRoomId(presenterId: string): string | null {
  return phraseLibrary.getPresenter(presenterId)?.roomId ?? null;
}

function phraseRoomId(phraseId: string): string | null {
  const phrase = phraseLibrary.getPhrase(phraseId);
  return phrase?.roomId ?? null;
}

const requireRuleAccess: express.RequestHandler = (request, response, next) => {
  try {
    const roomId = ruleRoomId(routeParam(request, 'ruleId'));
    if (!roomId) return response.status(404).json({ message: '规则不存在' });
    assertRoomAccess(identityFromRequest(request), roomId);
    next();
  } catch (error) {
    response.status(403).json({ message: error instanceof Error ? error.message : '规则权限校验失败' });
  }
};

const requirePresenterAccess: express.RequestHandler = (request, response, next) => {
  try {
    const roomId = presenterRoomId(routeParam(request, 'presenterId'));
    if (!roomId) return response.status(404).json({ message: '主播档案不存在' });
    assertRoomAccess(identityFromRequest(request), roomId);
    next();
  } catch (error) { response.status(403).json({ message: error instanceof Error ? error.message : '主播档案权限校验失败' }); }
};

const requirePhraseAccess: express.RequestHandler = (request, response, next) => {
  try {
    const roomId = phraseRoomId(routeParam(request, 'phraseId'));
    if (!roomId) return response.status(404).json({ message: '话术不存在' });
    assertRoomAccess(identityFromRequest(request), roomId);
    next();
  } catch (error) { response.status(403).json({ message: error instanceof Error ? error.message : '话术权限校验失败' }); }
};

function persistedSessionRoomId(sessionId: string): string | null {
  const timeline = timelineStore.exportSession(sessionId);
  if (!timeline) return null;
  const roomId = timeline.events.find((event) => event.type === 'session.created')?.payload.roomId;
  return typeof roomId === 'string' ? roomId : 'room-default';
}

function editableSession(sessionId: string, actorId: string): LiveSession | null {
  const active = sessions.get(sessionId);
  if (active) return active;
  const timeline = timelineStore.exportSession(sessionId);
  if (!timeline) return null;
  const created = timeline.events.find((event) => event.type === 'session.created');
  const roomId = typeof created?.payload.roomId === 'string' ? created.payload.roomId : 'room-default';
  const presenterEvent = timeline.events.filter((event) => event.type === 'session.created' || event.type === 'presenter.selected').at(-1);
  const presenterId = typeof presenterEvent?.payload.presenterId === 'string' ? presenterEvent.payload.presenterId : undefined;
  const presenter = presenterId ? phraseLibrary.getPresenter(presenterId) ?? undefined : undefined;
  return new LiveSession(sessionId, { timelineStore, productCatalog, ruleCatalog, speechCorrectionCatalog, phraseLibrary, presenter, archiveQueue: recordingArchiveQueue, analyzer: complianceAnalyzer, roomId, actorId, historicalEdit: true });
}

function historySummary(summary: SessionHistorySummary): SessionHistorySummary {
  const active = sessions.get(summary.sessionId);
  return {
    ...summary,
    ...(active ? { captureState: active.state.captureState, updatedAt: Math.max(summary.updatedAt, active.state.lastEventAt) } : {}),
    sync: recordingArchiveQueue.sessionStatus(summary.sessionId),
  };
}

function isEndedSession(sessionId: string): boolean {
  const active = sessions.get(sessionId);
  if (active) return active.state.captureState === 'ended';
  const roomId = persistedSessionRoomId(sessionId);
  return Boolean(roomId && timelineStore.listSessions(roomId).find((candidate) => candidate.sessionId === sessionId)?.captureState === 'ended');
}

const requireSessionAccess: express.RequestHandler = (request, response, next) => {
  try {
    const sessionId = routeParam(request, 'id');
    const roomId = sessions.get(sessionId)?.roomId ?? persistedSessionRoomId(sessionId);
    if (!roomId) return response.status(404).json({ message: 'session not found' });
    assertRoomAccess(identityFromRequest(request), roomId);
    next();
  } catch (error) {
    response.status(403).json({ message: error instanceof Error ? error.message : '会话权限校验失败' });
  }
};

app.get('/api/auth/status', (request, response) => {
  try {
    assertControlTransport(request);
    const identity = authService.authenticate({ token: bearerToken(request), claimedActorId: request.header('x-actor-id'), remoteAddress: request.socket.remoteAddress, origin: request.header('origin') });
    return response.json({ mode: authService.configured ? 'multi-user' : 'local-only', authenticated: true, identity });
  } catch (error) {
    return response.json({ mode: authService.configured ? 'multi-user' : 'local-only', authenticated: false, message: error instanceof Error ? error.message : '身份认证失败' });
  }
});

app.post('/api/auth/login', (request, response) => {
  try {
    assertControlTransport(request);
  } catch (error) {
    return response.status(426).json({ message: error instanceof Error ? error.message : '需要安全连接' });
  }
  const remoteAddress = request.socket.remoteAddress ?? 'unknown';
  const attempt = loginAttempts.get(remoteAddress);
  if (attempt && attempt.blockedUntil > Date.now()) return response.status(429).json({ message: '登录尝试过多，请稍后再试' });
  try {
    const login = authService.login(String(request.body?.actorId ?? ''), String(request.body?.password ?? ''));
    loginAttempts.delete(remoteAddress);
    return response.json(login);
  } catch (error) {
    const failures = (attempt?.failures ?? 0) + 1;
    loginAttempts.set(remoteAddress, { failures, blockedUntil: failures >= 5 ? Date.now() + 60_000 : 0 });
    return response.status(401).json({ message: error instanceof Error ? error.message : '登录失败' });
  }
});

app.get('/api/readiness', (_request, response) => {
  const streamingAsrConfigured = Boolean(process.env.X_API_KEY);
  const arkResponsesConfigured = Boolean(process.env.ARK_API_KEY && process.env.ARK_MODEL);
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  const archiveStatus = recordingArchiveQueue.status();
  const objectStorageConfigured = archiveStatus.configured;
  const redisConfigured = Boolean(process.env.REDIS_URL);
  const knowledge = getArkKnowledgeSearchStatus(process.env);
  const ruleSync = ruleSyncQueue.status();
  const phraseSync = phraseSyncQueue.status();
  const liveConfigured = streamingAsrConfigured && arkResponsesConfigured;
  const productionConfigured = liveConfigured && authService.configured && databaseConfigured && objectStorageConfigured && redisConfigured;
  response.json({
    readyForLive: liveConfigured,
    readyForProduction: productionConfigured,
    mode: productionConfigured ? 'production' : liveConfigured ? 'live-with-local-persistence' : 'demo',
    streamingAsr: { configured: streamingAsrConfigured, label: streamingAsrConfigured ? '豆包大模型流式语音识别参数已填写' : '豆包大模型流式语音识别待配置' },
    arkResponses: { configured: arkResponsesConfigured, label: arkResponsesConfigured ? '火山方舟 Responses API 参数已填写' : '火山方舟 Responses API 待配置' },
    auth: { configured: authService.configured, label: authService.configured ? '多人身份已保护' : '仅限本机控制' },
    storage: { configured: databaseConfigured && objectStorageConfigured, label: databaseConfigured && objectStorageConfigured ? '数据库 + 对象存储已配置' : '本地文件存储（生产存储待配置）' },
    database: { configured: databaseConfigured, label: databaseConfigured ? '业务数据库参数已填写' : '业务数据库待配置' },
    objectStorage: { configured: objectStorageConfigured, label: objectStorageConfigured ? '人工确认上传服务已配置' : '人工确认上传服务待配置', status: archiveStatus },
    redis: { configured: redisConfigured, label: redisConfigured ? 'Redis 会话协调已配置' : 'Redis 会话协调待配置' },
    knowledge,
    ruleSync: { ...ruleSync, label: ruleSync.configured ? '规则库后台同步已配置' : '规则库本地优先，云端同步待配置' },
    phraseSync: { ...phraseSync, label: phraseSync.configured ? '主播话术后台同步已配置' : '主播话术本地优先，云端同步待配置' },
  });
});

app.get('/api/rules/sync/status', requireOperator, (_request, response) => response.json(ruleSyncQueue.status()));
app.get('/api/phrases/sync/status', requireOperator, (_request, response) => response.json(phraseSyncQueue.status()));

app.get('/api/rooms/:roomId/sessions', requireOperator, requireRoomAccess, (request, response) => {
  const roomId = routeParam(request, 'roomId');
  return response.json(timelineStore.listSessions(roomId).map(historySummary));
});

app.get('/api/knowledge/status', requireOperator, (_request, response) => response.json({ knowledge: getArkKnowledgeSearchStatus(process.env) }));

function isProductPayload(value: unknown): value is Product {
  if (!value || typeof value !== 'object') return false;
  const product = value as Record<string, unknown>;
  return typeof product.id === 'string' && typeof product.name === 'string' && typeof product.category === 'string' && typeof product.price === 'string'
    && (product.stock === null || (typeof product.stock === 'number' && Number.isSafeInteger(product.stock) && product.stock >= 0)) && typeof product.sku === 'string' && typeof product.description === 'string'
    && Array.isArray(product.sellingPoints) && product.sellingPoints.every((item) => typeof item === 'string')
    && typeof product.image === 'string' && typeof product.accent === 'string'
    && Array.isArray(product.compliantPhrases) && product.compliantPhrases.every((item) => typeof item === 'string')
    && (product.source === 'seed' || product.source === 'manual' || product.source === 'doubao' || product.source === 'local-fallback')
    && typeof product.updatedAt === 'number';
}

function readRuleInput(value: unknown): { name: string; scope: ComplianceRuleScope; matchType: 'contains' | 'regex'; pattern: string; risk: RiskLevel; title: string; reason: string; alternative: string; policyRef: string } | null {
  if (!value || typeof value !== 'object') return null;
  const rule = value as Record<string, unknown>;
  const scope = rule.scope === 'shared' ? 'shared' : rule.scope === 'room' ? 'room' : null;
  const matchType = rule.matchType === 'regex' ? 'regex' : rule.matchType === 'contains' ? 'contains' : null;
  const risk = rule.risk === 'blocked' || rule.risk === 'warning' || rule.risk === 'safe' ? rule.risk : null;
  if (!scope || !matchType || !risk) return null;
  const strings = ['name', 'pattern', 'title', 'reason', 'alternative', 'policyRef'];
  if (strings.some((key) => typeof rule[key] !== 'string')) return null;
  return { scope, matchType, risk, name: rule.name as string, pattern: rule.pattern as string, title: rule.title as string, reason: rule.reason as string, alternative: rule.alternative as string, policyRef: rule.policyRef as string };
}

function readPresenterInput(value: unknown): { name: string; accountName: string } | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.name !== 'string' || typeof input.accountName !== 'string' || !input.name.trim() || !input.accountName.trim()) return null;
  return { name: input.name.trim().slice(0, 80), accountName: input.accountName.trim().slice(0, 120) };
}

function validPurpose(value: unknown): value is CoachPurpose {
  return value === '塑品' || value === '憋单' || value === '逼单' || value === '转化' || value === '互动' || value === '留人' || value === '答疑';
}

function readPhraseInput(value: unknown): { text: string; productId: string | null; purpose?: CoachPurpose; source: 'manual' | 'imported' } | null {
  if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).text !== 'string') return null;
  const phrase = value as Record<string, unknown>;
  const text = String(phrase.text).trim();
  if (!text || text.length > 2_000) return null;
  return { text, productId: typeof phrase.productId === 'string' ? phrase.productId : null, ...(validPurpose(phrase.purpose) ? { purpose: phrase.purpose } : {}), source: phrase.source === 'imported' ? 'imported' : 'manual' };
}

app.get('/api/rooms', requireOperator, (request, response) => {
  const identity = identityFromRequest(request);
  response.json(productCatalog.listRooms().filter((room) => canAccessRoom(identity, room)));
});

app.post('/api/rooms', requireOperator, (request, response) => {
  try {
    const room = productCatalog.createRoom({ name: String(request.body?.name ?? ''), accountName: String(request.body?.accountName ?? ''), ownerActorId: actorFromRequest(request) });
    return response.status(201).json(room);
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '直播间创建失败' });
  }
});

app.get('/api/rooms/:roomId', requireOperator, requireRoomAccess, (request, response) => {
  const room = productCatalog.getRoom(routeParam(request, 'roomId'));
  return room ? response.json(room) : response.status(404).json({ message: '直播间不存在' });
});

app.get('/api/rooms/:roomId/presenters', requireOperator, requireRoomAccess, (request, response) => response.json(phraseLibrary.listPresenters(routeParam(request, 'roomId'))));
app.post('/api/rooms/:roomId/presenters', requireOperator, requireRoomAccess, (request, response) => {
  const input = readPresenterInput(request.body);
  if (!input) return response.status(400).json({ message: '主播名称和账号不能为空' });
  try { return response.status(201).json(phraseLibrary.createPresenter({ roomId: routeParam(request, 'roomId'), ...input })); }
  catch (error) { return response.status(400).json({ message: error instanceof Error ? error.message : '主播档案创建失败' }); }
});

app.get('/api/presenters/:presenterId/phrases', requireOperator, requirePresenterAccess, (request, response) => {
  const productId = typeof request.query.productId === 'string' ? request.query.productId : undefined;
  const phrases = phraseLibrary.listPhrases(routeParam(request, 'presenterId'));
  return response.json(productId ? phrases.filter((phrase) => phrase.productId === null || phrase.productId === productId) : phrases);
});
app.post('/api/presenters/:presenterId/phrases', requireOperator, requirePresenterAccess, (request, response) => {
  const input = readPhraseInput(request.body);
  if (!input) return response.status(400).json({ message: '话术内容格式不完整' });
  try { return response.status(201).json(phraseLibrary.createPhrase(routeParam(request, 'presenterId'), input)); }
  catch (error) { return response.status(400).json({ message: error instanceof Error ? error.message : '话术保存失败' }); }
});
app.get('/api/phrases/:phraseId/versions', requireOperator, requirePhraseAccess, (request, response) => response.json(phraseLibrary.versions(routeParam(request, 'phraseId'))));
app.patch('/api/phrases/:phraseId', requireOperator, requirePhraseAccess, (request, response) => {
  if (typeof request.body?.text !== 'string' || !request.body.text.trim()) return response.status(400).json({ message: '话术内容不能为空' });
  try { return response.json(phraseLibrary.revise(routeParam(request, 'phraseId'), { text: request.body.text, ...(validPurpose(request.body.purpose) ? { purpose: request.body.purpose } : {}), source: request.body.source === 'doubao' ? 'doubao' : 'manual' })); }
  catch (error) { return response.status(400).json({ message: error instanceof Error ? error.message : '话术修改失败' }); }
});
app.post('/api/phrases/:phraseId/reference', requireOperator, requirePhraseAccess, (request, response) => {
  if (typeof request.body?.selected !== 'boolean') return response.status(400).json({ message: 'selected 必须是布尔值' });
  try { return response.json(phraseLibrary.setReference(routeParam(request, 'phraseId'), request.body.selected)); }
  catch (error) { return response.status(400).json({ message: error instanceof Error ? error.message : '话术参考状态更新失败' }); }
});
app.post('/api/phrases/:phraseId/rollback', requireOperator, requirePhraseAccess, (request, response) => {
  const targetVersion = Number(request.body?.targetVersion);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) return response.status(400).json({ message: '目标版本无效' });
  try { return response.json(phraseLibrary.rollback(routeParam(request, 'phraseId'), targetVersion)); }
  catch (error) { return response.status(400).json({ message: error instanceof Error ? error.message : '话术回滚失败' }); }
});
app.post('/api/phrases/:phraseId/rewrite', requireOperator, requirePhraseAccess, async (request, response) => {
  const phrase = phraseLibrary.getPhrase(routeParam(request, 'phraseId'));
  if (!phrase) return response.status(404).json({ message: '话术不存在' });
  const config = getArkConfig(process.env, 'ARK_PHRASE_REWRITE_TIMEOUT_MS', 4_000);
  if (!config) return response.status(503).json({ message: '豆包改写待配置，仍可使用人工编辑' });
  try {
    const content = await requestArk(config, '你是直播话术教练。只输出 JSON：{"text":"改写后话术","purpose":"塑品|憋单|逼单|转化|互动|留人|答疑"}。不得添加未提供的价格、库存、功效或赠品承诺，保持真实、自然、可直接朗读。', JSON.stringify({ phrase: phrase.text, productId: phrase.productId, purpose: phrase.purpose ?? '塑品' }), 240, Boolean(config.knowledgeResourceId));
    const result = parseArkJson(content);
    if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('豆包未返回有效话术');
    return response.json(phraseLibrary.revise(phrase.id, { text: result.text, purpose: validPurpose(result.purpose) ? result.purpose : phrase.purpose, source: 'doubao' }));
  } catch (error) { return response.status(400).json({ message: error instanceof Error ? error.message : '豆包改写失败' }); }
});

app.get('/api/rooms/:roomId/products', requireOperator, requireRoomAccess, (request, response) => {
  try {
    return response.json(productCatalog.list(routeParam(request, 'roomId')));
  } catch (error) {
    return response.status(404).json({ message: error instanceof Error ? error.message : '商品库读取失败' });
  }
});

app.get('/api/products', requireOperator, (request, response) => {
  try {
    assertRoomAccess(identityFromRequest(request), 'room-default');
    return response.json(productCatalog.list('room-default'));
  } catch (error) {
    return response.status(403).json({ message: error instanceof Error ? error.message : '商品库权限校验失败' });
  }
});

app.post('/api/products/parse', requireOperator, async (request, response) => {
  try {
    const text = typeof request.body?.text === 'string' ? request.body.text : '';
    return response.json(await parseProductText(text));
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '商品信息解析失败' });
  }
});

app.post('/api/rooms/:roomId/products', requireOperator, requireRoomAccess, (request, response) => {
  if (!isProductPayload(request.body?.product)) return response.status(400).json({ message: '商品资料格式不完整' });
  try {
    return response.status(201).json(productCatalog.upsert(routeParam(request, 'roomId'), request.body.product));
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '商品保存失败' });
  }
});

app.get('/api/rooms/:roomId/rules', requireOperator, requireRoomAccess, (request, response) => response.json(ruleCatalog.list(routeParam(request, 'roomId'))));
app.get('/api/rooms/:roomId/rules/audits', requireOperator, requireRoomAccess, (request, response) => response.json(ruleCatalog.audits(routeParam(request, 'roomId'))));
app.get('/api/rooms/:roomId/speech-corrections', requireOperator, requireRoomAccess, (request, response) => response.json(speechCorrectionCatalog.list(routeParam(request, 'roomId'))));

app.post('/api/rooms/:roomId/speech-corrections/:correctionId/enabled', requireOperator, requireRoomAccess, (request, response) => {
  if (typeof request.body?.enabled !== 'boolean') return response.status(400).json({ message: 'enabled 必须是布尔值' });
  try {
    const correction = speechCorrectionCatalog.getById(routeParam(request, 'correctionId'));
    if (!correction || correction.roomId !== routeParam(request, 'roomId')) return response.status(404).json({ message: '语音纠错记录不存在' });
    return response.json(speechCorrectionCatalog.setEnabled(correction.id, request.body.enabled));
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '语音纠错状态更新失败' });
  }
});

app.post('/api/rooms/:roomId/rules', requireOperator, requireRoomAccess, (request, response) => {
  const input = readRuleInput(request.body);
  if (!input) return response.status(400).json({ message: '规则资料格式不完整' });
  try {
    const rule = ruleCatalog.create(routeParam(request, 'roomId'), actorFromRequest(request), input);
    return response.status(201).json(rule);
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '规则保存失败' });
  }
});

app.get('/api/rules/:ruleId/versions', requireOperator, requireRuleAccess, (request, response) => response.json(ruleCatalog.versions(routeParam(request, 'ruleId'))));
app.patch('/api/rules/:ruleId', requireOperator, requireRuleAccess, (request, response) => {
  const input = readRuleInput(request.body);
  if (!input) return response.status(400).json({ message: '规则资料格式不完整' });
  try {
    const rule = ruleCatalog.update(routeParam(request, 'ruleId'), actorFromRequest(request), input);
    return response.json(rule);
  }
  catch (error) { return response.status(403).json({ message: error instanceof Error ? error.message : '规则更新失败' }); }
});
app.post('/api/rules/:ruleId/approve', requireOperator, requireRuleAccess, (request, response) => {
  try {
    const rule = ruleCatalog.approve(routeParam(request, 'ruleId'), actorFromRequest(request));
    return response.json(rule);
  }
  catch (error) { return response.status(403).json({ message: error instanceof Error ? error.message : '规则审核失败' }); }
});
app.post('/api/rules/:ruleId/reject', requireOperator, requireRuleAccess, (request, response) => {
  try {
    const rule = ruleCatalog.reject(routeParam(request, 'ruleId'), actorFromRequest(request), String(request.body?.reason ?? ''));
    return response.json(rule);
  }
  catch (error) { return response.status(403).json({ message: error instanceof Error ? error.message : '规则驳回失败' }); }
});
app.post('/api/rules/:ruleId/rollback', requireOperator, requireRuleAccess, (request, response) => {
  const targetVersion = Number(request.body?.targetVersion);
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) return response.status(400).json({ message: '目标版本无效' });
  try {
    const rule = ruleCatalog.rollback(routeParam(request, 'ruleId'), targetVersion, actorFromRequest(request));
    return response.json(rule);
  }
  catch (error) { return response.status(403).json({ message: error instanceof Error ? error.message : '规则回滚失败' }); }
});

app.post('/api/rules/:ruleId/enabled', requireOperator, requireRuleAccess, (request, response) => {
  if (typeof request.body?.enabled !== 'boolean') return response.status(400).json({ message: 'enabled 必须是布尔值' });
  try {
    const rule = ruleCatalog.setEnabled(routeParam(request, 'ruleId'), request.body.enabled, actorFromRequest(request));
    return response.json(rule);
  } catch (error) {
    return response.status(403).json({ message: error instanceof Error ? error.message : '规则启停失败' });
  }
});

app.put('/api/session/:id/lineup', requireOperator, (request, response) => {
  const productIds = request.body?.productIds;
  if (!Array.isArray(productIds) || !productIds.every((productId: unknown) => typeof productId === 'string')) return response.status(400).json({ message: '商品清单格式不正确' });
  const roomId = safeRoomId(request.body?.roomId);
  try {
    assertRoomAccess(identityFromRequest(request), roomId);
    const sessionId = routeParam(request, 'id');
    const session = sessions.get(sessionId);
    if (session) {
      if (session.roomId !== roomId) throw new Error('会话与直播间不匹配');
      session.setLineup(productIds, actorFromRequest(request));
      return response.json(session.state.lineup);
    }
    return response.json(productCatalog.setLineup(sessionId, roomId, productIds));
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '本场商品清单更新失败' });
  }
});

function networkOrigin(): string {
  const clientPort = existsSync(clientDir) ? port : Number(process.env.CLIENT_PORT ?? 5173);
  return `http://${getLanAddress()}:${clientPort}`;
}

app.get('/api/network', (_request, response) => {
  response.json({ origin: networkOrigin() });
});

app.post('/api/session/:id/display-link', requireOperator, requireSessionAccess, (request, response) => {
  const session = sessions.get(routeParam(request, 'id'));
  if (!session) return response.status(404).json({ message: 'session not found' });
  const link = displayLinks.getOrCreate(session.id, session.roomId);
  return response.json({ ...link, displayUrl: `${networkOrigin()}/screen/${link.alias}`, expiresInSeconds: Math.max(0, Math.ceil((link.expiresAt - Date.now()) / 1_000)) });
});

app.get('/api/session/:id', requireOperator, requireSessionAccess, (request, response) => {
  const session = sessions.get(routeParam(request, 'id'));
  if (!session) return response.status(404).json({ message: 'session not found' });
  return response.json(session.state);
});

app.get('/api/session/:id/timeline', requireOperator, requireSessionAccess, (request, response) => {
  const timeline = timelineStore.exportSession(routeParam(request, 'id'));
  if (!timeline) return response.status(404).json({ message: 'timeline not found' });
  return response.json(timeline);
});

app.get('/api/session/:id/timeline.jsonl', requireOperator, requireSessionAccess, (request, response) => {
  const sessionId = routeParam(request, 'id');
  const jsonLines = timelineStore.toJsonLines(sessionId);
  if (!jsonLines) return response.status(404).json({ message: 'timeline not found' });
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${sessionId}.timeline.jsonl"`);
  return response.send(jsonLines);
});

app.get('/api/session/:id/transcript.txt', requireOperator, requireSessionAccess, (request, response) => {
  const sessionId = routeParam(request, 'id');
  let transcript = timelineStore.readTranscript(sessionId);
  if (transcript === null) {
    try {
      timelineStore.refreshTranscriptSnapshot(sessionId);
      transcript = timelineStore.readTranscript(sessionId);
    } catch {
      transcript = null;
    }
  }
  if (transcript === null) return response.status(404).json({ message: '本地文案不存在' });
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${sessionId}.transcript.txt"`);
  return response.send(transcript);
});

app.patch('/api/session/:id/note', requireOperator, requireSessionAccess, (request, response) => {
  if (typeof request.body?.note !== 'string') return response.status(400).json({ message: '请提供场次备注' });
  const note = request.body.note.trim();
  if (note.length > 1_000) return response.status(400).json({ message: '场次备注不能超过 1000 个字符' });
  const sessionId = routeParam(request, 'id');
  if (!isEndedSession(sessionId)) return response.status(409).json({ message: '请结束本场直播后再修改场次备注' });
  try {
    timelineStore.updateSessionNote(sessionId, note, actorFromRequest(request));
    recordingArchiveQueue.stage(sessionId);
    const roomId = persistedSessionRoomId(sessionId);
    const summary = roomId ? timelineStore.listSessions(roomId).find((candidate) => candidate.sessionId === sessionId) : undefined;
    return summary ? response.json(historySummary(summary)) : response.status(404).json({ message: '直播记录不存在' });
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '场次备注保存失败' });
  }
});

app.post('/api/session/:id/archive', requireOperator, requireSessionAccess, (request, response) => {
  const sessionId = routeParam(request, 'id');
  if (!isEndedSession(sessionId)) return response.status(409).json({ message: '请结束本场直播后再确认上传' });
  if (!timelineStore.exportSession(sessionId)) return response.status(404).json({ message: '直播记录不存在' });
  if (!recordingArchiveQueue.status().configured) return response.status(503).json({ message: '知识库和数据库上传服务尚未配置' });
  recordingArchiveQueue.approve(sessionId, actorFromRequest(request));
  void recordingArchiveQueue.flush();
  const roomId = persistedSessionRoomId(sessionId);
  const summary = roomId ? timelineStore.listSessions(roomId).find((candidate) => candidate.sessionId === sessionId) : undefined;
  return summary ? response.status(202).json(historySummary(summary)) : response.status(404).json({ message: '直播记录不存在' });
});

app.patch('/api/session/:id/transcripts/:segmentId', requireOperator, requireSessionAccess, (request, response) => {
  if (!isEndedSession(routeParam(request, 'id'))) return response.status(409).json({ message: '请结束本场直播后再修改转录' });
  const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
  const speaker = request.body?.speaker === 'host' || request.body?.speaker === 'other' ? request.body.speaker : undefined;
  const speakerId = typeof request.body?.speakerId === 'string' && /^speaker-[1-4]$/u.test(request.body.speakerId) ? request.body.speakerId : undefined;
  if (request.body?.speaker !== undefined && !speaker) return response.status(400).json({ message: '说话人标记只能是主播或其他人' });
  if (request.body?.speakerId !== undefined && !speakerId) return response.status(400).json({ message: '说话人编号无效' });
  if (!text && !speaker) return response.status(400).json({ message: '请提供转录修正内容或说话人标记' });
  if (text.length > 2_000) return response.status(400).json({ message: '修正后的转录不能超过 2000 个字符' });
  const wrongText = typeof request.body?.wrongText === 'string' ? request.body.wrongText.trim() : undefined;
  const correctText = typeof request.body?.correctText === 'string' ? request.body.correctText.trim() : undefined;
  if ((wrongText && wrongText.length > 80) || (correctText && correctText.length > 80)) return response.status(400).json({ message: '单个纠错词不能超过 80 个字符' });
  const session = editableSession(routeParam(request, 'id'), actorFromRequest(request));
  if (!session) return response.status(404).json({ message: '直播会话尚未载入' });
  try {
    const segmentId = routeParam(request, 'segmentId');
    const corrected = text ? session.correctTranscript(segmentId, text, actorFromRequest(request), {
      learn: request.body?.learn === true,
      wrongText,
      correctText,
    }) : null;
    const segment = speaker ? session.annotateSpeaker(segmentId, speaker, actorFromRequest(request), speakerId) : corrected;
    return segment ? response.json({ segment }) : response.status(404).json({ message: '转录片段不存在' });
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '转录纠错失败' });
  }
});

function parseTrackIndex(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return null;
  const trackIndex = Number(value);
  return Number.isSafeInteger(trackIndex) ? trackIndex : null;
}

function streamAudio(sessionId: string, asWav: boolean, source: boolean, response: express.Response, trackIndex = 0): express.Response | void {
  if (sessions.get(sessionId)?.state.isListening) return response.status(409).json({ message: 'audio still recording' });
  const audioPath = source ? timelineStore.getSourceAudioPath(sessionId, trackIndex) : timelineStore.getAudioPath(sessionId);
  if (!audioPath) return response.status(404).json({ message: 'audio not found' });
  const audioSize = statSync(audioPath).size;
  response.setHeader('Content-Type', asWav ? 'audio/wav' : 'application/octet-stream');
  response.setHeader('Content-Disposition', `attachment; filename="${sessionId}.${source ? `source-audio-${trackIndex}` : 'audio'}.${asWav ? 'wav' : 'pcm'}"`);
  response.setHeader('Content-Length', String(audioSize + (asWav ? 44 : 0)));
  if (asWav) {
    const header = timelineStore.getWavHeader(sessionId, source, trackIndex);
    if (!header) return response.status(404).end();
    response.write(header);
  }
  createReadStream(audioPath).pipe(response);
}

app.get('/api/session/:id/audio.pcm', requireOperator, requireSessionAccess, (request, response) => streamAudio(routeParam(request, 'id'), false, false, response));
app.get('/api/session/:id/audio.wav', requireOperator, requireSessionAccess, (request, response) => streamAudio(routeParam(request, 'id'), true, false, response));
app.get('/api/session/:id/audio-source.pcm', requireOperator, requireSessionAccess, (request, response) => {
  const trackIndex = parseTrackIndex(request.query.track);
  return trackIndex === null ? response.status(400).json({ message: 'invalid audio track' }) : streamAudio(routeParam(request, 'id'), false, true, response, trackIndex);
});
app.get('/api/session/:id/audio-source.wav', requireOperator, requireSessionAccess, (request, response) => {
  const trackIndex = parseTrackIndex(request.query.track);
  return trackIndex === null ? response.status(400).json({ message: 'invalid audio track' }) : streamAudio(routeParam(request, 'id'), true, true, response, trackIndex);
});

if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get(/.*/, (_request, response) => response.sendFile(path.join(clientDir, 'index.html')));
}

server.on('upgrade', (request, socket, head) => {
  if (!request.url?.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wsServer.handleUpgrade(request, socket, head, (client) => wsServer.emit('connection', client, request));
});

wsServer.on('connection', (socket: WebSocket, request) => {
  websocketConnectionsAccepted += 1;
  let session: LiveSession | null = null;
  let role: 'operator' | 'display' = 'display';
  let actorId = 'owner';

  const sendError = (message: string) => socket.send(JSON.stringify({ type: 'system.error', message }));
  const denyCapture = () => socket.send(JSON.stringify({ type: 'capture.denied', message: '另一台控制台正在收音，本机保持只读监听' }));
  socket.on('message', (raw) => {
    try {
      if (raw.toString().length > 2_500_000) return sendError('消息过大，已忽略');
      const parsed: unknown = JSON.parse(raw.toString());
      if (!isClientMessage(parsed)) return sendError('收到无法识别的消息');
      const message = parsed;
      if (message.type === 'session.join') {
        if (session) {
          detachSessionClient(session, socket);
          session = null;
        }
        role = message.role;
        const displayLink = role === 'display' && message.displayAlias ? displayLinks.resolve(message.displayAlias) : null;
        if (role === 'display' && message.displayAlias && !displayLink) return sendError('主播屏二维码已过期，请从控制台重新打开二维码');
        const requestedRoomId = displayLink?.roomId ?? safeRoomId(message.roomId);
        const requestedSessionId = displayLink?.sessionId ?? message.sessionId;
        if (role === 'operator') {
          try {
            assertControlTransport(request);
            const identity = authService.authenticate({ token: message.token, claimedActorId: message.actorId, remoteAddress: request.socket.remoteAddress, origin: request.headers.origin });
            assertRoomAccess(identity, requestedRoomId);
            actorId = identity.actorId;
          } catch (error) {
            return sendError(error instanceof Error ? error.message : '身份认证失败');
          }
        } else {
          actorId = 'display';
          const persisted = requestedSessionId ? timelineStore.exportSession(requestedSessionId) : null;
          const persistedRoomId = persisted?.events.find((event) => event.type === 'session.created')?.payload.roomId;
          const displayCanJoin = canDisplayJoin(
            requestedSessionId,
            requestedRoomId,
            requestedSessionId ? sessions.get(requestedSessionId)?.roomId ?? null : null,
            typeof persistedRoomId === 'string' ? persistedRoomId : null,
          );
          if (!displayCanJoin) return sendError('主播屏链接无效，请从控制台重新打开主播屏');
        }
        session = getOrCreateSession(requestedSessionId, requestedRoomId, actorId, message.presenterId);
        const expiryTimer = sessionExpiryTimers.get(session.id);
        if (expiryTimer) clearTimeout(expiryTimer);
        sessionExpiryTimers.delete(session.id);
        session.addClient(socket, role);
        socket.send(JSON.stringify({ type: 'connection.ready', sessionId: session.id, products: session.products() }));
        socket.send(JSON.stringify({ type: 'state.snapshot', state: session.state }));
        return;
      }
      if (!session) return sendError('请先加入直播会话');
      if (role !== 'operator') return sendError('主播屏为只读模式');
      switch (message.type) {
        case 'control.start':
          if (session.state.captureState !== 'idle') return sendError('本场直播已经开始，请使用继续收音或新开一场直播');
          captureLeases.clear(session.id);
          if (!captureLeases.acquire(session.id, socket)) return denyCapture();
          session.startListening();
          break;
        case 'control.pause':
          if (!captureLeases.owns(session.id, socket)) return denyCapture();
          session.pauseListening();
          break;
        case 'control.resume':
          if (!captureLeases.owns(session.id, socket) && !captureLeases.acquire(session.id, socket)) return denyCapture();
          session.resumeListening();
          break;
        case 'control.end':
          if (!captureLeases.owns(session.id, socket) && !captureLeases.acquire(session.id, socket)) return denyCapture();
          session.endLive();
          captureLeases.release(session.id, socket);
          break;
        case 'control.stop':
          if (!captureLeases.owns(session.id, socket)) return denyCapture();
          session.endLive();
          captureLeases.release(session.id, socket);
          break;
        case 'product.select':
          session.selectProduct(message.productId);
          break;
        case 'lineup.set':
          session.setLineup(message.productIds, actorId);
          break;
        case 'risk.profile':
          session.setRiskProfile(message.profile, actorId);
          break;
        case 'presenter.select': {
          const presenter = phraseLibrary.getPresenter(message.presenterId);
          if (!presenter || presenter.roomId !== session.roomId) return sendError('主播档案不存在或不属于当前直播间');
          session.setPresenter(presenter, actorId);
          break;
        }
        case 'audio':
          if (!captureLeases.owns(session.id, socket)) break;
          session.ingestAudio(Buffer.from(message.data, 'base64'));
          break;
        case 'audio.raw':
          if (!captureLeases.owns(session.id, socket)) break;
          session.ingestSourceAudio(Buffer.from(message.data, 'base64'), message.sampleRate);
          break;
        case 'demo.transcript':
          session.ingestTranscript(message.text, true);
          break;
        case 'transcript.correct':
          session.correctTranscript(message.segmentId, message.text, actorId, message);
          break;
        case 'transcript.speaker':
          session.annotateSpeaker(message.segmentId, message.speaker, actorId, message.speakerId);
          break;
        default:
          break;
      }
    } catch {
      sendError('收到无法识别的消息');
    }
  });
  socket.on('close', () => {
    if (!session) return;
    detachSessionClient(session, socket);
    session = null;
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Live compliance server listening on http://0.0.0.0:${port}`);
});
