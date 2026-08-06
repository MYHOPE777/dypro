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

app.use(cors());
app.use(express.json({ limit: '2mb' }));

function safeActorId(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/u.test(value) ? value : 'owner';
}

function safeRoomId(value: unknown): string {
  return typeof value === 'string' && /^room-[a-z0-9-]{4,64}$/u.test(value) ? value : 'room-default';
}

function getOrCreateSession(id?: string, roomId = 'room-default', actorId = 'owner'): LiveSession {
  const safeId = id && /^live-[a-z0-9-]{4,32}$/u.test(id) ? id : undefined;
  if (safeId && sessions.has(safeId)) return sessions.get(safeId)!;
  const session = new LiveSession(safeId, { timelineStore, productCatalog, ruleCatalog, roomId, actorId });
  sessions.set(session.id, session);
  return session;
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'session.join':
      return (message.sessionId === undefined || (typeof message.sessionId === 'string' && message.sessionId.length <= 64))
        && (message.roomId === undefined || typeof message.roomId === 'string')
        && (message.actorId === undefined || typeof message.actorId === 'string')
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
  response.json({ ok: true, sessions: sessions.size, rooms: productCatalog.listRooms().length, volcConfigured: Boolean(process.env.VOLC_SPEECH_APP_KEY && process.env.VOLC_SPEECH_ACCESS_KEY), doubaoConfigured: Boolean(process.env.DOUBAO_API_KEY && process.env.DOUBAO_ENDPOINT_ID) });
});

function actorFromRequest(request: express.Request): string {
  return safeActorId(request.header('x-actor-id') ?? (request.body as Record<string, unknown> | undefined)?.actorId);
}

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

app.get('/api/rooms', (_request, response) => response.json(productCatalog.listRooms()));

app.post('/api/rooms', (request, response) => {
  try {
    const room = productCatalog.createRoom({ name: String(request.body?.name ?? ''), accountName: String(request.body?.accountName ?? ''), ownerActorId: actorFromRequest(request) });
    return response.status(201).json(room);
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '直播间创建失败' });
  }
});

app.get('/api/rooms/:roomId', (request, response) => {
  const room = productCatalog.getRoom(request.params.roomId);
  return room ? response.json(room) : response.status(404).json({ message: '直播间不存在' });
});

app.get('/api/rooms/:roomId/products', (request, response) => {
  try {
    return response.json(productCatalog.list(request.params.roomId));
  } catch (error) {
    return response.status(404).json({ message: error instanceof Error ? error.message : '商品库读取失败' });
  }
});

app.get('/api/products', (_request, response) => response.json(productCatalog.list('room-default')));

app.post('/api/products/parse', async (request, response) => {
  try {
    const text = typeof request.body?.text === 'string' ? request.body.text : '';
    return response.json(await parseProductText(text));
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '商品信息解析失败' });
  }
});

app.post('/api/rooms/:roomId/products', (request, response) => {
  if (!isProductPayload(request.body?.product)) return response.status(400).json({ message: '商品资料格式不完整' });
  try {
    return response.status(201).json(productCatalog.upsert(request.params.roomId, request.body.product));
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '商品保存失败' });
  }
});

app.get('/api/rooms/:roomId/rules', (request, response) => response.json(ruleCatalog.list(request.params.roomId)));
app.get('/api/rooms/:roomId/rules/audits', (request, response) => response.json(ruleCatalog.audits(request.params.roomId)));

app.post('/api/rooms/:roomId/rules', (request, response) => {
  const input = readRuleInput(request.body);
  if (!input) return response.status(400).json({ message: '规则资料格式不完整' });
  try {
    return response.status(201).json(ruleCatalog.create(request.params.roomId, actorFromRequest(request), input));
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '规则保存失败' });
  }
});

app.get('/api/rules/:ruleId/versions', (request, response) => response.json(ruleCatalog.versions(request.params.ruleId)));
app.patch('/api/rules/:ruleId', (request, response) => {
  const input = readRuleInput(request.body);
  if (!input) return response.status(400).json({ message: '规则资料格式不完整' });
  try { return response.json(ruleCatalog.update(request.params.ruleId, actorFromRequest(request), input)); }
  catch (error) { return response.status(403).json({ message: error instanceof Error ? error.message : '规则更新失败' }); }
});
app.post('/api/rules/:ruleId/approve', (request, response) => {
  try { return response.json(ruleCatalog.approve(request.params.ruleId, actorFromRequest(request))); }
  catch (error) { return response.status(403).json({ message: error instanceof Error ? error.message : '规则审核失败' }); }
});
app.post('/api/rules/:ruleId/reject', (request, response) => {
  try { return response.json(ruleCatalog.reject(request.params.ruleId, actorFromRequest(request), String(request.body?.reason ?? ''))); }
  catch (error) { return response.status(403).json({ message: error instanceof Error ? error.message : '规则驳回失败' }); }
});
app.post('/api/rules/:ruleId/rollback', (request, response) => {
  const targetVersion = Number(request.body?.targetVersion);
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) return response.status(400).json({ message: '目标版本无效' });
  try { return response.json(ruleCatalog.rollback(request.params.ruleId, targetVersion, actorFromRequest(request))); }
  catch (error) { return response.status(403).json({ message: error instanceof Error ? error.message : '规则回滚失败' }); }
});

app.put('/api/session/:id/lineup', (request, response) => {
  const productIds = request.body?.productIds;
  if (!Array.isArray(productIds) || !productIds.every((productId: unknown) => typeof productId === 'string')) return response.status(400).json({ message: '商品清单格式不正确' });
  const roomId = safeRoomId(request.body?.roomId);
  try {
    const session = sessions.get(request.params.id);
    if (session) {
      session.setLineup(productIds, actorFromRequest(request));
      return response.json(session.state.lineup);
    }
    return response.json(productCatalog.setLineup(request.params.id, roomId, productIds));
  } catch (error) {
    return response.status(400).json({ message: error instanceof Error ? error.message : '本场商品清单更新失败' });
  }
});

app.get('/api/network', (_request, response) => {
  const clientPort = existsSync(clientDir) ? port : Number(process.env.CLIENT_PORT ?? 5173);
  response.json({ origin: `http://${getLanAddress()}:${clientPort}` });
});

app.get('/api/session/:id', (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) return response.status(404).json({ message: 'session not found' });
  return response.json(session.state);
});

app.get('/api/session/:id/timeline', (request, response) => {
  const timeline = timelineStore.exportSession(request.params.id);
  if (!timeline) return response.status(404).json({ message: 'timeline not found' });
  return response.json(timeline);
});

app.get('/api/session/:id/timeline.jsonl', (request, response) => {
  const jsonLines = timelineStore.toJsonLines(request.params.id);
  if (!jsonLines) return response.status(404).json({ message: 'timeline not found' });
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${request.params.id}.timeline.jsonl"`);
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

app.get('/api/session/:id/audio.pcm', (request, response) => streamAudio(request.params.id, false, false, response));
app.get('/api/session/:id/audio.wav', (request, response) => streamAudio(request.params.id, true, false, response));
app.get('/api/session/:id/audio-source.pcm', (request, response) => {
  const trackIndex = parseTrackIndex(request.query.track);
  return trackIndex === null ? response.status(400).json({ message: 'invalid audio track' }) : streamAudio(request.params.id, false, true, response, trackIndex);
});
app.get('/api/session/:id/audio-source.wav', (request, response) => {
  const trackIndex = parseTrackIndex(request.query.track);
  return trackIndex === null ? response.status(400).json({ message: 'invalid audio track' }) : streamAudio(request.params.id, true, true, response, trackIndex);
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

wsServer.on('connection', (socket: WebSocket) => {
  let session: LiveSession | null = null;
  let role: 'operator' | 'display' = 'display';
  let actorId = 'owner';

  const sendError = (message: string) => socket.send(JSON.stringify({ type: 'system.error', message }));
  socket.on('message', (raw) => {
    try {
      if (raw.toString().length > 2_500_000) return sendError('消息过大，已忽略');
      const parsed: unknown = JSON.parse(raw.toString());
      if (!isClientMessage(parsed)) return sendError('收到无法识别的消息');
      const message = parsed;
      if (message.type === 'session.join') {
        if (session) session.removeClient(socket);
        session = getOrCreateSession(message.sessionId, safeRoomId(message.roomId), safeActorId(message.actorId));
        role = message.role;
        actorId = safeActorId(message.actorId);
        session.addClient(socket, role);
        socket.send(JSON.stringify({ type: 'connection.ready', sessionId: session.id, products: session.products() }));
        socket.send(JSON.stringify({ type: 'state.snapshot', state: session.state }));
        return;
      }
      if (!session) return sendError('请先加入直播会话');
      if (role !== 'operator') return sendError('主播屏为只读模式');
      switch (message.type) {
        case 'control.start':
          session.startListening();
          break;
        case 'control.stop':
          session.stopListening();
          break;
        case 'product.select':
          session.selectProduct(message.productId);
          break;
        case 'lineup.set':
          session.setLineup(message.productIds, actorId);
          break;
        case 'audio':
          session.ingestAudio(Buffer.from(message.data, 'base64'));
          break;
        case 'audio.raw':
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
    session.removeClient(socket);
    if (session.clientCount === 0) {
      session.stopListening();
      sessions.delete(session.id);
    }
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Live compliance server listening on http://0.0.0.0:${port}`);
});
