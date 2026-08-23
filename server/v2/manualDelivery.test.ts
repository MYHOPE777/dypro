import { describe, expect, it } from 'vitest';
import { ManualDeliveryModule } from './manualDelivery';

describe('ManualDeliveryModule', () => {
  it('validates active resources before creating target-specific jobs', () => {
    const calls: unknown[] = [];
    const store = {
      getRule: () => ({ id: 'rule-1', roomId: 'room-1', version: 2, status: 'published', enabled: true }),
      getRuleUnit: () => ({ id: 'unit-1', packageId: 'package-1', version: 3, status: 'active', enabled: true }),
      getRulePackage: () => ({ id: 'package-1', roomId: 'room-1' }),
      getPhrase: () => ({ id: 'phrase-1', roomId: 'room-1', version: 1, text: '参考话术' }),
      createManualSyncJobs: (input: unknown) => { calls.push(input); return []; },
      listResourceDeliveryJobs: () => [],
    } as never;
    const module = new ManualDeliveryModule(store);
    module.syncRule('rule-1', ['merchant_database'], 'operator');
    module.syncRuleUnit('unit-1', ['private_knowledge_base'], 'operator');
    module.syncPhrase('phrase-1', ['merchant_database'], 'operator');
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: 'rule', resourceId: 'rule-1', resourceVersion: 2 }),
      expect.objectContaining({ resourceType: 'rule_unit', resourceId: 'unit-1', resourceVersion: 3 }),
      expect.objectContaining({ resourceType: 'presenter_phrase', resourceId: 'phrase-1', resourceVersion: 1 }),
    ]));
  });
});
