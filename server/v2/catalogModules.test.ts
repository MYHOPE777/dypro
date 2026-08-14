import { describe, expect, it } from 'vitest';
import { analyzeTranscript } from '../../src/compliance/engine';
import { DEFAULT_PRODUCT } from '../../src/shared/products';
import type { ComplianceResult, TranscriptSegment } from '../../src/shared/types';
import { PresenterModule } from './presenters';
import { RuleModule } from './rules';
import { SqliteFactStore } from './store';

describe('SQLite catalog modules', () => {
  it('turns only high-confidence term findings into fast local rules', async () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const rules = new RuleModule(store, () => 100);
    const finding: ComplianceResult = { id: 'finding', productId: DEFAULT_PRODUCT.id, risk: 'blocked', title: '暗示功效', reason: '测试', alternative: '安全表达', policyRef: '规则', confidence: 0.98, source: 'doubao', transcript: '神奇发动机', createdAt: 1, matchedTerms: ['神奇发动机'], ruleKind: 'term' };
    rules.learn('room-default', 'session-1', finding, DEFAULT_PRODUCT);
    expect(rules.list('room-default')[0]).toMatchObject({ status: 'pending_review', enabled: false, scope: 'product', productId: DEFAULT_PRODUCT.id });
    expect(rules.active('room-default', DEFAULT_PRODUCT)).toHaveLength(0);
    rules.review(rules.list('room-default')[0].id, 'owner', 'approved');
    const local = await analyzeTranscript({ roomId: 'room-default', productId: DEFAULT_PRODUCT.id, transcript: '又提到神奇发动机', product: DEFAULT_PRODUCT, customRules: rules.active('room-default', DEFAULT_PRODUCT) });
    expect(local.source).toBe('custom-rule');
    expect(local.risk).toBe('blocked');
    rules.learn('room-default', 'session-2', { ...finding, confidence: 0.99 }, DEFAULT_PRODUCT);
    // Approval creates a new published version before later evidence is merged.
    expect(rules.list('room-default')[0]).toMatchObject({ version: 3, evidenceCount: 2, lastSessionId: 'session-2' });
    expect(store.listResourceDeliveryJobs('queued')).toHaveLength(0);
    expect(store.listResourceDeliveryJobs('superseded')).toHaveLength(0);
    store.createManualSyncJobs({ resourceType: 'rule', resourceId: rules.list('room-default')[0]!.id, resourceVersion: 3, payload: rules.list('room-default')[0], targets: ['merchant_database'], actorId: 'owner' });
    expect(store.listResourceDeliveryJobs('queued')).toHaveLength(1);
    rules.learn('room-default', 'session-3', { ...finding, confidence: 0.7, matchedTerms: ['低置信词'] }, DEFAULT_PRODUCT);
    expect(rules.list('room-default')).toHaveLength(1);
    rules.learn('room-default', 'session-4', { ...finding, source: 'local-fallback', confidence: 0.99, matchedTerms: ['内置风险词'] }, DEFAULT_PRODUCT);
    expect(rules.list('room-default')).toHaveLength(1);
    store.close();
  });

  it('archives host transcripts into the presenter library without duplicates', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    store.ensureRoom({ id: 'room-default', tenantId: 'tenant-local' });
    const presenters = new PresenterModule(store, () => 100);
    const presenter = presenters.ensureDefault('room-default');
    const segments: TranscriptSegment[] = [
      { id: 'one', text: '主播自己的话术', isFinal: true, timestamp: 1, offsetMs: 1, startOffsetMs: 0, endOffsetMs: 1, speaker: 'host' },
      { id: 'two', text: '场外声音', isFinal: true, timestamp: 2, offsetMs: 2, startOffsetMs: 1, endOffsetMs: 2, speaker: 'other' },
    ];
    expect(presenters.archiveSession(presenter.id, 'session-1', DEFAULT_PRODUCT.id, segments)).toHaveLength(1);
    expect(presenters.archiveSession(presenter.id, 'session-1', DEFAULT_PRODUCT.id, segments)).toHaveLength(0);
    const phrase = presenters.phrases(presenter.id)[0];
    presenters.updatePhrase(phrase.id, { status: 'reference' });
    expect(presenters.references(presenter.id, DEFAULT_PRODUCT.id)[0].text).toBe('主播自己的话术');
    store.close();
  });

  it('does not let a rejected learned rule bypass review through the enabled switch', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const rules = new RuleModule(store, () => 100);
    const learned = rules.learn('room-default', 'session-1', { id: 'finding', productId: DEFAULT_PRODUCT.id, risk: 'blocked', title: '待审核', reason: '测试', alternative: '安全表达', policyRef: '测试', confidence: 0.99, source: 'doubao', transcript: '模型新风险词', createdAt: 1, matchedTerms: ['模型新风险词'], ruleKind: 'term' }, DEFAULT_PRODUCT)[0]!;

    const rejected = rules.review(learned.id, 'owner', 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', enabled: false, approvedBy: undefined });
    expect(() => rules.update(learned.id, 'owner', { enabled: true })).toThrow('必须通过审核');
    expect(rules.review(learned.id, 'owner', 'approved')).toMatchObject({ status: 'published', enabled: true, approvedBy: 'owner' });
    store.close();
  });

  it('confirms live findings locally before separately governing public rules', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const rules = new RuleModule(store, (() => { let now = 100; return () => now += 1; })());
    const termFinding: ComplianceResult = { id: 'term-finding', segmentId: 'segment-1', productId: DEFAULT_PRODUCT.id, risk: 'blocked', title: '医疗功效', reason: '包含治疗承诺', alternative: '只描述使用体验', policyRef: '广告合规', confidence: 0.97, source: 'doubao', transcript: '这个可以治疗耳聋', createdAt: 1, matchedTerms: ['治疗耳聋'], ruleKind: 'term' };

    const local = rules.confirmFinding('room-default', 'operator', termFinding, DEFAULT_PRODUCT);
    expect(local).toMatchObject({ pattern: '治疗耳聋', status: 'published', enabled: true, publicStatus: 'not_submitted', origin: 'confirmed', evidenceCount: 1, evidenceText: termFinding.transcript });
    expect(rules.confirmFinding('room-default', 'operator', termFinding, DEFAULT_PRODUCT)).toMatchObject({ id: local.id, version: 1, evidenceCount: 1 });
    expect(rules.submitPublic(local.id, 'operator')).toMatchObject({ publicStatus: 'pending' });
    expect(rules.active('room-default', DEFAULT_PRODUCT).some((rule) => rule.id === local.id)).toBe(true);

    const reviewed = rules.reviewPublic(local.id, 'service-reviewer', 'adopted');
    expect(reviewed).toMatchObject({ publicStatus: 'adopted', enabled: true, roomId: 'room-default' });
    expect(store.listRules('public-library')).toContainEqual(expect.objectContaining({ pattern: '治疗耳聋', scope: 'shared', publicStatus: 'adopted' }));
    const edited = rules.update(local.id, 'operator', { alternative: '新的安全表达' });
    expect(edited).toMatchObject({ publicStatus: 'not_submitted', alternative: '新的安全表达' });
    store.close();
  });

  it('keeps sentence and contextual evidence intact instead of banning one ordinary term', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    const rules = new RuleModule(store, () => 100);
    const contextual: ComplianceResult = { id: 'context-finding', productId: DEFAULT_PRODUCT.id, risk: 'warning', title: '隐喻暗示', reason: '跨词组合表达健康功效', alternative: '直接描述商品使用场景', policyRef: '健康宣传', confidence: 0.91, source: 'doubao', transcript: '给发动机加满汽油身体就有劲了', createdAt: 1, matchedTerms: ['发动机', '汽油'], ruleKind: 'context' };

    const rule = rules.confirmFinding('room-default', 'operator', contextual, DEFAULT_PRODUCT);
    expect(rule.pattern).toBe(contextual.transcript);
    expect(rule.matchedTerms).toEqual(['发动机', '汽油']);
    rules.submitPublic(rule.id, 'operator');
    const discarded = rules.reviewPublic(rule.id, 'service-reviewer', 'discarded');
    expect(discarded).toMatchObject({ publicStatus: 'discarded', enabled: true, roomId: 'room-default' });
    expect(store.listRules('public-library')).toHaveLength(0);
    expect(rules.active('room-default', DEFAULT_PRODUCT).some((candidate) => candidate.id === rule.id)).toBe(true);
    expect(rules.submitPublic(rule.id, 'operator')).toMatchObject({ publicStatus: 'pending', publicReviewedBy: undefined, publicReviewedAt: undefined });
    store.close();
  });
});
