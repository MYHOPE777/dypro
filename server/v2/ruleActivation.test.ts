import { describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT } from '../../src/shared/products';
import { RuleModule } from './rules';
import { RuleActivationIndex } from './ruleActivation';
import { RulePackageRegistry } from './rulePackages';
import { SqliteFactStore } from './store';

describe('RuleActivationIndex', () => {
  it('compiles room and package rules into one ordered snapshot', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const rules = new RuleModule(store, () => 100);
    const packages = new RulePackageRegistry(store, () => 100);
    rules.create('room-default', 'operator', {
      name: '直播间规则', pattern: '买一送一', risk: 'warning', title: '活动承诺', reason: '需要以页面为准',
      alternative: '活动以商品页面为准', policyRef: '直播间规则', scope: 'room',
    });
    const industry = DEFAULT_PRODUCT.complianceProfile?.industry || '美妆';
    const pkg = packages.createPackage('operator', { name: '美妆行业规则', layer: 'industry', industry });
    const unit = packages.addUnit(pkg.id, 'operator', {
      kind: 'term', pattern: '百分百有效', title: '效果保证', reason: '不可保证效果', alternative: '介绍页面信息', policyRef: '行业规则', risk: 'blocked',
    });
    packages.reviewUnit(unit.id, 'operator', 'approved');

    const snapshot = new RuleActivationIndex(rules, packages).compile({ roomId: 'room-default', product: DEFAULT_PRODUCT, platform: 'douyin-ecommerce-live', industry });
    expect(snapshot.rules.map((rule) => rule.title)).toEqual(['效果保证', '活动承诺']);
    expect(snapshot.version).toContain(`${unit.id}@2:industry:1`);
    expect(snapshot.semanticRules).toEqual([]);
    store.close();
  });

  it('keeps semantic units in the same context snapshot without turning them into terms', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const registry = new RulePackageRegistry(store, () => 100);
    const packageRegistry = new RulePackageRegistry(store, () => 100);
    const unit = registry.confirmSemanticFinding('room-default', 'operator', { ruleKind: 'context', productId: DEFAULT_PRODUCT.id, risk: 'warning', title: '隐喻暗示', reason: '结合上下文判断', alternative: '介绍页面信息', policyRef: '平台规则', confidence: 0.9, transcript: '发动机加满汽油身体就有劲' }, DEFAULT_PRODUCT);
    registry.reviewUnit(unit.id, 'operator', 'approved');
    const snapshot = new RuleActivationIndex(new RuleModule(store), packageRegistry).compile({ roomId: 'room-default', product: DEFAULT_PRODUCT, platform: 'douyin-ecommerce-live', industry: DEFAULT_PRODUCT.complianceProfile?.industry });
    expect(snapshot.rules).toHaveLength(0);
    expect(snapshot.semanticRules).toContainEqual(expect.objectContaining({ title: '隐喻暗示' }));
    store.close();
  });
});
