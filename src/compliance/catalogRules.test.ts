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
  vi.unstubAllGlobals();
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
    vi.stubEnv('ARK_API_KEY', '');
    vi.stubEnv('ARK_MODEL', '');
    const parsed = await parseProductText('商品名称：便携榨汁杯\n分类：小家电\n价格：99.9\n库存：1,200\nSKU：JUICE-01\n卖点：轻巧便携、USB 充电');

    expect(parsed.source).toBe('local-fallback');
    expect(parsed.product).toMatchObject({ name: '便携榨汁杯', category: '小家电', price: '¥99.9', stock: 1200, sku: 'JUICE-01' });
    expect(parsed.product.sellingPoints).toEqual(['轻巧便携', 'USB 充电']);
  });

  it('accepts compact pasted labels commonly copied from product cards', async () => {
    vi.stubEnv('ARK_API_KEY', '');
    vi.stubEnv('ARK_MODEL', '');
    const parsed = await parseProductText('商品：轻盈防晒乳\n直播价：99元\n库存：260件\nSKU：SUN-099\n卖点：肤感清爽，适合日常通勤');

    expect(parsed.product).toMatchObject({ name: '轻盈防晒乳', price: '¥99', stock: 260, sku: 'SUN-099' });
    expect(parsed.warnings).not.toContain('未识别到明确商品名称，请保存前确认。');
    expect(parsed.warnings).not.toContain('未识别到价格，请保存前补充。');
  });

  it('keeps missing Doubao stock as unknown instead of converting it to zero', async () => {
    vi.stubEnv('ARK_API_KEY', 'test-key');
    vi.stubEnv('ARK_MODEL', 'test-model');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ name: '同名水杯', price: '¥59', sku: 'CUP-A' }) }] }] }), { status: 200 })));

    const parsed = await parseProductText('同名水杯，直播价 59 元');

    expect(parsed.product.stock).toBeNull();
    expect(parsed.warnings).toContain('豆包未识别到库存，库存暂按待确认处理。');
  });

  it('creates different product ids for the same name with different SKUs', async () => {
    vi.stubEnv('ARK_API_KEY', '');
    vi.stubEnv('ARK_MODEL', '');
    const first = await parseProductText('商品：同名水杯\nSKU：CUP-A\n价格：59\n库存：10');
    const second = await parseProductText('商品：同名水杯\nSKU：CUP-B\n价格：69\n库存：20');

    expect(first.product.id).not.toBe(second.product.id);
  });

  it('rejects oversized pasted content before sending it to Doubao', async () => {
    vi.stubEnv('ARK_API_KEY', 'test-key');
    vi.stubEnv('ARK_MODEL', 'test-model');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(parseProductText('商品：' + '字'.repeat(20_001))).rejects.toThrow('商品信息不能超过 20000 个字符');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('collaborative compliance rules', () => {
  it('stores high-confidence Doubao findings as reviewable room candidates', () => {
    const { catalog, directory } = createCatalog();
    const rules = new FileRuleCatalog(catalog, path.join(directory, 'rules.json'));

    const learned = rules.learnFromResult('room-default', 'live-learning-test', {
      id: 'doubao-result',
      productId: 'serum',
      risk: 'blocked',
      title: '虚假效果承诺',
      reason: '该表达对所有消费者作出确定效果保证。',
      alternative: '可以改为：实际体验因人而异，请以商品页面为准。',
      policyRef: '直播电商宣传规范',
      confidence: 0.97,
      source: 'doubao',
      ruleKind: 'term',
      transcript: '这一款保证三天彻底改善',
      matchedTerms: ['保证三天彻底改善'],
      createdAt: Date.now(),
    });

    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({
      roomId: 'room-default',
      pattern: '保证三天彻底改善',
      risk: 'blocked',
      status: 'pending_review',
      origin: 'learned',
      evidenceCount: 1,
      confidence: 0.97,
    });
    expect(rules.listActive('room-default')).toEqual([]);
  });

  it('does not learn uncertain findings or findings without an exact matched term', () => {
    const { catalog, directory } = createCatalog();
    const rules = new FileRuleCatalog(catalog, path.join(directory, 'rules.json'));
    const finding = {
      id: 'uncertain-result', productId: 'serum', risk: 'warning' as const, title: '需核验', reason: '证据不足',
      alternative: '以页面信息为准。', policyRef: '平台规则', confidence: 0.92, source: 'doubao' as const,
      transcript: '今天价格不错', matchedTerms: ['价格不错'], ruleKind: 'term' as const, createdAt: Date.now(),
    };

    expect(rules.learnFromResult('room-default', 'live-learning-test', finding)).toEqual([]);
    expect(rules.learnFromResult('room-default', 'live-learning-test', { ...finding, confidence: 0.99, matchedTerms: ['原话里没有的词'] })).toEqual([]);
    expect(rules.list('room-default')).toEqual([]);
  });

  it('merges repeated evidence and promotes cross-room candidates to shared review', () => {
    const { catalog, directory } = createCatalog();
    const secondRoom = catalog.createRoom({ name: '二号直播间', accountName: '二号账号', ownerActorId: 'owner-b' });
    const rules = new FileRuleCatalog(catalog, path.join(directory, 'rules.json'));
    const finding = {
      id: 'finding-1', productId: 'serum', risk: 'warning' as const, title: '价格承诺', reason: '无法核验全网价格。',
      alternative: '当前价格以商品页面为准。', policyRef: '价格宣传规范', confidence: 0.96, source: 'doubao' as const,
      transcript: '这是全平台最低价', matchedTerms: ['全平台最低价'], ruleKind: 'term' as const, createdAt: Date.now(),
    };

    const first = rules.learnFromResult('room-default', 'live-first', finding)[0];
    const second = rules.learnFromResult('room-default', 'live-second', { ...finding, id: 'finding-2', confidence: 0.98 })[0];
    const crossRoom = rules.learnFromResult(secondRoom.id, 'live-third', { ...finding, id: 'finding-3' })[0];

    expect(second.id).toBe(first.id);
    expect(crossRoom.id).toBe(first.id);
    expect(crossRoom).toMatchObject({ scope: 'shared', status: 'pending_review', evidenceCount: 3, confidence: 0.98 });
    expect(crossRoom.evidenceRoomIds).toEqual(expect.arrayContaining(['room-default', secondRoom.id]));
    expect(rules.list('room-default')).toHaveLength(1);
    expect(rules.list(secondRoom.id)).toHaveLength(1);
  });

  it('treats rejection as correction feedback and suppresses the same learned candidate', () => {
    const { catalog, directory } = createCatalog();
    const rules = new FileRuleCatalog(catalog, path.join(directory, 'rules.json'));
    const finding = {
      id: 'finding-rejected', productId: 'serum', risk: 'warning' as const, title: '待核验表达', reason: '模型认为需要核验。',
      alternative: '以页面为准。', policyRef: '平台规则', confidence: 0.98, source: 'doubao' as const,
      transcript: '这个词其实是商品名', matchedTerms: ['这个词'], ruleKind: 'term' as const, createdAt: Date.now(),
    };

    const candidate = rules.learnFromResult('room-default', 'live-first', finding)[0];
    rules.reject(candidate.id, 'owner', '这是已核验的商品专有名称');

    expect(rules.learnFromResult('room-default', 'live-second', { ...finding, id: 'finding-again' })).toEqual([]);
    expect(rules.list('room-default')).toHaveLength(1);
    expect(rules.list('room-default')[0].status).toBe('rejected');
  });

  it('never turns sentence or context semantics into automatic term rules', () => {
    const { catalog, directory } = createCatalog();
    const rules = new FileRuleCatalog(catalog, path.join(directory, 'rules.json'));
    const finding = {
      id: 'context-finding', productId: 'supplement', risk: 'blocked' as const, title: '健康暗示', reason: '上下文隐喻人体器官。',
      alternative: '只介绍产品成分和使用方法。', policyRef: '健康宣传', confidence: 0.99, source: 'doubao' as const,
      transcript: '发动机需要好汽油', matchedTerms: ['发动机', '汽油'], ruleKind: 'context' as const, createdAt: Date.now(),
    };

    expect(rules.learnFromResult('room-default', 'live-context', finding)).toEqual([]);
    expect(rules.list('room-default')).toEqual([]);
  });

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

  it('rejects regular expressions that can cause catastrophic backtracking', () => {
    const { catalog, directory } = createCatalog();
    const rules = new FileRuleCatalog(catalog, path.join(directory, 'rules.json'));

    expect(() => rules.create('room-default', 'owner', {
      name: '危险正则', scope: 'room', matchType: 'regex', pattern: '(a+)+$', risk: 'warning',
      title: '风险提示', reason: '测试', alternative: '替代表达', policyRef: '内部规则',
    })).toThrow('正则表达式存在性能风险');
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
    let now = 1_000;
    const session = new LiveSession('live-correction-test', { timelineStore, productCatalog: catalog, ruleCatalog: rules, roomId: 'room-default', actorId: 'staff-a', now: () => now });
    session.ingestTranscript('这是普通商品介绍');
    const segmentId = session.state.transcriptHistory[0].id;
    now = 2_000;
    session.ingestTranscript('这是稍后说的第二句话');

    now = 3_000;
    session.correctTranscript(segmentId, '这里包含一个神奇词', 'staff-b');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.state.transcriptHistory[0].text).toBe('这里包含一个神奇词');
    expect(session.state.latestCompliance).toMatchObject({ risk: 'blocked', source: 'custom-rule', title: '命中内部处罚词' });
    expect(session.state.stats).toMatchObject({ safeCount: 1, blockedCount: 1 });
    expect(timelineStore.exportSession(session.id)?.events.find((event) => event.type === 'transcript.corrected')?.payload).toMatchObject({
      segmentId,
      originalText: '这是普通商品介绍',
      correctedText: '这里包含一个神奇词',
      actorId: 'staff-b',
    });
    const restored = new LiveSession(session.id, { timelineStore, productCatalog: catalog, ruleCatalog: rules, roomId: 'room-default', actorId: 'staff-a', now: () => 4_000 });
    expect(restored.state.transcriptHistory.map((segment) => segment.text)).toEqual(['这里包含一个神奇词', '这是稍后说的第二句话']);
  });
});
