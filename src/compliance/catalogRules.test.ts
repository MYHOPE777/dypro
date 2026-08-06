import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileProductCatalog } from '../../server/productCatalog';
import { parseProductText } from '../../server/productParser';
import { FileRuleCatalog } from '../../server/ruleCatalog';
import { FileTimelineStore } from '../../server/timelineStore';
import { LiveSession } from '../../server/session';
import { DEFAULT_PRODUCT } from '../shared/products';

const tempDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createCatalog() {
  const directory = mkdtempSync(path.join(tmpdir(), 'live-catalog-'));
  tempDirectories.push(directory);
  const filePath = path.join(directory, 'products.json');
  return { catalog: new FileProductCatalog(filePath), filePath, directory };
}

describe('room product catalogs', () => {
  it('keeps long-lived products and session lineups isolated by room', () => {
    const { catalog, filePath } = createCatalog();
    const firstRoom = catalog.createRoom({ name: '美妆一号间', accountName: '美妆账号', ownerActorId: 'owner-a' });
    const secondRoom = catalog.createRoom({ name: '家居二号间', accountName: '家居账号', ownerActorId: 'owner-b' });
    const product = { ...structuredClone(DEFAULT_PRODUCT), id: 'room-serum', name: '一号间精华', source: 'manual' as const };
    catalog.upsert(firstRoom.id, product);

    expect(catalog.list(firstRoom.id).map((item) => item.id)).toEqual(['room-serum']);
    expect(catalog.list(secondRoom.id)).toEqual([]);
    catalog.setLineup('live-room-test', firstRoom.id, ['room-serum']);

    const restored = new FileProductCatalog(filePath);
    expect(restored.getLineup('live-room-test', firstRoom.id).map((item) => item.id)).toEqual(['room-serum']);
    expect(restored.list(secondRoom.id)).toEqual([]);
  });
});

describe('pasted product parsing', () => {
  it('extracts name, price, stock, SKU, category and selling points without credentials', async () => {
    vi.stubEnv('DOUBAO_API_KEY', '');
    vi.stubEnv('DOUBAO_ENDPOINT_ID', '');
    const parsed = await parseProductText('商品名称：便携榨汁杯\n分类：小家电\n价格：99.9\n库存：1,200\nSKU：JUICE-01\n卖点：轻巧便携、USB 充电');

    expect(parsed.source).toBe('local-fallback');
    expect(parsed.product).toMatchObject({ name: '便携榨汁杯', category: '小家电', price: '¥99.9', stock: 1200, sku: 'JUICE-01' });
    expect(parsed.product.sellingPoints).toEqual(['轻巧便携', 'USB 充电']);
  });

  it('accepts compact pasted labels commonly copied from product cards', async () => {
    vi.stubEnv('DOUBAO_API_KEY', '');
    vi.stubEnv('DOUBAO_ENDPOINT_ID', '');
    const parsed = await parseProductText('商品：轻盈防晒乳\n直播价：99元\n库存：260件\nSKU：SUN-099\n卖点：肤感清爽，适合日常通勤');

    expect(parsed.product).toMatchObject({ name: '轻盈防晒乳', price: '¥99', stock: 260, sku: 'SUN-099' });
    expect(parsed.warnings).not.toContain('未识别到明确商品名称，请保存前确认。');
    expect(parsed.warnings).not.toContain('未识别到价格，请保存前补充。');
  });
});

describe('collaborative compliance rules', () => {
  it('publishes room rules immediately and gates shared rules behind owner approval', () => {
    const { catalog, directory } = createCatalog();
    const sourceRoom = catalog.createRoom({ name: '源直播间', accountName: '源账号', ownerActorId: 'owner-a' });
    const targetRoom = catalog.createRoom({ name: '目标直播间', accountName: '目标账号', ownerActorId: 'owner-b' });
    const rules = new FileRuleCatalog(catalog, path.join(directory, 'rules.json'));
    const input = {
      name: '内部极限词', matchType: 'contains' as const, pattern: '行业第一', risk: 'warning' as const,
      title: '内部收集风险词', reason: '该表达在历史直播中触发过处罚。', alternative: '可以改为：这款商品受到很多用户关注。', policyRef: '内部案例库',
    };

    const roomRule = rules.create(sourceRoom.id, 'staff-a', { ...input, scope: 'room' });
    expect(roomRule.status).toBe('published');
    expect(rules.listActive(sourceRoom.id).map((rule) => rule.id)).toContain(roomRule.id);

    const sharedRule = rules.create(sourceRoom.id, 'staff-a', { ...input, name: '共享极限词', scope: 'shared' });
    expect(sharedRule.status).toBe('pending_review');
    expect(rules.listActive(targetRoom.id).map((rule) => rule.id)).not.toContain(sharedRule.id);

    rules.approve(sharedRule.id, 'owner');
    expect(rules.listActive(targetRoom.id).map((rule) => rule.id)).toContain(sharedRule.id);
    const edited = rules.update(sharedRule.id, 'owner', { pattern: '全行业第一' });
    expect(edited.version).toBe(2);
    const rolledBack = rules.rollback(sharedRule.id, 1, 'owner');
    expect(rolledBack.version).toBe(3);
    expect(rolledBack.pattern).toBe('行业第一');
    expect(rules.audits(sourceRoom.id).map((audit) => audit.action)).toEqual(expect.arrayContaining(['created', 'approved', 'edited', 'rolled_back']));
  });
});

describe('transcript correction', () => {
  it('keeps the original text in the timeline and re-runs compliance on the correction', async () => {
    const { catalog, directory } = createCatalog();
    const rules = new FileRuleCatalog(catalog, path.join(directory, 'rules.json'));
    rules.create('room-default', 'owner', {
      name: '内部处罚词', scope: 'room', matchType: 'contains', pattern: '神奇词', risk: 'blocked',
      title: '命中内部处罚词', reason: '该词来自内部处罚案例。', alternative: '可以改为：根据页面信息介绍商品特点。', policyRef: '内部案例库',
    });
    const timelineStore = new FileTimelineStore(path.join(directory, 'timeline'));
    const session = new LiveSession('live-correction-test', { timelineStore, productCatalog: catalog, ruleCatalog: rules, roomId: 'room-default', actorId: 'staff-a' });
    session.ingestTranscript('这是普通商品介绍');
    const segmentId = session.state.transcriptHistory[0].id;

    session.correctTranscript(segmentId, '这里包含一个神奇词', 'staff-b');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.state.transcriptHistory[0].text).toBe('这里包含一个神奇词');
    expect(session.state.latestCompliance).toMatchObject({ risk: 'blocked', source: 'custom-rule', title: '命中内部处罚词' });
    expect(session.state.stats).toMatchObject({ safeCount: 0, blockedCount: 1 });
    expect(timelineStore.exportSession(session.id)?.events.find((event) => event.type === 'transcript.corrected')?.payload).toMatchObject({
      segmentId,
      originalText: '这是普通商品介绍',
      correctedText: '这里包含一个神奇词',
      actorId: 'staff-b',
    });
  });
});
