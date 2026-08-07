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
import { parseProductText } from './productParser';
import { AuthService, allowsControlTransport, canAccessRoom, type AuthIdentity } from './auth';
import { readSessionIdleTtlMs } from './config';
import { canDisplayJoin, CaptureLease } from './sessionAccess';
import { createKnowledgeBase } from './knowledgeBase';
import { FileKnowledgeSyncQueue } from './knowledgeSync';
import { createRecordingArchiveQueue } from './recordingArchive';
import { createDoubaoAnalyzer } from './services';
import type { ClientMessage, ComplianceRuleScope, RiskLevel, Product } from '../src/shared/types';

const app = express();
const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true });
const sessions = new Map<string, LiveSession>();
const port = Number(process.env.PORT ?? 8787);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(projectRoot, '../dist/client');
const timelineStore = new FileTimelineStore(process.env.TIMELINE_DATA_DIR ?? path.resolve(projectRoot, '../.data/timeline'));
const productCatalog = new FileProductCatalog(process.env.PRODUCT_CATALOG_PATH ?? path.resolve(projectRoot, '../.data/products/catalog.json'));
const ruleCatalog = new FileRuleCatalog(productCatalog, process.env.RULE_CATALOG_PATH ?? path.resolve(projectRoot, '../.data/rules/catalog.json'));
const authService = new AuthService(process.env);
const requestIdentities = new WeakMap<express.Request, AuthIdentity>();
const loginAttempts = new Map<string, { failures: number; blockedUntil: number }>();
const sessionExpiryTimers = new Map<string, NodeJS.Timeout>();
const captureLeases = new CaptureLease<WebSocket>();
const sessionIdleTtlMs = readSessionIdleTtlMs(process.env);
const allowInsecureAuth = process.env.ALLOW_INSECURE_AUTH === 'true';
const knowledgeBase = createKnowledgeBase();
const complianceAnalyzer = createDoubaoAnalyzer(process.env, knowledgeBase);
const knowledgeSyncQueue = new FileKnowledgeSyncQueue(knowledgeBase, process.env.KNOWLEDGE_SYNC_PATH ?? path.resolve(projectRoot, '../.data/knowledge/sync.json'));
const knowledgeSyncTimer = setInterval(() => { void knowledgeSyncQueue.flush(); }, 5_000);
knowledgeSyncTimer.unref();
const recordingArchiveQueue = createRecordingArchiveQueue(timelineStore, process.env, (sessionId) => !sessions.get(sessionId)?.state.isListening);
const recordingArchiveTimer = setInterval(() => { void recordingArchiveQueue.flush(); }, 10_000);
recordingArchiveTimer.unref();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

function safeRoomId(value: unknown): string {
  return typeof value === 'string' && /^room-[a-z0-9-]{4,64}$/u.test(value) ? value : 'room-default';
}

function getOrCreateSession(id?: string, roomId = 'room-default', actorId = 'owner'): LiveSession {
  const safeId = id && /^live-[a-z0-9-]{4,32}$/u.test(id) ? id : undefined;
  if (safeId && sessions.has(safeId)) {
    const existing = sessions.get(safeId)!;
    if (existing.roomId === roomId) return existing;
  }
  const session = new LiveSession(safeId && !sessions.has(safeId) ? safeId : undefined, { timelineStore, productCatalog, ruleCatalog, archiveQueue: recordingArchiveQueue, analyzer: complianceAnalyzer, roomId, actorId });
  sessions.set(session.id, session);
  return session;
}

function detachSessionClient(session: LiveSession, socket: WebSocket): void {
  if (captureLeases.release(session.id, socket)) session.stopListening();
  session.removeClient(socket);
  if (session.clientCount !== 0) return;
  session.stopListening();
  const existingTimer = sessionExpiryTimers.get(session.id);
  if (existingTimer) clearTimeout(existingTimer);
  const sessionId = session.id;
  const timer = setTimeout(() => {
    if (sessions.get(sessionId)?.clientCount === 0) sessions.delete(sessionId);
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
        && (message.actorId === undefined || typeof message.actorId === 'string')
        && (message.token === undefined || typeof message.token === 'string')
        && (message.role === 'operator' || message.role === 'display');
    case 'control.start':
    case 'control.stop':
      return true;
    case 'product.select':
      return typeof message.productId === 'string' && message.productId.length <= 64;
    case 'lineup.set':
      return Array.isArray(message.productIds) && message.productIds.length <= 100 && message.productIds.every((productId) => typeof productId === 'string' && productId.length <= 64);
    case 'audio':
      return typeof message.data === 'string' && message.data.length <= 2_000_000;
    case 'audio.raw':
      return typeof message.data === 'string' && message.data.length <= 6_000_000 && typeof message.sampleRate === 'number' && Number.isInteger(message.sampleRate) && message.sampleRate >= 8_000 && message.sampleRate <= 96_000;
    case 'demo.transcript':
      return typeof message.text === 'string' && message.text.trim().length > 0 && message.text.length <= 2_000;
    case 'transcript.correct':
      return typeof message.segmentId === 'string' && message.segmentId.length <= 128 && typeof message.text === 'string' && message.text.trim().length > 0 && message.text.length <= 2_000;
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
  response.json({ ok: true, sessions: sessions.size, rooms: productCatalog.listRooms().length, volcConfigured: Boolean(process.env.VOLC_SPEECH_APP_KEY && process.env.VOLC_SPEECH_ACCESS_KEY), doubaoConfigured: Boolean(process.env.DOUBAO_API_KEY && process.env.DOUBAO_ENDPOINT_ID), authMode: authService.configured ? 'multi-user' : 'local-only' });
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

function persistedSessionRoomId(sessionId: string): string | null {
  const roomId = timelineStore.exportSession(sessionId)?.events.find((event) => event.type === 'session.created')?.payload.roomId;
  return typeof roomId === 'string' ? roomId : null;
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
  const volcConfigured = Boolean(process.env.VOLC_SPEECH_APP_KEY && process.env.VOLC_SPEECH_ACCESS_KEY);
  const doubaoConfigured = Boolean(process.env.DOUBAO_API_KEY && process.env.DOUBAO_ENDPOINT_ID);
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  const archiveStatus = recordingArchiveQueue.status();
  const objectStorageConfigured = archiveStatus.configured;
  const redisConfigured = Boolean(process.env.REDIS_URL);
  const knowledge = knowledgeBase.status();
  const knowledgeSync = knowledgeSyncQueue.status();
  const liveConfigured = volcConfigured && doubaoConfigured;
  const productionConfigured = liveConfigured && authService.configured && databaseConfigured && objectStorageConfigured && redisConfigured && knowledge.configured && knowledgeSync.configured;
  response.json({
    readyForLive: liveConfigured,
    readyForProduction: productionConfigured,
    mode: productionConfigured ? 'production' : liveConfigured ? 'live-with-local-persistence' : 'demo',
    speech: { configured: volcConfigured, label: volcConfigured ? '火山语音参数已填写' : '火山实时语音待配置' },
    doubao: { configured: doubaoConfigured, label: doubaoConfigured ? '豆包参数已填写' : '豆包合规模型待配置' },
    auth: { configured: authService.configured, label: authService.configured ? '多人身份已保护' : '仅限本机控制' },
    storage: { configured: databaseConfigured && objectStorageConfigured, label: databaseConfigured && objectStorageConfigured ? '数据库 + 对象存储已配置' : '本地文件存储（生产存储待配置）' },
    database: { configured: databaseConfigured, label: databaseConfigured ? '业务数据库参数已填写' : '业务数据库待配置' },
    objectStorage: { configured: objectStorageConfigured, label: objectStorageConfigured ? 'TOS 原始音频归档已配置' : 'TOS 原始音频归档待配置', status: archiveStatus },
    redis: { configured: redisConfigured, label: redisConfigured ? 'Redis 会话协调已配置' : 'Redis 会话协调待配置' },
    knowledge,
    knowledgeSync,
  });
});

function scheduleKnowledgeSync(rule: Parameters<typeof knowledgeSyncQueue.enqueue>[0]): void {
  const operation = rule.status === 'published' ? undefined : ruleCatalog.versions(rule.id).some((version) => version.status === 'published') ? 'remove' : null;
  if (operation === null) return;
  knowledgeSyncQueue.enqueue(rule, productCatalog.getRoom(rule.roomId) ?? undefined, operation);
  void knowledgeSyncQueue.flush();
}

app.get('/api/knowledge/status', requireOperator, (_request, response) => response.json({ knowledge: knowledgeBase.status(), sync: knowledgeSyncQueue.status() }));

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

app.post('/api/rooms/:roomId/rules', requireOperator, requireRoomAccess, (request, response) => {
  const input = readRuleInput(request.body);
  if (!input) return response.status(400).json({ message: '规则资料格式不完整' });
  try {
    const rule = ruleCatalog.create(routeParam(request, 'roomId'), actorFromRequest(request), input);
    scheduleKnowledgeSync(rule);
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
    scheduleKnowledgeSync(rule);
    return response.json(rule);
  }
  catch (error) { return response.status(403).json({ message: error instanceof Error ? error.message : '规则更新失败' }); }
});
app.post('/api/rules/:ruleId/approve', requireOperator, requireRuleAccess, (request, response) => {
  try {
    const rule = ruleCatalog.approve(routeParam(request, 'ruleId'), actorFromRequest(request));
    scheduleKnowledgeSync(rule);
    return response.json(rule);
  }
  catch (error) { return response.status(403).json({ message: error instanceof Error ? error.message : '规则审核失败' }); }
});
app.post('/api/rules/:ruleId/reject', requireOperator, requireRuleAccess, (request, response) => {
  try {
    const rule = ruleCatalog.reject(routeParam(request, 'ruleId'), actorFromRequest(request), String(request.body?.reason ?? ''));
    scheduleKnowledgeSync(rule);
    return response.json(rule);
  }
  catch (error) { return response.status(403).json({ message: error instanceof Error ? error.message : '规则驳回失败' }); }
});
app.post('/api/rules/:ruleId/rollback', requireOperator, requireRuleAccess, (request, response) => {
  const targetVersion = Number(request.body?.targetVersion);
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) return response.status(400).json({ message: '目标版本无效' });
  try {
    const rule = ruleCatalog.rollback(routeParam(request, 'ruleId'), targetVersion, actorFromRequest(request));
    scheduleKnowledgeSync(rule);
    return response.json(rule);
  }
  catch (error) { return response.status(403).json({ message: error instanceof Error ? error.message : '规则回滚失败' }); }
});

app.post('/api/rules/:ruleId/enabled', requireOperator, requireRuleAccess, (request, response) => {
  if (typeof request.body?.enabled !== 'boolean') return response.status(400).json({ message: 'enabled 必须是布尔值' });
  try {
    const rule = ruleCatalog.setEnabled(routeParam(request, 'ruleId'), request.body.enabled, actorFromRequest(request));
    scheduleKnowledgeSync(rule);
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

app.get('/api/network', (_request, response) => {
  const clientPort = existsSync(clientDir) ? port : Number(process.env.CLIENT_PORT ?? 5173);
  response.json({ origin: `http://${getLanAddress()}:${clientPort}` });
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
        const requestedRoomId = safeRoomId(message.roomId);
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
          const persisted = message.sessionId ? timelineStore.exportSession(message.sessionId) : null;
          const persistedRoomId = persisted?.events.find((event) => event.type === 'session.created')?.payload.roomId;
          const displayCanJoin = canDisplayJoin(
            message.sessionId,
            requestedRoomId,
            message.sessionId ? sessions.get(message.sessionId)?.roomId ?? null : null,
            typeof persistedRoomId === 'string' ? persistedRoomId : null,
          );
          if (!displayCanJoin) return sendError('主播屏链接无效，请从控制台重新打开主播屏');
        }
        session = getOrCreateSession(message.sessionId, requestedRoomId, actorId);
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
          if (!session.state.isListening) captureLeases.clear(session.id);
          if (!captureLeases.acquire(session.id, socket)) return denyCapture();
          session.startListening();
          break;
        case 'control.stop':
          if (!captureLeases.owns(session.id, socket)) return denyCapture();
          session.stopListening();
          captureLeases.release(session.id, socket);
          break;
        case 'product.select':
          session.selectProduct(message.productId);
          break;
        case 'lineup.set':
          session.setLineup(message.productIds, actorId);
          break;
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
          session.correctTranscript(message.segmentId, message.text, actorId);
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
