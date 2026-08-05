import 'dotenv/config';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, type WebSocket } from 'ws';
import { LiveSession } from './session';
import { PRODUCTS } from '../src/shared/products';
import type { ClientMessage } from '../src/shared/types';

const app = express();
const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true });
const sessions = new Map<string, LiveSession>();
const port = Number(process.env.PORT ?? 8787);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(projectRoot, '../dist/client');

app.use(cors());
app.use(express.json({ limit: '2mb' }));

function getOrCreateSession(id?: string): LiveSession {
  const safeId = id && /^live-[a-z0-9-]{4,32}$/u.test(id) ? id : undefined;
  if (safeId && sessions.has(safeId)) return sessions.get(safeId)!;
  const session = new LiveSession(safeId);
  sessions.set(session.id, session);
  return session;
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'session.join':
      return (message.sessionId === undefined || (typeof message.sessionId === 'string' && message.sessionId.length <= 64)) && (message.role === 'operator' || message.role === 'display');
    case 'control.start':
    case 'control.stop':
      return true;
    case 'product.select':
      return typeof message.productId === 'string' && message.productId.length <= 64;
    case 'audio':
      return typeof message.data === 'string' && message.data.length <= 2_000_000;
    case 'demo.transcript':
      return typeof message.text === 'string' && message.text.trim().length > 0 && message.text.length <= 2_000;
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
  response.json({ ok: true, sessions: sessions.size, volcConfigured: Boolean(process.env.VOLC_SPEECH_APP_KEY && process.env.VOLC_SPEECH_ACCESS_KEY), doubaoConfigured: Boolean(process.env.DOUBAO_API_KEY && process.env.DOUBAO_ENDPOINT_ID) });
});

app.get('/api/products', (_request, response) => {
  response.json(PRODUCTS);
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

  const sendError = (message: string) => socket.send(JSON.stringify({ type: 'system.error', message }));
  socket.on('message', (raw) => {
    try {
      if (raw.toString().length > 2_500_000) return sendError('消息过大，已忽略');
      const parsed: unknown = JSON.parse(raw.toString());
      if (!isClientMessage(parsed)) return sendError('收到无法识别的消息');
      const message = parsed;
      if (message.type === 'session.join') {
        if (session) session.removeClient(socket);
        session = getOrCreateSession(message.sessionId);
        role = message.role;
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
        case 'audio':
          session.ingestAudio(Buffer.from(message.data, 'base64'));
          break;
        case 'demo.transcript':
          session.ingestTranscript(message.text, true);
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
