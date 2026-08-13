import { existsSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { WebSocketServer, type WebSocket } from 'ws';
import type { LiveCommand } from '../../src/shared/v2';
import type { CoachPurpose, ComplianceResult, Product, ProductComplianceProfile } from '../../src/shared/types';
import type { V2ClientCommand, V2ClientFrame, V2JoinCommand, V2ServerFrame } from '../../src/shared/v2Protocol';
import { decodeAudioFrame } from '../../src/shared/v2Audio';
import { createRuntime, type V2Runtime } from './runtime';
import { CaptureLease } from '../sessionAccess';
import type { AuthIdentity } from '../auth';
import { wavHeader } from './audio';

type V2Request = Request & { v2Identity?: AuthIdentity };

function identity(request: Request): AuthIdentity {
  const value = (request as V2Request).v2Identity;
  if (!value) throw new Error('请先登录控制台');
  return value;
}

function actorId(request: Request): string {
  return identity(request).actorId;
}

function bearerToken(request: Request): string | undefined {
  const header = request.header('authorization')?.trim();
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || undefined : undefined;
}

function bodyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name}不能为空`);
  return value.trim();
}

function coachPurpose(value: unknown): CoachPurpose | undefined {
  return typeof value === 'string' && ['塑品', '憋单', '逼单', '转化', '互动', '留人', '答疑'].includes(value) ? value as CoachPurpose : undefined;
}

function productText(value: unknown, name: string, maximum: number): string {
  const text = bodyString(value, name);
  if (text.length > maximum) throw new Error(`${name}不能超过 ${maximum} 个字符`);
  return text;
}

function optionalProductText(value: unknown, name: string, maximum: number): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${name}格式无效`);
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${name}不能超过 ${maximum} 个字符`);
  return text;
}

function productTextList(value: unknown, name: string, maximumItems = 20): string[] {
  if (!Array.isArray(value) || value.length > maximumItems || value.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 200)) throw new Error(`${name}格式无效`);
  return value.map((item) => (item as string).trim());
}

function productComplianceProfile(value: unknown): ProductComplianceProfile | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object') throw new Error('商品合规资料格式无效');
  const profile = value as Record<string, unknown>;
  const confidence = typeof profile.confidence === 'number' && Number.isFinite(profile.confidence) ? Math.max(0, Math.min(1, profile.confidence)) : 1;
  return {
    industry: productText(profile.industry, '所属行业', 80),
    category: productText(profile.category, '标准类目', 80),
    platformRuleset: 'douyin-ecommerce-live',
    complianceSummary: productText(profile.complianceSummary, '合规资料描述', 500),
    riskKeywords: productTextList(profile.riskKeywords, '高风险词'),
    riskBoundaries: productTextList(profile.riskBoundaries, '语义风险边界'),
    requiredDisclosures: productTextList(profile.requiredDisclosures, '必要披露'),
    safeSellingPoints: productTextList(profile.safeSellingPoints, '合规介绍方向'),
    confidence,
    source: profile.source === 'doubao' || profile.source === 'local-fallback' ? profile.source : 'manual',
    status: profile.status === 'generated' || profile.status === 'needs_review' ? profile.status : 'verified',
    updatedAt: Date.now(),
  };
}

function productInput(productId: string, value: unknown): Product {
  if (!/^[a-zA-Z0-9_-]{1,96}$/u.test(productId) || !value || typeof value !== 'object') throw new Error('商品资料格式无效');
  const product = value as Record<string, unknown>;
  const stock = product.stock === null ? null : typeof product.stock === 'number' && Number.isInteger(product.stock) && product.stock >= 0 ? product.stock : null;
  const complianceProfile = productComplianceProfile(product.complianceProfile);
  return {
    id: productId,
    name: productText(product.name, '商品名称', 120),
    category: productText(product.category, '商品分类', 80),
    price: productText(product.price, '商品价格', 40),
    stock,
    sku: productText(product.sku, '商品编码', 96),
    description: optionalProductText(product.description, '商品描述', 1_000),
    sellingPoints: productTextList(product.sellingPoints, '商品卖点'),
    compliantPhrases: productTextList(product.compliantPhrases, '参考话术'),
    ...(complianceProfile ? { complianceProfile } : {}),
    image: typeof product.image === 'string' && product.image.trim().length <= 500 ? product.image.trim() : '/products/serum.svg',
    accent: typeof product.accent === 'string' && product.accent.trim().length <= 64 ? product.accent.trim() : '#8da57d',
    source: 'manual',
    ...(typeof product.sourceText === 'string' && product.sourceText.trim() ? { sourceText: product.sourceText.trim().slice(0, 4_000) } : {}),
    updatedAt: Date.now(),
  };
}

function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function jsonError(response: Response, error: unknown, status = 400): void {
  response.status(status).json({ message: error instanceof Error ? error.message : String(error) });
}

function isLiveCommand(value: unknown): value is LiveCommand {
  if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return false;
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case 'start': case 'pause': case 'resume': case 'end': case 'stop': return true;
    case 'select_product': return typeof command.productId === 'string' && command.productId.length <= 96 && (command.source === undefined || command.source === 'operator' || command.source === 'speech');
    case 'set_lineup': return Array.isArray(command.productIds) && command.productIds.length <= 100 && command.productIds.every((id) => typeof id === 'string' && id.length <= 96);
    case 'set_risk_profile': return command.profile === 'strict' || command.profile === 'balanced' || command.profile === 'optimized';
    case 'select_presenter': return typeof command.presenterId === 'string' && command.presenterId.length <= 96;
    case 'demo_transcript': return typeof command.text === 'string' && command.text.trim().length > 0 && command.text.length <= 4_000 && (command.isFinal === undefined || typeof command.isFinal === 'boolean');
    case 'transcript_correct': return typeof command.segmentId === 'string' && command.segmentId.length <= 160 && typeof command.text === 'string' && command.text.trim().length > 0 && command.text.length <= 4_000;
    case 'assign_speaker': return typeof command.segmentId === 'string' && command.segmentId.length <= 160 && (command.speaker === 'host' || command.speaker === 'other') && (command.speakerId === undefined || (typeof command.speakerId === 'string' && command.speakerId.length <= 96));
    default: return false;
  }
}

function isJoinCommand(value: unknown): value is V2JoinCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Record<string, unknown>;
  return command.type === 'session.join'
    && (command.role === 'operator' || command.role === 'display')
    && (command.sessionId === undefined || (typeof command.sessionId === 'string' && command.sessionId.length <= 96))
    && (command.roomId === undefined || (typeof command.roomId === 'string' && command.roomId.length <= 96))
    && (command.presenterId === undefined || (typeof command.presenterId === 'string' && command.presenterId.length <= 96))
    && (command.token === undefined || (typeof command.token === 'string' && command.token.length <= 4_096))
    && (command.displayAlias === undefined || (typeof command.displayAlias === 'string' && /^[A-Z0-9]{8}$/u.test(command.displayAlias)))
    && (command.actorId === undefined || (typeof command.actorId === 'string' && command.actorId.length <= 96));
}

export type V2Http = { app: express.Express; server: http.Server; wsServer: WebSocketServer; close(): Promise<void> };

export function createV2Http(runtime: V2Runtime, options: { clientDir?: string } = {}): V2Http {
  const app = express();
  const server = http.createServer(app);
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  const clientDir = options.clientDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/client');
  const sockets = new WeakMap<WebSocket, { sessionId: string; roomId: string; identity: AuthIdentity | null; role: 'operator' | 'display'; unsubscribe: () => void; sequence: number }>();
  const clients = new Set<WebSocket>();
  const captureLeases = new CaptureLease<WebSocket>();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/v2/health', (_request, response) => response.json({ ok: true, rooms: runtime.listRooms().length, sessions: runtime.listSessions().length, scheduler: runtime.scheduler.snapshot(), db: runtime.store.filename }));
  app.post('/api/v2/auth/login', (request, response) => {
    try {
      runtime.authorization.assertControlTransport({ encrypted: Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted), remoteAddress: request.socket.remoteAddress, forwardedProto: request.header('x-forwarded-proto') });
      response.json(runtime.authorization.login(bodyString(request.body?.actorId, '账号'), bodyString(request.body?.password, '密码')));
    } catch (error) { jsonError(response, error, 401); }
  });
  app.use('/api/v2', (request, response, next) => {
    try {
      runtime.authorization.assertControlTransport({ encrypted: Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted), remoteAddress: request.socket.remoteAddress, forwardedProto: request.header('x-forwarded-proto') });
      (request as V2Request).v2Identity = runtime.authorization.authenticate({ token: bearerToken(request), claimedActorId: request.header('x-actor-id'), remoteAddress: request.socket.remoteAddress, origin: request.header('origin') });
      next();
    } catch (error) { jsonError(response, error, 401); }
  });
  app.get('/api/v2/rooms', (request, response) => {
    const current = identity(request);
    response.json(runtime.listRooms().filter((room) => current.role === 'reviewer' || current.roomIds.includes(room.id) || room.ownerActorId === current.actorId));
  });
  app.get('/api/v2/rooms/:roomId/products', (request, response) => {
    try { const roomId = routeParam(request, 'roomId'); runtime.authorization.assert(identity(request), roomId, 'view'); response.json(runtime.listProducts(roomId)); } catch (error) { jsonError(response, error, 403); }
  });
  app.put('/api/v2/rooms/:roomId/products/:productId', async (request, response) => {
    try { const roomId = routeParam(request, 'roomId'); runtime.authorization.assert(identity(request), roomId, 'control'); response.json(await runtime.upsertProduct(roomId, productInput(routeParam(request, 'productId'), request.body))); } catch (error) { jsonError(response, error); }
  });
  app.post('/api/v2/rooms/:roomId/products/:productId/compliance-profile/generate', async (request, response) => {
    try { const roomId = routeParam(request, 'roomId'); runtime.authorization.assert(identity(request), roomId, 'control'); response.json(await runtime.profileProduct(roomId, routeParam(request, 'productId'))); } catch (error) { jsonError(response, error); }
  });
  app.delete('/api/v2/rooms/:roomId/products/:productId', async (request, response) => {
    try { const roomId = routeParam(request, 'roomId'); runtime.authorization.assert(identity(request), roomId, 'control'); response.json(await runtime.removeProduct(roomId, routeParam(request, 'productId'))); } catch (error) { jsonError(response, error); }
  });
  app.get('/api/v2/rooms/:roomId/rules', (request, response) => {
    try { const roomId = routeParam(request, 'roomId'); runtime.authorization.assert(identity(request), roomId, 'view'); response.json({ rules: runtime.rules.list(roomId), audits: runtime.rules.audits(roomId) }); } catch (error) { jsonError(response, error, 403); }
  });
  app.post('/api/v2/rooms/:roomId/rules', (request, response) => {
    try {
      const roomId = routeParam(request, 'roomId'); runtime.authorization.assert(identity(request), roomId, 'control');
      const risk = request.body?.risk === 'blocked' || request.body?.risk === 'warning' ? request.body.risk : 'safe';
      const scope = request.body?.scope === 'product' || request.body?.scope === 'category' ? request.body.scope : 'room';
      const productId = typeof request.body?.productId === 'string' ? request.body.productId : undefined;
      const product = productId ? runtime.listProducts(roomId).find((candidate) => candidate.id === productId) : undefined;
      if (scope === 'product' && !product) return response.status(400).json({ message: '商品不属于当前直播间' });
      response.status(201).json(runtime.rules.create(roomId, actorId(request), { name: bodyString(request.body?.name, '规则名称'), pattern: bodyString(request.body?.pattern, '匹配内容'), matchType: request.body?.matchType === 'regex' ? 'regex' : 'contains', risk, title: bodyString(request.body?.title, '提醒标题'), reason: bodyString(request.body?.reason, '提醒原因'), alternative: bodyString(request.body?.alternative, '替代表达'), policyRef: bodyString(request.body?.policyRef, '规则依据'), scope, ...(product ? { productId: product.id, category: product.category } : {}), ...(scope === 'category' && typeof request.body?.category === 'string' ? { category: request.body.category } : {}) }));
    } catch (error) { jsonError(response, error); }
  });
  app.post('/api/v2/rooms/:roomId/rules/confirm', (request, response) => {
    try {
      const roomId = routeParam(request, 'roomId'); runtime.authorization.assert(identity(request), roomId, 'control');
      const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
      const result = body.result && typeof body.result === 'object' ? body.result as ComplianceResult : null;
      if (!result || (result.risk !== 'warning' && result.risk !== 'blocked')) return response.status(400).json({ message: '只能确认风险提醒或高风险结果' });
      if (typeof result.productId !== 'string' || !result.productId.trim()) return response.status(400).json({ message: '风险结果缺少商品信息' });
      const productId = result.productId.trim();
      const product = runtime.listProducts(roomId).find((candidate) => candidate.id === productId);
      if (!product) return response.status(400).json({ message: '商品不属于当前直播间' });
      return response.status(201).json(runtime.rules.confirmFinding(roomId, actorId(request), result, product));
    } catch (error) { return jsonError(response, error); }
  });
  app.get('/api/v2/rooms/:roomId/compliance-findings', (request, response) => {
    try {
      const roomId = routeParam(request, 'roomId'); runtime.authorization.assert(identity(request), roomId, 'view');
      const disposition = request.query.disposition === 'confirmed' || request.query.disposition === 'dismissed' || request.query.disposition === 'all' ? request.query.disposition : 'pending';
      return response.json(runtime.store.listComplianceFindings(roomId, disposition));
    } catch (error) { return jsonError(response, error, 403); }
  });
  app.post('/api/v2/sessions/:sessionId/compliance-findings/:segmentId/confirm', (request, response) => {
    try {
      const sessionId = routeParam(request, 'sessionId'); const segmentId = routeParam(request, 'segmentId');
      const finding = runtime.store.getComplianceFinding(sessionId, segmentId); if (!finding) return response.status(404).json({ message: '待处置风险不存在' });
      runtime.authorization.assert(identity(request), finding.roomId, 'control');
      if (finding.disposition === 'confirmed' && finding.ruleId) return response.json({ finding, rule: runtime.store.getRule(finding.ruleId) });
      if (finding.disposition !== 'pending') return response.status(409).json({ message: '该风险已完成处置' });
      const snapshot = runtime.snapshot(sessionId);
      const product = (finding.product?.id === finding.productId ? finding.product : undefined)
        ?? runtime.listProducts(finding.roomId).find((candidate) => candidate.id === finding.productId)
        ?? snapshot?.lineup.find((candidate) => candidate.id === finding.productId)
        ?? (snapshot?.product.id === finding.productId ? snapshot.product : undefined);
      if (!product) return response.status(409).json({ message: '无法找到风险发生时的商品资料，请先恢复该商品后再确认' });
      const rule = runtime.rules.confirmFinding(finding.roomId, actorId(request), finding.result, product);
      const resolved = runtime.store.resolveComplianceFinding(sessionId, segmentId, 'confirmed', actorId(request), rule.id, typeof request.body?.note === 'string' ? request.body.note : undefined);
      return response.status(201).json({ finding: resolved, rule });
    } catch (error) { return jsonError(response, error); }
  });
  app.post('/api/v2/sessions/:sessionId/compliance-findings/:segmentId/dismiss', (request, response) => {
    try {
      const sessionId = routeParam(request, 'sessionId'); const segmentId = routeParam(request, 'segmentId');
      const finding = runtime.store.getComplianceFinding(sessionId, segmentId); if (!finding) return response.status(404).json({ message: '待处置风险不存在' });
      runtime.authorization.assert(identity(request), finding.roomId, 'control');
      if (finding.disposition === 'dismissed') return response.json(finding);
      if (finding.disposition !== 'pending') return response.status(409).json({ message: '该风险已完成处置' });
      return response.json(runtime.store.resolveComplianceFinding(sessionId, segmentId, 'dismissed', actorId(request), undefined, typeof request.body?.note === 'string' ? request.body.note : undefined));
    } catch (error) { return jsonError(response, error); }
  });
  app.patch('/api/v2/rules/:ruleId', (request, response) => {
    try {
      const ruleId = routeParam(request, 'ruleId'); const rule = runtime.store.getRule(ruleId); if (!rule) return response.status(404).json({ message: '规则不存在' }); runtime.authorization.assert(identity(request), rule.roomId, 'control');
      const patch = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
      return response.json(runtime.rules.update(ruleId, actorId(request), {
        ...(typeof patch.name === 'string' ? { name: patch.name } : {}), ...(typeof patch.pattern === 'string' ? { pattern: patch.pattern } : {}),
        ...(patch.matchType === 'regex' || patch.matchType === 'contains' ? { matchType: patch.matchType } : {}), ...(patch.risk === 'safe' || patch.risk === 'warning' || patch.risk === 'blocked' ? { risk: patch.risk } : {}), ...(patch.scope === 'room' || patch.scope === 'category' || patch.scope === 'product' || patch.scope === 'shared' ? { scope: patch.scope } : {}), ...(typeof patch.productId === 'string' ? { productId: patch.productId } : {}), ...(typeof patch.category === 'string' ? { category: patch.category } : {}),
        ...(typeof patch.title === 'string' ? { title: patch.title } : {}), ...(typeof patch.reason === 'string' ? { reason: patch.reason } : {}), ...(typeof patch.alternative === 'string' ? { alternative: patch.alternative } : {}), ...(typeof patch.policyRef === 'string' ? { policyRef: patch.policyRef } : {}), ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
      }));
    } catch (error) { return jsonError(response, error); }
  });
  app.post('/api/v2/rules/:ruleId/review', (request, response) => {
    try {
      const ruleId = routeParam(request, 'ruleId'); const rule = runtime.store.getRule(ruleId); if (!rule) return response.status(404).json({ message: '规则不存在' }); runtime.authorization.assert(identity(request), rule.roomId, 'control');
      if (request.body?.decision !== 'approved' && request.body?.decision !== 'rejected') return response.status(400).json({ message: '审核决定无效' });
      return response.json(runtime.rules.review(ruleId, actorId(request), request.body.decision));
    } catch (error) { return jsonError(response, error); }
  });
  app.post('/api/v2/rules/:ruleId/rollback', (request, response) => {
    try {
      const ruleId = routeParam(request, 'ruleId'); const rule = runtime.store.getRule(ruleId); if (!rule) return response.status(404).json({ message: '规则不存在' }); runtime.authorization.assert(identity(request), rule.roomId, 'control');
      const version = Number(request.body?.version); if (!Number.isInteger(version) || version < 1) return response.status(400).json({ message: '目标版本无效' });
      return response.json(runtime.rules.rollback(ruleId, actorId(request), version));
    } catch (error) { return jsonError(response, error); }
  });
  app.post('/api/v2/rules/:ruleId/public-submit', (request, response) => {
    try { const ruleId = routeParam(request, 'ruleId'); const rule = runtime.store.getRule(ruleId); if (!rule) return response.status(404).json({ message: '规则不存在' }); runtime.authorization.assert(identity(request), rule.roomId, 'control'); return response.json(runtime.rules.submitPublic(ruleId, actorId(request))); } catch (error) { return jsonError(response, error); }
  });
  app.post('/api/v2/rules/:ruleId/public-review', (request, response) => {
    try {
      const ruleId = routeParam(request, 'ruleId'); const rule = runtime.store.getRule(ruleId); if (!rule) return response.status(404).json({ message: '规则不存在' }); runtime.authorization.assertServiceReview(identity(request));
      if (request.body?.decision !== 'adopted' && request.body?.decision !== 'deferred' && request.body?.decision !== 'discarded') return response.status(400).json({ message: '运营审核决定无效' });
      return response.json(runtime.rules.reviewPublic(ruleId, actorId(request), request.body.decision));
    } catch (error) { return jsonError(response, error, 403); }
  });
  app.get('/api/v2/operations/rules', (request, response) => {
    try { runtime.authorization.assertServiceReview(identity(request)); return response.json(runtime.store.listPublicRuleCandidates()); } catch (error) { return jsonError(response, error, 403); }
  });
  app.get('/api/v2/rooms/:roomId/presenters', (request, response) => {
    try { const roomId = routeParam(request, 'roomId'); runtime.authorization.assert(identity(request), roomId, 'view'); response.json(runtime.presenters.list(roomId)); } catch (error) { jsonError(response, error, 403); }
  });
  app.post('/api/v2/rooms/:roomId/presenters', (request, response) => {
    try { const roomId = routeParam(request, 'roomId'); runtime.authorization.assert(identity(request), roomId, 'control'); response.status(201).json(runtime.presenters.create(roomId, bodyString(request.body?.name, '主播名称'), typeof request.body?.accountName === 'string' ? request.body.accountName : '本地账号')); } catch (error) { jsonError(response, error); }
  });
  app.get('/api/v2/presenters/:presenterId/phrases', (request, response) => {
    try { const presenterId = routeParam(request, 'presenterId'); const presenter = runtime.presenters.get(presenterId); if (!presenter) return response.status(404).json({ message: '主播不存在' }); runtime.authorization.assert(identity(request), presenter.roomId, 'view'); return response.json(runtime.presenters.phrases(presenterId, typeof request.query.productId === 'string' ? request.query.productId : undefined)); } catch (error) { return jsonError(response, error, 403); }
  });
  app.post('/api/v2/presenters/:presenterId/phrases', (request, response) => {
    try { const presenterId = routeParam(request, 'presenterId'); const presenter = runtime.presenters.get(presenterId); if (!presenter) return response.status(404).json({ message: '主播不存在' }); runtime.authorization.assert(identity(request), presenter.roomId, 'control'); return response.status(201).json(runtime.presenters.savePhrase({ presenterId, productId: typeof request.body?.productId === 'string' ? request.body.productId : null, purpose: coachPurpose(request.body?.purpose), text: bodyString(request.body?.text, '话术内容'), source: 'manual', status: request.body?.status === 'reference' ? 'reference' : 'draft' })); } catch (error) { return jsonError(response, error); }
  });
  app.patch('/api/v2/phrases/:phraseId', (request, response) => {
    try { const phraseId = routeParam(request, 'phraseId'); const phrase = runtime.store.getPhrase(phraseId); if (!phrase) return response.status(404).json({ message: '话术不存在' }); runtime.authorization.assert(identity(request), phrase.roomId, 'control'); const purpose = coachPurpose(request.body?.purpose); return response.json(runtime.presenters.updatePhrase(phraseId, { ...(typeof request.body?.text === 'string' ? { text: request.body.text } : {}), ...(purpose ? { purpose } : {}), ...(request.body?.status === 'reference' || request.body?.status === 'draft' || request.body?.status === 'retired' ? { status: request.body.status } : {}) })); } catch (error) { return jsonError(response, error); }
  });
  app.post('/api/v2/sessions', (request, response) => {
    try {
      runtime.authorization.assert(identity(request), typeof request.body?.roomId === 'string' ? request.body.roomId : 'room-default', 'control');
      const session = runtime.getOrCreateSession({ sessionId: typeof request.body?.sessionId === 'string' ? request.body.sessionId : undefined, roomId: typeof request.body?.roomId === 'string' ? request.body.roomId : undefined, presenterId: typeof request.body?.presenterId === 'string' ? request.body.presenterId : undefined, presenterName: typeof request.body?.presenterName === 'string' ? request.body.presenterName : undefined });
      response.status(201).json(session.snapshot());
    } catch (error) { jsonError(response, error); }
  });
  app.get('/api/v2/sessions', (request, response) => {
    const roomId = typeof request.query.roomId === 'string' ? request.query.roomId : 'room-default';
    try { runtime.authorization.assert(identity(request), roomId, 'review'); response.json(runtime.listSessions(roomId)); } catch (error) { jsonError(response, error, 403); }
  });
  app.get('/api/v2/sessions/:sessionId', (request, response) => {
    const snapshot = runtime.snapshot(routeParam(request, 'sessionId'));
    if (!snapshot) return response.status(404).json({ message: '直播场次不存在' });
    try { runtime.authorization.assert(identity(request), snapshot.roomId, 'view'); } catch (error) { return jsonError(response, error, 403); }
    return response.json(snapshot);
  });
  app.post('/api/v2/sessions/:sessionId/commands', async (request, response) => {
    try {
      if (!isLiveCommand(request.body?.command)) throw new Error('无效的直播命令');
      const snapshot = runtime.snapshot(routeParam(request, 'sessionId'));
      if (!snapshot) return response.status(404).json({ message: '直播场次不存在' });
      runtime.authorization.assert(identity(request), snapshot.roomId, 'control');
      await runtime.dispatch(routeParam(request, 'sessionId'), request.body.command);
      return response.json({ ok: true, snapshot: runtime.snapshot(routeParam(request, 'sessionId')) });
    } catch (error) { return jsonError(response, error); }
  });
  app.post('/api/v2/sessions/:sessionId/display-link', (request, response) => {
    try { const sessionId = routeParam(request, 'sessionId'); const snapshot = runtime.snapshot(sessionId); if (!snapshot) return response.status(404).json({ message: '直播场次不存在' }); runtime.authorization.assert(identity(request), snapshot.roomId, 'view'); const link = runtime.createDisplayLink(sessionId); return response.json({ ...link, path: `/screen/${link.alias}` }); } catch (error) { return jsonError(response, error); }
  });
  app.get('/api/v2/sessions/:sessionId/review', (request, response) => {
    const review = runtime.getReview(routeParam(request, 'sessionId'));
    if (!review) return response.status(404).json({ message: '直播场次不存在' });
    try { runtime.authorization.assert(identity(request), review.summary.roomId, 'review'); } catch (error) { return jsonError(response, error, 403); }
    return response.json(review);
  });
  app.post('/api/v2/sessions/:sessionId/transcripts/:segmentId/correct', (request, response) => {
    try { const session = runtime.snapshot(routeParam(request, 'sessionId')); if (session) runtime.authorization.assert(identity(request), session.roomId, 'review'); return response.json(runtime.review.correctTranscript(routeParam(request, 'sessionId'), routeParam(request, 'segmentId'), bodyString(request.body?.text, '纠正文本'), actorId(request))); } catch (error) { return jsonError(response, error); }
  });
  app.post('/api/v2/sessions/:sessionId/transcripts/:segmentId/speaker', (request, response) => {
    try {
      const speaker = request.body?.speaker === 'other' ? 'other' : request.body?.speaker === 'host' ? 'host' : null;
      if (!speaker) throw new Error('说话人标记无效');
      const session = runtime.snapshot(routeParam(request, 'sessionId')); if (session) runtime.authorization.assert(identity(request), session.roomId, 'review');
      return response.json(runtime.review.assignSpeaker(routeParam(request, 'sessionId'), routeParam(request, 'segmentId'), speaker, typeof request.body?.speakerId === 'string' ? request.body.speakerId : undefined, actorId(request)));
    } catch (error) { return jsonError(response, error); }
  });
  app.post('/api/v2/sessions/:sessionId/note', (request, response) => {
    try { const session = runtime.snapshot(routeParam(request, 'sessionId')); if (session) runtime.authorization.assert(identity(request), session.roomId, 'review'); return response.json(runtime.review.saveNote(routeParam(request, 'sessionId'), typeof request.body?.note === 'string' ? request.body.note : '', actorId(request))); } catch (error) { return jsonError(response, error); }
  });
  app.post('/api/v2/sessions/:sessionId/delivery/approve', (request, response) => {
    try { const session = runtime.snapshot(routeParam(request, 'sessionId')); if (session) runtime.authorization.assert(identity(request), session.roomId, 'deliver'); return response.json(runtime.review.approveDelivery(routeParam(request, 'sessionId'), actorId(request))); } catch (error) { return jsonError(response, error); }
  });
  app.post('/api/v2/sessions/:sessionId/delivery/retry', (request, response) => {
    try { const session = runtime.snapshot(routeParam(request, 'sessionId')); if (session) runtime.authorization.assert(identity(request), session.roomId, 'deliver'); return response.json(runtime.review.retryDelivery(routeParam(request, 'sessionId'), actorId(request))); } catch (error) { return jsonError(response, error); }
  });
  app.get('/api/v2/sessions/:sessionId/audio', (request, response) => {
    const review = runtime.getReview(routeParam(request, 'sessionId'));
    const asset = runtime.store.listAudioAssets(routeParam(request, 'sessionId'))[0];
    if (!review || !asset || !existsSync(asset.path)) return response.status(404).json({ message: '本场没有音频' });
    try { runtime.authorization.assert(identity(request), review.summary.roomId, 'review'); } catch (error) { return jsonError(response, error, 403); }
    response.type('audio/wav');
    response.setHeader('Content-Length', asset.byteLength + 44);
    response.write(wavHeader(asset.byteLength, asset.sampleRate, asset.channels));
    createReadStream(asset.path).pipe(response);
  });

  const send = (socket: WebSocket, frame: V2ServerFrame): void => {
    if (socket.readyState === 1) socket.send(JSON.stringify(frame));
  };

  wsServer.on('connection', (socket, request) => {
    clients.add(socket);
    let joined = false;
    socket.on('message', async (data, isBinary) => {
      const current = sockets.get(socket);
      try {
        if (isBinary) {
          if (!current) throw new Error('请先加入会话');
          if (current.role === 'display') throw new Error('主播屏不能发送收音数据');
          if (!captureLeases.owns(current.sessionId, socket)) throw new Error('当前页面未持有收音权限');
          const frame = decodeAudioFrame(new Uint8Array(data as Buffer));
          if (!frame) throw new Error('音频帧格式无效，请刷新控制台');
          await runtime.dispatch(current.sessionId, { type: 'audio', ...frame });
          return;
        }
        const frame = JSON.parse(data.toString()) as V2ClientFrame;
        const command = frame.command;
        if (!joined) {
          if (!isJoinCommand(command)) throw new Error('首条消息必须加入会话');
          const resolvedSessionId = command.displayAlias ? runtime.resolveDisplayLink(command.displayAlias) : command.sessionId;
          if (command.displayAlias && !resolvedSessionId) throw new Error('主播屏地址已失效，请从控制台重新生成');
          const aliasDisplay = command.role === 'display' && Boolean(command.displayAlias && resolvedSessionId);
          if (!aliasDisplay) runtime.authorization.assertControlTransport({ encrypted: Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted), remoteAddress: request.socket.remoteAddress, forwardedProto: typeof request.headers['x-forwarded-proto'] === 'string' ? request.headers['x-forwarded-proto'] : undefined });
          const joinIdentity = aliasDisplay ? null : runtime.authorization.authenticate({ token: command.token, claimedActorId: command.actorId, remoteAddress: request.socket.remoteAddress, origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined });
          const requestedSnapshot = resolvedSessionId ? runtime.snapshot(resolvedSessionId) : null;
          const accessRoomId = requestedSnapshot?.roomId ?? command.roomId ?? 'room-default';
          if (joinIdentity) runtime.authorization.assert(joinIdentity, accessRoomId, 'view');
          const session = command.role === 'operator'
            ? runtime.getOrCreateOperatorSession({ sessionId: resolvedSessionId ?? undefined, roomId: requestedSnapshot?.roomId ?? command.roomId, presenterId: requestedSnapshot?.presenterId ?? command.presenterId, presenterName: requestedSnapshot?.presenterName })
            : runtime.getOrCreateSession({ sessionId: resolvedSessionId ?? undefined, roomId: command.roomId, presenterId: command.presenterId });
          if (joinIdentity) runtime.authorization.assert(joinIdentity, session.snapshot().roomId, 'view');
          const unsubscribe = runtime.subscribe(session.id, (event, snapshot) => {
            const state = sockets.get(socket);
            if (!state || event.sequence <= state.sequence) return;
            state.sequence = event.sequence;
            send(socket, { type: 'event', event, snapshot });
          });
          sockets.set(socket, { sessionId: session.id, roomId: session.snapshot().roomId, identity: joinIdentity, role: command.role, unsubscribe, sequence: session.snapshot().latestSequence });
          joined = true;
          send(socket, { type: 'ready', requestId: frame.requestId, sessionId: session.id, products: runtime.listProducts(session.snapshot().roomId), snapshot: session.snapshot() });
          return;
        }
        if (!isLiveCommand(command)) throw new Error('无效的直播命令');
        if (current?.role === 'display') throw new Error('主播屏仅支持查看');
        if (!current?.identity) throw new Error('请先登录控制台');
        runtime.authorization.assert(current.identity, current.roomId, 'control');
        if ((command.type === 'start' || command.type === 'resume') && !captureLeases.acquire(current!.sessionId, socket)) throw new Error('另一控制台正在收音，请先在原页面暂停');
        await runtime.dispatch(current!.sessionId, command);
        if (command.type === 'pause' || command.type === 'end' || command.type === 'stop') captureLeases.release(current!.sessionId, socket);
        const state = sockets.get(socket);
        send(socket, { type: 'ack', requestId: frame.requestId, sequence: state?.sequence ?? runtime.snapshot(current!.sessionId)?.latestSequence ?? 0 });
      } catch (error) {
        send(socket, { type: 'error', requestId: (() => { try { return (JSON.parse(data.toString()) as V2ClientFrame).requestId; } catch { return undefined; } })(), message: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on('close', () => {
      clients.delete(socket);
      const state = sockets.get(socket);
      state?.unsubscribe();
      if (state && captureLeases.release(state.sessionId, socket) && runtime.snapshot(state.sessionId)?.lifecycle === 'live') void runtime.dispatch(state.sessionId, { type: 'pause' });
    });
  });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/ws/v2') { socket.destroy(); return; }
    wsServer.handleUpgrade(request, socket, head, (client) => wsServer.emit('connection', client, request));
  });

  if (existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.use((request, response, next) => {
      if (request.method === 'GET') return response.sendFile(path.join(clientDir, 'index.html'));
      return next();
    });
  }
  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      await new Promise<void>((resolve) => {
        wsServer.close(() => resolve());
        for (const client of clients) client.terminate();
      });
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    })();
    return closePromise;
  };
  return { app, server, wsServer, close };
}
