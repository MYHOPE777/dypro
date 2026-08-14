import { describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT } from '../../src/shared/products';
import { SqliteFactStore } from './store';
import { RulePackageRegistry } from './rulePackages';

describe('RulePackageRegistry', () => {
  it('keeps document versions and reports changed lines for operations review', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const registry = new RulePackageRegistry(store, () => 100);
    registry.ingestDocument({ id: 'douyin-food', platform: 'douyin-ecommerce-live', title: '抖音滋补规则', publisher: '平台', content: '第一条\n第二条' });
    const second = registry.ingestDocument({ id: 'douyin-food', platform: 'douyin-ecommerce-live', title: '抖音滋补规则', publisher: '平台', content: '第一条\n第三条\n新增条款' });
    expect(second.document.status).toBe('pending_review');
    expect(second.version.diffSummary).toMatchObject({ added: 1, removed: 0, changed: 1 });
    expect(registry.documentVersions('douyin-food')).toHaveLength(2);
    const extracted = registry.extractDraftUnits(second.document, second.version, 'reviewer');
    expect(extracted.length).toBeGreaterThan(0);
    expect(extracted.every((unit) => unit.status === 'pending_review')).toBe(true);
    store.close();
  });

  it('keeps semantic findings as pending semantic units instead of keyword rules', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const registry = new RulePackageRegistry(store, () => 100);
    const unit = registry.confirmSemanticFinding('room-default', 'operator', { ruleKind: 'context', productId: DEFAULT_PRODUCT.id, risk: 'warning', title: '隐喻暗示', reason: '需要结合连续语义判断', alternative: '改为描述可核验卖点', policyRef: '平台规则', confidence: 0.91, transcript: '发动机加满汽油身体就有劲' }, DEFAULT_PRODUCT);
    expect(unit).toMatchObject({ kind: 'context', status: 'pending_review', enabled: false, source: 'doubao' });
    expect(unit.pattern).toBeUndefined();
    expect(registry.asComplianceRules({ roomId: 'room-default', product: DEFAULT_PRODUCT })).toHaveLength(0);
    expect(registry.reviewUnit(unit.id, 'operator', 'approved')).toMatchObject({ status: 'active', enabled: true });
    expect(registry.asComplianceRules({ roomId: 'room-default', product: DEFAULT_PRODUCT })).toHaveLength(0);
    store.close();
  });

  it('requires scoped package fields and keeps semantic public review separate', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const registry = new RulePackageRegistry(store, () => 100);
    expect(() => registry.createPackage('reviewer', { name: '缺平台', layer: 'platform' })).toThrow('平台规则包必须指定平台');
    expect(() => registry.createPackage('reviewer', { name: '缺直播间', layer: 'product', productId: DEFAULT_PRODUCT.id })).toThrow('商品规则包必须同时指定直播间和商品');
    const unit = registry.confirmSemanticFinding('room-default', 'operator', { ruleKind: 'sentence', productId: DEFAULT_PRODUCT.id, risk: 'blocked', title: '医疗承诺', reason: '需要结合上下文判断', alternative: '改为介绍页面信息', policyRef: '抖音规则', confidence: 0.96, transcript: '一定能治好喉咙痛' }, DEFAULT_PRODUCT);
    const active = registry.reviewUnit(unit.id, 'operator', 'approved');
    expect(registry.submitPublicUnit(active.id, 'operator')).toMatchObject({ publicStatus: 'pending' });
    expect(registry.listPublicCandidates()).toHaveLength(1);
    expect(registry.reviewPublicUnit(active.id, 'reviewer', 'adopted')).toMatchObject({ publicStatus: 'adopted' });
    expect(registry.semanticInstructions({ roomId: 'another-room', product: DEFAULT_PRODUCT, platform: 'douyin-ecommerce-live', industry: DEFAULT_PRODUCT.complianceProfile?.industry })).toContainEqual(expect.objectContaining({ title: '医疗承诺' }));
    store.close();
  });

  it('requires both document and unit approval before a document rule can activate', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const registry = new RulePackageRegistry(store, () => 100);
    const imported = registry.ingestDocument({ id: 'doc-1', platform: 'douyin-ecommerce-live', title: '官方规则', publisher: '平台', content: '不得宣传治疗功效' });
    const unit = registry.extractDraftUnits(imported.document, imported.version, 'reviewer')[0]!;
    expect(registry.reviewUnit(unit.id, 'reviewer', 'approved')).toMatchObject({ status: 'pending_publish', enabled: false });
    expect(registry.reviewDocument(imported.document.id, 'reviewer', 'approved').status).toBe('published');
    expect(store.getRuleUnit(unit.id)).toMatchObject({ status: 'active', enabled: true });
    store.close();
  });

  it('creates idempotent target-specific manual sync jobs', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const first = store.createManualSyncJobs({ resourceType: 'rule_unit', resourceId: 'unit-1', resourceVersion: 1, payload: { ok: true }, targets: ['merchant_database', 'private_knowledge_base'], actorId: 'operator', now: 100 });
    const second = store.createManualSyncJobs({ resourceType: 'rule_unit', resourceId: 'unit-1', resourceVersion: 1, payload: { ok: true }, targets: ['merchant_database'], actorId: 'operator', now: 101 });
    expect(first).toHaveLength(2);
    expect(second[0]?.idempotencyKey).toBe('rule_unit:unit-1:1:merchant_database');
    expect(store.listResourceDeliveryJobs('queued')).toHaveLength(2);
    store.close();
  });
});
