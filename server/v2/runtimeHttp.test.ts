import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { V2ServerFrame } from '../../src/shared/v2Protocol';
import { PRODUCTS } from '../../src/shared/products';
import type { ProductComplianceProfile } from '../../src/shared/types';
import { hashPassword } from '../auth';
import { createV2Http } from './http';
import { createRuntime, type V2Runtime } from './runtime';
import { SqliteFactStore } from './store';

class Inbox {
  private readonly frames: V2ServerFrame[] = [];
  private readonly waiters: Array<(frame: V2ServerFrame) => void> = [];
  constructor(socket: WebSocket) {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as V2ServerFrame;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame); else this.frames.push(frame);
    });
  }
  next(): Promise<V2ServerFrame> {
    const frame = this.frames.shift();
    return frame ? Promise.resolve(frame) : new Promise((resolve) => this.waiters.push(resolve));
  }
  async until(predicate: (frame: V2ServerFrame) => boolean): Promise<V2ServerFrame> {
    for (;;) { const frame = await this.next(); if (predicate(frame)) return frame; }
  }
}

describe('v2 HTTP/WebSocket runtime', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  it('resumes background delivery whenever no session is live or ending', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-runtime-background-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    cleanups.push(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
    const first = runtime.getOrCreateSession({ sessionId: 'live-background-a' });
    const second = runtime.getOrCreateSession({ sessionId: 'live-background-b' });

    await first.dispatch({ type: 'start' });
    await second.dispatch({ type: 'start' });
    expect(runtime.scheduler.snapshot().background.paused).toBe(true);
    await first.dispatch({ type: 'pause' });
    expect(runtime.scheduler.snapshot().background.paused).toBe(true);
    await second.dispatch({ type: 'pause' });
    expect(runtime.scheduler.snapshot().background.paused).toBe(false);
  });

  it('restores a missing legacy presenter before archiving an ended session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-legacy-presenter-'));
    const dbPath = join(directory, 'app.sqlite');
    const seed = new SqliteFactStore({ filename: dbPath, audioRoot: join(directory, 'audio') });
    seed.ensureRoom({ id: 'room-default', tenantId: 'tenant-local' });
    seed.createSession({ sessionId: 'live-legacy-presenter', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-legacy', presenterName: '历史主播', product: PRODUCTS[0], lineup: PRODUCTS });
    seed.appendSessionEvent('live-legacy-presenter', { type: 'lifecycle.changed', occurredAt: 2, payload: { lifecycle: 'live' } });
    seed.appendSessionEvent('live-legacy-presenter', { type: 'transcript.final', occurredAt: 3, payload: { segment: JSON.stringify({ id: 'legacy-segment', text: '历史主播话术', isFinal: true, timestamp: 3, offsetMs: 1_000, startOffsetMs: 0, endOffsetMs: 1_000, speaker: 'host' }) } });
    seed.close();

    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: dbPath, V2_AUDIO_DIR: join(directory, 'audio') } });
    cleanups.push(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
    const session = runtime.getOrCreateSession({ sessionId: 'live-legacy-presenter' });

    expect(runtime.presenters.get('presenter-legacy')).toMatchObject({ roomId: 'room-default', name: '历史主播' });
    await session.dispatch({ type: 'end' });
    expect(session.snapshot().lifecycle).toBe('ended');
    expect(runtime.presenters.phrases('presenter-legacy')).toHaveLength(1);
  });

  it('reopens a persisted session with its original room dependencies', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-runtime-reopen-room-'));
    const env = { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') };
    const first = createRuntime({ rootDir: directory, env });
    first.getOrCreateSession({ sessionId: 'live-reopen-room', roomId: 'room-private' });
    first.rules.create('room-private', 'owner', {
      name: '私有直播间规则', pattern: '私有风险词', risk: 'blocked', title: '命中私有规则',
      reason: '仅用于验证重启后的直播间绑定', alternative: '安全表达', policyRef: '测试规则',
    });
    await first.close();

    const second = createRuntime({ rootDir: directory, env });
    cleanups.push(async () => { await second.close(); rmSync(directory, { recursive: true, force: true }); });
    const restored = second.getSession('live-reopen-room');
    expect(restored?.snapshot().roomId).toBe('room-private');

    await restored!.dispatch({ type: 'start' });
    await restored!.dispatch({ type: 'demo_transcript', text: '这句话包含私有风险词' });

    expect(restored?.snapshot().latestCompliance).toMatchObject({ source: 'custom-rule', risk: 'blocked', title: '命中私有规则' });
  });

  it('keeps rule scope and review rollback lifecycle visible over HTTP', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-rule-governance-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    runtime.getOrCreateSession({ sessionId: 'live-rule-governance', roomId: 'room-rule-governance' });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/v2/rooms/room-rule-governance/rules`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: '商品专属风险词', pattern: '商品专属风险词', risk: 'blocked', title: '商品风险', reason: '测试商品规则', alternative: '安全表达', policyRef: '测试', scope: 'product', productId: PRODUCTS[0].id,
      }),
    });
    const created = await createResponse.json() as { id: string; scope: string; productId?: string; version: number };
    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({ scope: 'product', productId: PRODUCTS[0].id, version: 1 });

    const editedResponse = await fetch(`http://127.0.0.1:${port}/api/v2/rules/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alternative: '编辑后的安全表达' }),
    });
    expect(editedResponse.status).toBe(200);
    expect((await editedResponse.json() as { version: number }).version).toBe(2);

    const rollbackResponse = await fetch(`http://127.0.0.1:${port}/api/v2/rules/${created.id}/rollback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1 }),
    });
    const rolledBack = await rollbackResponse.json() as { version: number; alternative: string };
    expect(rollbackResponse.status).toBe(200);
    expect(rolledBack).toMatchObject({ version: 3, alternative: '安全表达' });

    const learned = runtime.rules.learn('room-rule-governance', 'session-learning', {
      id: 'remote-finding', productId: PRODUCTS[0].id, risk: 'blocked', title: '待审核', reason: '模型发现', alternative: '安全表达', policyRef: '测试', confidence: 0.99, source: 'doubao', transcript: '模型新风险词', createdAt: 1, matchedTerms: ['模型新风险词'], ruleKind: 'term',
    }, PRODUCTS[0])[0];
    expect(learned).toMatchObject({ status: 'pending_review', enabled: false, scope: 'product' });
    const reviewResponse = await fetch(`http://127.0.0.1:${port}/api/v2/rules/${learned!.id}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
    });
    expect(reviewResponse.status).toBe(200);
    expect(await reviewResponse.json()).toMatchObject({ status: 'published', enabled: true });
    expect(runtime.rules.active('room-rule-governance', PRODUCTS[0]).some((rule) => rule.id === learned!.id)).toBe(true);
  });

  it('disposes persisted compliance findings after later product changes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-compliance-findings-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const roomId = 'room-finding-disposition';
    const sessionId = 'live-finding-disposition';
    const session = runtime.getOrCreateSession({ sessionId, roomId });
    const originalProduct = session.snapshot().product;
    const risk = {
      id: 'finding-risk-original', segmentId: 'segment-original', productId: originalProduct.id, risk: 'blocked' as const,
      title: '医疗功效', reason: '包含治疗承诺', alternative: '只描述日常使用体验', policyRef: '广告合规', confidence: 0.98,
      source: 'doubao' as const, transcript: '这个可以治疗耳聋', matchedTerms: ['治疗耳聋'], ruleKind: 'term' as const, createdAt: 2,
    };
    runtime.store.appendSessionEvent(sessionId, { type: 'compliance.updated', occurredAt: 2, payload: { result: JSON.stringify(risk), segmentId: risk.segmentId, latest: true } });
    expect(runtime.store.getComplianceFinding(sessionId, risk.segmentId!)?.product).toEqual(originalProduct);

    await runtime.removeProduct(roomId, originalProduct.id);
    expect(runtime.listProducts(roomId).some((product) => product.id === originalProduct.id)).toBe(false);
    expect(runtime.snapshot(sessionId)?.lineup.some((product) => product.id === originalProduct.id)).toBe(false);

    const secondProduct = runtime.snapshot(sessionId)!.product;
    const dismissedRisk = { ...risk, id: 'finding-risk-dismissed', segmentId: 'segment-dismissed', productId: secondProduct.id, transcript: '这句模型判断需要人工复核', matchedTerms: ['人工复核'], createdAt: 3 };
    runtime.store.appendSessionEvent(sessionId, { type: 'compliance.updated', occurredAt: 3, payload: { result: JSON.stringify(dismissedRisk), segmentId: dismissedRisk.segmentId, latest: true } });

    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/v2/sessions/${sessionId}/compliance-findings`;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const confirm = () => fetch(`${base}/${risk.segmentId}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const confirmedResponse = await confirm();
    const confirmed = await confirmedResponse.json() as { finding: { disposition: string; ruleId?: string }; rule: { id: string; productId?: string; category?: string } };
    expect(confirmedResponse.status).toBe(201);
    expect(confirmed.finding).toMatchObject({ disposition: 'confirmed', ruleId: confirmed.rule.id });
    expect(confirmed.rule).toMatchObject({ productId: originalProduct.id, category: originalProduct.category });

    const repeated = await confirm();
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as { rule: { id: string } }).rule.id).toBe(confirmed.rule.id);
    expect((await fetch(`${base}/${risk.segmentId}/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(409);

    const dismiss = () => fetch(`${base}/${dismissedRisk.segmentId}/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '人工确认属于误判' }) });
    const dismissedResponse = await dismiss();
    expect(dismissedResponse.status).toBe(200);
    expect(await dismissedResponse.json()).toMatchObject({ disposition: 'dismissed', resolutionNote: '人工确认属于误判' });
    expect((await dismiss()).status).toBe(200);
    expect((await fetch(`${base}/${dismissedRisk.segmentId}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(409);

    const pending = await fetch(`http://127.0.0.1:${port}/api/v2/rooms/${roomId}/compliance-findings?disposition=pending`);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual([]);
  });

  it('keeps product details isolated per live room through the public API', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-room-products-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    runtime.getOrCreateSession({ sessionId: 'live-room-a-products', roomId: 'room-store-a' });
    runtime.getOrCreateSession({ sessionId: 'live-room-b-products', roomId: 'room-store-b' });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
    const base = PRODUCTS[0];

    const save = (roomId: string, name: string, price: string) => fetch(`http://127.0.0.1:${port}/api/v2/rooms/${roomId}/products/${base.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, name, price }),
    });
    expect((await save('room-store-a', 'A 店专属精华', '¥99')).status).toBe(200);
    expect((await save('room-store-b', 'B 店专属精华', '¥139')).status).toBe(200);

    const roomA = await (await fetch(`http://127.0.0.1:${port}/api/v2/rooms/room-store-a/products`)).json() as typeof PRODUCTS;
    const roomB = await (await fetch(`http://127.0.0.1:${port}/api/v2/rooms/room-store-b/products`)).json() as typeof PRODUCTS;
    expect(roomA.find((product) => product.id === base.id)).toMatchObject({ name: 'A 店专属精华', price: '¥99' });
    expect(roomB.find((product) => product.id === base.id)).toMatchObject({ name: 'B 店专属精华', price: '¥139' });

    const operator = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => operator.once('open', resolve));
    const inbox = new Inbox(operator);
    operator.send(JSON.stringify({ requestId: 'join-room-products', command: { type: 'session.join', sessionId: 'live-room-a-products', roomId: 'room-store-a', role: 'operator' } }));
    const ready = await inbox.until((frame) => frame.type === 'ready');
    expect(ready.type === 'ready' && ready.products.find((product) => product.id === base.id)?.name).toBe('A 店专属精华');
    operator.close();
  });

  it('creates a room product before optional selling material is completed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-room-product-create-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const session = runtime.getOrCreateSession({ sessionId: 'live-room-product-create', roomId: 'room-product-create' });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
    const product = { ...PRODUCTS[0], id: 'product-room-new', name: '直播间新商品', description: '', sellingPoints: [], compliantPhrases: [] };

    const response = await fetch(`http://127.0.0.1:${port}/api/v2/rooms/room-product-create/products/${product.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(product),
    });

    expect(response.status).toBe(200);
    expect(runtime.listProducts('room-product-create')).toContainEqual(expect.objectContaining({ id: product.id, name: product.name }));
    expect(session.snapshot().lineup).toContainEqual(expect.objectContaining({ id: product.id, name: product.name }));
  });

  it('saves immediately with a local profile and applies the Doubao profile in the background', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-product-profile-'));
    const generated: ProductComplianceProfile = { industry: '食品饮料', category: '冲调食品/营养食品', platformRuleset: 'douyin-ecommerce-live', complianceSummary: '普通食品只介绍配料、规格和食用场景。', riskKeywords: ['替代药物'], riskBoundaries: ['不得宣传疾病治疗'], requiredDisclosures: ['配料表以页面为准'], safeSellingPoints: ['介绍配料和口味'], confidence: 0.94, source: 'doubao', status: 'generated', updatedAt: 200 };
    const profiler = { profile: vi.fn().mockResolvedValue(generated) };
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') }, productProfiler: profiler });
    const session = runtime.getOrCreateSession({ sessionId: 'live-product-profile', roomId: 'room-product-profile' });
    cleanups.push(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
    const product = { ...PRODUCTS[0], id: 'nutrition-food', name: '营养冲调食品', category: '其他', description: '含谷物和维生素的冲调食品', sellingPoints: ['早餐冲调'] };
    await session.dispatch({ type: 'start' });
    expect(runtime.scheduler.snapshot().background.paused).toBe(true);

    const saved = await runtime.upsertProduct('room-product-profile', product);

    expect(saved.complianceProfile).toMatchObject({ platformRuleset: 'douyin-ecommerce-live', source: 'local-fallback', status: 'needs_review' });
    await vi.waitFor(() => expect(runtime.listProducts('room-product-profile').find((item) => item.id === product.id)?.complianceProfile).toMatchObject({ industry: '食品饮料', category: '冲调食品/营养食品', source: 'doubao' }));
    expect(profiler.profile).toHaveBeenCalledOnce();
  });

  it('preserves a manually verified product profile during later product edits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-manual-product-profile-'));
    const profiler = { profile: vi.fn() };
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') }, productProfiler: profiler });
    runtime.getOrCreateSession({ sessionId: 'live-manual-product-profile', roomId: 'room-manual-product-profile' });
    cleanups.push(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
    const manual: ProductComplianceProfile = { industry: '自定义行业', category: '自定义类目', platformRuleset: 'douyin-ecommerce-live', complianceSummary: '人工确认的合规边界。', riskKeywords: ['人工高风险词'], riskBoundaries: ['人工语义边界'], requiredDisclosures: ['人工必要披露'], safeSellingPoints: ['人工安全方向'], confidence: 1, source: 'manual', status: 'verified', updatedAt: 100 };

    const saved = await runtime.upsertProduct('room-manual-product-profile', { ...PRODUCTS[0], id: 'manual-profile-product', name: '人工画像商品', category: manual.category, complianceProfile: manual });
    const edited = await runtime.upsertProduct('room-manual-product-profile', { ...saved, description: '修改后的商品描述' });

    expect(edited.complianceProfile).toEqual(manual);
    expect(edited.category).toBe('自定义类目');
    expect(profiler.profile).not.toHaveBeenCalled();
  });

  it('broadcasts live product edits and retains the selected product in session history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-live-product-edit-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const session = runtime.getOrCreateSession({ sessionId: 'live-product-edit', roomId: 'room-product-live' });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
    const operator = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => operator.once('open', resolve));
    const inbox = new Inbox(operator);
    operator.send(JSON.stringify({ requestId: 'join-live-product', command: { type: 'session.join', sessionId: session.id, roomId: 'room-product-live', role: 'operator' } }));
    const ready = await inbox.until((frame) => frame.type === 'ready');
    if (ready.type !== 'ready') throw new Error('missing ready frame');
    operator.send(JSON.stringify({ requestId: 'start-live-product', command: { type: 'start' } }));
    await inbox.until((frame) => frame.type === 'event' && frame.event.type === 'lifecycle.changed');

    const edited = { ...PRODUCTS[0], name: '直播中更新的精华', price: '¥109' };
    const updateResponse = await fetch(`http://127.0.0.1:${port}/api/v2/rooms/room-product-live/products/${edited.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edited),
    });
    expect(updateResponse.status).toBe(200);
    const lineupUpdate = await inbox.until((frame) => frame.type === 'event' && frame.event.type === 'lineup.updated');
    expect(lineupUpdate.type === 'event' && lineupUpdate.snapshot.product).toMatchObject({ id: edited.id, name: '直播中更新的精华', price: '¥109' });

    operator.send(JSON.stringify({ requestId: 'select-live-product', command: { type: 'select_product', productId: 'headphones' } }));
    const selection = await inbox.until((frame) => frame.type === 'event' && frame.event.type === 'product.selected');
    expect(selection.type === 'event' && selection.snapshot.product.id).toBe('headphones');
    operator.send(JSON.stringify({ requestId: 'end-live-product', command: { type: 'end' } }));
    await inbox.until((frame) => frame.type === 'event' && frame.event.type === 'session.ended');

    const history = await (await fetch(`http://127.0.0.1:${port}/api/v2/sessions/${session.id}`)).json() as { roomId: string; product: { id: string }; lineup: Array<{ name: string }> };
    expect(history).toMatchObject({ roomId: 'room-product-live', product: { id: 'headphones' } });
    expect(history.lineup.some((product) => product.name === '直播中更新的精华')).toBe(true);
    operator.close();
  });

  it('preserves a session-specific lineup when the room catalog changes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-session-lineup-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const session = runtime.getOrCreateSession({ sessionId: 'live-session-lineup', roomId: 'room-session-lineup' });
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));
    await session.dispatch({ type: 'start' });
    await session.dispatch({ type: 'set_lineup', productIds: ['serum', 'headphones'] });
    await runtime.upsertProduct('room-session-lineup', { ...PRODUCTS[2], name: '直播间新增保温杯' });

    expect(session.snapshot().lineup.map((product) => product.id)).toEqual(['serum', 'headphones']);
    expect(events).toContain('catalog.updated');
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('archives original-rate and 16k ASR audio as separate assets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-runtime-audio-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    cleanups.push(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
    const session = runtime.getOrCreateSession({ sessionId: 'live-dual-audio' });

    await session.dispatch({ type: 'start' });
    await session.dispatch({ type: 'audio', track: 'source', pcm: new Uint8Array(9_600), sampleRate: 48_000, channels: 1 });
    await session.dispatch({ type: 'audio', track: 'asr', pcm: new Uint8Array(3_200), sampleRate: 16_000, channels: 1 });
    await session.dispatch({ type: 'end' });
    await vi.waitFor(() => expect(runtime.store.listAudioAssets(session.id)).toHaveLength(2));

    expect(runtime.store.listAudioAssets(session.id).map((asset) => [asset.encoding, asset.sampleRate, asset.durationMs])).toEqual([
      ['pcm_s16le_source', 48_000, 100],
      ['pcm_s16le_asr', 16_000, 100],
    ]);
    expect(runtime.getReview(session.id)?.summary).toMatchObject({ audioBytes: 9_600, audioDurationMs: 100 });
  });

  it('broadcasts ordered events and enforces a single capture owner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-runtime-'));
    const runtime: V2Runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const first = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => first.once('open', resolve));
    const firstInbox = new Inbox(first);
    first.send(JSON.stringify({ requestId: 'join-1', command: { type: 'session.join', roomId: 'room-default', role: 'operator' } }));
    const ready = await firstInbox.until((frame) => frame.type === 'ready');
    if (ready.type !== 'ready') throw new Error('missing ready frame');
    first.send(JSON.stringify({ requestId: 'start-1', command: { type: 'start' } }));
    const started = await firstInbox.until((frame) => frame.type === 'event' && frame.event.type === 'lifecycle.changed');
    expect(started.type === 'event' && started.event.sequence).toBe(2);

    const second = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => second.once('open', resolve));
    const secondInbox = new Inbox(second);
    second.send(JSON.stringify({ requestId: 'join-2', command: { type: 'session.join', sessionId: ready.sessionId, roomId: 'room-default', role: 'operator' } }));
    await secondInbox.until((frame) => frame.type === 'ready');
    second.send(JSON.stringify({ requestId: 'start-2', command: { type: 'start' } }));
    const denied = await secondInbox.until((frame) => frame.type === 'error');
    expect(denied.type === 'error' && denied.message).toContain('另一控制台');

    first.send(JSON.stringify({ requestId: 'demo', command: { type: 'demo_transcript', text: '这款商品保证立刻见效' } }));
    const transcript = await firstInbox.until((frame) => frame.type === 'event' && frame.event.type === 'transcript.final');
    const compliance = await firstInbox.until((frame) => frame.type === 'event' && frame.event.type === 'compliance.updated');
    expect(transcript.type === 'event' && compliance.type === 'event' && compliance.event.sequence).toBeGreaterThan(transcript.type === 'event' ? transcript.event.sequence : 0);
    first.send(JSON.stringify({ requestId: 'end', command: { type: 'end' } }));
    await firstInbox.until((frame) => frame.type === 'event' && frame.event.type === 'session.ended');
    first.close(); second.close();
  });

  it('closes upgraded websocket clients before completing server shutdown', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-http-shutdown-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify({ requestId: 'shutdown-join', command: { type: 'session.join', roomId: 'room-default', role: 'operator' } }));
    await new Promise<void>((resolve) => socket.once('message', resolve));
    const socketClosed = new Promise<void>((resolve) => socket.once('close', resolve));

    const close = (http as typeof http & { close?: () => Promise<void> }).close;
    expect(close).toBeTypeOf('function');
    await close!();
    await socketClosed;
    expect(http.server.listening).toBe(false);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('joins the original session through a generated presenter alias', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-display-link-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const session = runtime.getOrCreateSession({ sessionId: 'live-display-link', roomId: 'room-default' });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const response = await fetch(`http://127.0.0.1:${port}/api/v2/sessions/${session.id}/display-link`, { method: 'POST' });
    const link = await response.json() as { alias: string; path: string };
    expect(response.status).toBe(200);
    expect(link.path).toBe(`/screen/${link.alias}`);

    const display = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => display.once('open', resolve));
    const inbox = new Inbox(display);
    display.send(JSON.stringify({ requestId: 'join-display', command: { type: 'session.join', displayAlias: link.alias, roomId: 'room-default', role: 'display' } }));
    const ready = await inbox.until((frame) => frame.type === 'ready');
    expect(ready.type === 'ready' && ready.sessionId).toBe(session.id);
    display.close();
  });

  it('opens a new idle session when an operator returns through an ended session URL', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-next-live-session-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const ended = runtime.getOrCreateSession({ sessionId: 'live-ended-url', roomId: 'room-next-live' });
    await ended.dispatch({ type: 'start' });
    await ended.dispatch({ type: 'end' });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const operator = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => operator.once('open', resolve));
    const inbox = new Inbox(operator);
    operator.send(JSON.stringify({ requestId: 'join-ended-url', command: { type: 'session.join', sessionId: ended.id, roomId: 'room-next-live', role: 'operator' } }));
    const ready = await inbox.until((frame) => frame.type === 'ready');

    expect(ready.type === 'ready' && ready.sessionId).not.toBe(ended.id);
    expect(ready.type === 'ready' && ready.snapshot).toMatchObject({ roomId: 'room-next-live', lifecycle: 'idle' });
    expect(runtime.listSessions('room-next-live')).toHaveLength(2);

    const secondOperator = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => secondOperator.once('open', resolve));
    const secondInbox = new Inbox(secondOperator);
    secondOperator.send(JSON.stringify({ requestId: 'join-ended-url-again', command: { type: 'session.join', sessionId: ended.id, roomId: 'room-next-live', role: 'operator' } }));
    const secondReady = await secondInbox.until((frame) => frame.type === 'ready');

    expect(secondReady.type === 'ready' && secondReady.sessionId).toBe(ready.type === 'ready' ? ready.sessionId : '');
    expect(runtime.listSessions('room-next-live')).toHaveLength(2);
    secondOperator.close();
    operator.close();
  });

  it('rejects an expired presenter alias without creating another session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-expired-display-link-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const session = runtime.getOrCreateSession({ sessionId: 'live-expired-link', roomId: 'room-default' });
    const expired = runtime.store.getOrCreateDisplayLink(session.id, 1, 1);
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const display = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => display.once('open', resolve));
    const inbox = new Inbox(display);
    display.send(JSON.stringify({ requestId: 'join-expired', command: { type: 'session.join', displayAlias: expired.alias, roomId: 'room-default', role: 'display' } }));
    const error = await inbox.until((frame) => frame.type === 'error');

    expect(error.type === 'error' && error.message).toContain('主播屏地址已失效');
    expect(runtime.listSessions('room-default')).toHaveLength(1);
    display.close();
  });

  it('rejects commands for an unknown session instead of creating one implicitly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-unknown-session-command-'));
    const runtime = createRuntime({ rootDir: directory, env: { V2_DB_PATH: join(directory, 'app.sqlite'), V2_AUDIO_DIR: join(directory, 'audio') } });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const response = await fetch(`http://127.0.0.1:${port}/api/v2/sessions/missing-session/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: { type: 'start' } }),
    });

    expect(response.status).toBe(404);
    expect(runtime.listSessions()).toHaveLength(0);
  });

  it('requires signed operator identity and keeps review actions reviewer-only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-auth-runtime-'));
    const env = {
      V2_DB_PATH: join(directory, 'app.sqlite'),
      V2_AUDIO_DIR: join(directory, 'audio'),
      AUTH_TOKEN_SECRET: 'this-is-a-runtime-test-secret-with-32-characters',
      ALLOW_INSECURE_AUTH: 'true',
      AUTH_USERS_JSON: JSON.stringify([
        { actorId: 'owner', displayName: '审核人', passwordHash: hashPassword('review-pass'), role: 'reviewer', roomIds: [] },
        { actorId: 'operator-1', displayName: '场控一号', passwordHash: hashPassword('operator-pass'), role: 'operator', roomIds: ['room-default'] },
      ]),
    };
    const runtime = createRuntime({ rootDir: directory, env });
    runtime.store.ensureRoom({ id: 'room-private', tenantId: 'tenant-local', ownerActorId: 'another-operator', name: '其他直播间' });
    const http = createV2Http(runtime, { clientDir: join(directory, 'missing-client') });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const port = (http.server.address() as AddressInfo).port;
    cleanups.push(async () => { await new Promise<void>((resolve) => http.server.close(() => resolve())); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });

    const loginResponse = await fetch(`http://127.0.0.1:${port}/api/v2/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actorId: 'operator-1', password: 'operator-pass' }),
    });
    const login = await loginResponse.json() as { token: string };
    expect(loginResponse.status).toBe(200);

    const roomsResponse = await fetch(`http://127.0.0.1:${port}/api/v2/rooms`, { headers: { Authorization: `Bearer ${login.token}` } });
    const rooms = await roomsResponse.json() as Array<{ id: string }>;
    expect(rooms.map((room) => room.id)).toEqual(['room-default']);

    const sessionsResponse = await fetch(`http://127.0.0.1:${port}/api/v2/sessions?roomId=room-default`, { headers: { Authorization: `Bearer ${login.token}` } });
    expect(sessionsResponse.status).toBe(403);

    const operator = new WebSocket(`ws://127.0.0.1:${port}/ws/v2`);
    await new Promise<void>((resolve) => operator.once('open', resolve));
    const inbox = new Inbox(operator);
    operator.send(JSON.stringify({ requestId: 'join-authenticated', command: { type: 'session.join', roomId: 'room-default', role: 'operator', token: login.token } }));
    const ready = await inbox.until((frame) => frame.type === 'ready');
    expect(ready.type).toBe('ready');

    const finding: Parameters<typeof runtime.rules.confirmFinding>[2] = {
      id: 'operator-confirmed-risk', segmentId: 'segment-1', productId: PRODUCTS[0].id, risk: 'blocked', title: '医疗功效', reason: '包含治疗承诺', alternative: '只描述实际使用体验', policyRef: '广告合规', confidence: 0.98, source: 'doubao', transcript: '这个可以治疗耳聋', matchedTerms: ['治疗耳聋'], ruleKind: 'term', createdAt: 1,
    };
    const localRule = runtime.rules.confirmFinding('room-default', 'operator-1', finding, PRODUCTS[0]);
    runtime.rules.submitPublic(localRule.id, 'operator-1');
    const operatorReview = await fetch(`http://127.0.0.1:${port}/api/v2/rules/${localRule.id}/public-review`, { method: 'POST', headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'adopted' }) });
    expect(operatorReview.status).toBe(403);
    expect(runtime.store.getRule(localRule.id)?.publicStatus).toBe('pending');

    const reviewerLogin = await (await fetch(`http://127.0.0.1:${port}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actorId: 'owner', password: 'review-pass' }) })).json() as { token: string };
    const candidates = await fetch(`http://127.0.0.1:${port}/api/v2/operations/rules`, { headers: { Authorization: `Bearer ${reviewerLogin.token}` } });
    expect(candidates.status).toBe(200);
    expect(await candidates.json()).toContainEqual(expect.objectContaining({ id: localRule.id, publicStatus: 'pending', evidenceText: finding.transcript }));
    const reviewerReview = await fetch(`http://127.0.0.1:${port}/api/v2/rules/${localRule.id}/public-review`, { method: 'POST', headers: { Authorization: `Bearer ${reviewerLogin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'adopted' }) });
    expect(reviewerReview.status).toBe(200);
    expect(runtime.store.getRule(localRule.id)?.publicStatus).toBe('adopted');
    expect(runtime.store.listRules('public-library')).toContainEqual(expect.objectContaining({ pattern: '治疗耳聋', scope: 'shared' }));
    operator.close();
  });
});
