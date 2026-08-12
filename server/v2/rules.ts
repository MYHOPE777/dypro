import { randomUUID } from 'node:crypto';
import type { ComplianceResult, ComplianceRule, ComplianceRuleScope, Product, PublicRuleStatus, RiskLevel, RuleAuditEntry } from '../../src/shared/types';
import { SqliteFactStore } from './store';

export type RuleDraft = { name: string; pattern: string; matchType?: 'contains' | 'regex'; risk: RiskLevel; title: string; reason: string; alternative: string; policyRef: string; scope?: ComplianceRuleScope; productId?: string; category?: string };

export class RuleModule {
  constructor(private readonly store: SqliteFactStore, private readonly now: () => number = Date.now) {}
  list(roomId: string): ComplianceRule[] { return this.store.listRules(roomId); }
  active(roomId: string, product?: Product): ComplianceRule[] {
    return [...this.store.listRules(roomId, true), ...this.store.listRules('public-library', true)].filter((rule) => {
      if (rule.scope === 'product') return Boolean(product && rule.productId === product.id);
      if (rule.scope === 'category') return Boolean(product && rule.category === product.category);
      if (rule.scope === 'shared' && rule.category) return Boolean(product && rule.category === product.category);
      return true;
    });
  }
  audits(roomId: string): RuleAuditEntry[] { return this.store.listRuleAudits(roomId); }

  confirmFinding(roomId: string, actorId: string, result: ComplianceResult, target: Product): ComplianceRule {
    if (result.risk === 'safe') throw new Error('安全表达不能创建风险规则');
    const matchedTerms = [...new Set((result.matchedTerms ?? []).map((term) => term.trim()).filter((term) => term && result.transcript.includes(term)))];
    const pattern = result.ruleKind === 'term' && matchedTerms.length === 1 ? matchedTerms[0] : result.transcript.trim();
    if (!pattern) throw new Error('没有可保存的违规片段');
    const existing = this.list(roomId).find((rule) => rule.matchType === 'contains' && rule.pattern.toLocaleLowerCase() === pattern.toLocaleLowerCase() && rule.productId === target.id);
    const now = this.now();
    if (existing) {
      if (existing.lastFindingId === result.id) return existing;
      const confirmed: ComplianceRule = { ...existing, enabled: true, status: 'published', publicStatus: existing.publicStatus ?? 'not_submitted', confidence: Math.max(existing.confidence ?? 0, result.confidence), evidenceCount: (existing.evidenceCount ?? 0) + 1, evidenceText: result.transcript.trim(), matchedTerms, ruleKind: result.ruleKind, lastFindingId: result.id, lastSeenAt: now, updatedAt: now, approvedBy: actorId, version: existing.version + 1 };
      return this.store.saveRule(confirmed, { actorId, action: 'approved', details: { source: 'live-confirmation', resultId: result.id }, occurredAt: now });
    }
    const rule: ComplianceRule = {
      id: `rule-${randomUUID()}`, roomId, scope: 'product', productId: target.id, category: target.category,
      name: `主播确认：${pattern.slice(0, 32)}`, matchType: 'contains', pattern, risk: result.risk,
      title: result.title, reason: result.reason, alternative: result.alternative, policyRef: result.policyRef,
      enabled: true, status: 'published', publicStatus: 'not_submitted', version: 1, origin: 'confirmed',
      confidence: result.confidence, evidenceCount: 1, evidenceRoomIds: [roomId], lastSeenAt: now,
      evidenceText: result.transcript.trim(), matchedTerms, ruleKind: result.ruleKind, lastFindingId: result.id,
      lastSessionId: result.segmentId, createdBy: actorId, approvedBy: actorId, createdAt: now, updatedAt: now,
    };
    return this.store.saveRule(rule, { actorId, action: 'approved', details: { source: 'live-confirmation', resultId: result.id }, occurredAt: now });
  }

  submitPublic(ruleId: string, actorId: string): ComplianceRule {
    const current = this.store.getRule(ruleId);
    if (!current) throw new Error('规则不存在');
    if (current.status !== 'published' || !current.enabled) throw new Error('只有已启用的本地规则才能提交运营审核');
    if (!current.category) throw new Error('规则缺少商品品类，暂不能提交公共规则库');
    if (current.publicStatus === 'pending' || current.publicStatus === 'adopted') return current;
    const now = this.now();
    const rule: ComplianceRule = { ...current, publicStatus: 'pending', publicSubmittedBy: actorId, publicSubmittedAt: now, publicReviewedBy: undefined, publicReviewedAt: undefined, version: current.version + 1, updatedAt: now };
    return this.store.saveRule(rule, { actorId, action: 'public_submitted', details: { previousPublicStatus: current.publicStatus ?? 'not_submitted' }, occurredAt: now });
  }

  reviewPublic(ruleId: string, actorId: string, decision: Exclude<PublicRuleStatus, 'not_submitted' | 'pending'>): ComplianceRule {
    const current = this.store.getRule(ruleId);
    if (!current) throw new Error('规则不存在');
    if (current.publicStatus !== 'pending') throw new Error('规则当前不在运营审核队列');
    const now = this.now();
    const rule: ComplianceRule = { ...current, publicStatus: decision, publicReviewedBy: actorId, publicReviewedAt: now, version: current.version + 1, updatedAt: now };
    const action = decision === 'adopted' ? 'public_adopted' : decision === 'deferred' ? 'public_deferred' : 'public_discarded';
    const reviewed = this.store.saveRule(rule, { actorId, action, details: { publicDecision: decision }, occurredAt: now });
    if (decision === 'adopted') {
      const publicRule: ComplianceRule = {
        ...reviewed,
        id: `public-${reviewed.id}`,
        roomId: 'public-library',
        scope: 'shared',
        productId: undefined,
        name: `公共规则：${reviewed.pattern.slice(0, 32)}`,
        publicStatus: 'adopted',
        version: 1,
        origin: 'synced',
        createdBy: actorId,
        approvedBy: actorId,
        createdAt: now,
        updatedAt: now,
      };
      if (!this.store.getRule(publicRule.id)) this.store.saveRule(publicRule, { actorId, action: 'public_adopted', details: { sourceRuleId: reviewed.id }, occurredAt: now });
    }
    return reviewed;
  }

  create(roomId: string, actorId: string, draft: RuleDraft): ComplianceRule {
    const now = this.now();
    const scope = draft.scope === 'product' || draft.scope === 'category' ? draft.scope : 'room';
    const rule: ComplianceRule = { id: `rule-${randomUUID()}`, roomId, scope, ...(scope === 'product' && draft.productId ? { productId: draft.productId } : {}), ...((scope === 'product' || scope === 'category') && draft.category ? { category: draft.category } : {}), name: draft.name.trim(), matchType: draft.matchType ?? 'contains', pattern: draft.pattern.trim(), risk: draft.risk, title: draft.title.trim(), reason: draft.reason.trim(), alternative: draft.alternative.trim(), policyRef: draft.policyRef.trim(), enabled: true, status: 'published', version: 1, origin: 'manual', confidence: 1, evidenceCount: 1, evidenceRoomIds: [roomId], createdBy: actorId, approvedBy: actorId, createdAt: now, updatedAt: now };
    if (!rule.name || !rule.pattern || !rule.title) throw new Error('规则名称、匹配内容和提醒标题不能为空');
    if (scope === 'product' && !rule.productId) throw new Error('商品级规则必须指定商品');
    if (scope === 'category' && !rule.category) throw new Error('品类级规则必须指定品类');
    return this.store.saveRule(rule, { actorId, action: 'created', details: { origin: 'manual' }, occurredAt: now });
  }

  update(ruleId: string, actorId: string, patch: Partial<RuleDraft> & { enabled?: boolean }): ComplianceRule {
    const current = this.store.getRule(ruleId);
    if (!current) throw new Error('规则不存在');
    if (patch.enabled !== undefined && current.status !== 'published') throw new Error('待审核或已驳回规则必须通过审核后才能启用');
    const now = this.now();
    const scope = patch.scope === 'product' || patch.scope === 'category' || patch.scope === 'room' || patch.scope === 'shared' ? patch.scope : current.scope;
    const contentChanged = Object.keys(patch).some((key) => key !== 'enabled');
    const publicReset = contentChanged && current.publicStatus && current.publicStatus !== 'not_submitted'
      ? { publicStatus: 'not_submitted' as const, publicSubmittedBy: undefined, publicSubmittedAt: undefined, publicReviewedBy: undefined, publicReviewedAt: undefined }
      : {};
    const rule: ComplianceRule = { ...current, ...patch, ...publicReset, scope, ...(scope === 'product' ? { productId: patch.productId ?? current.productId } : { productId: undefined }), ...(scope === 'category' ? { category: patch.category ?? current.category } : { category: undefined }), name: patch.name?.trim() ?? current.name, pattern: patch.pattern?.trim() ?? current.pattern, title: patch.title?.trim() ?? current.title, reason: patch.reason?.trim() ?? current.reason, alternative: patch.alternative?.trim() ?? current.alternative, policyRef: patch.policyRef?.trim() ?? current.policyRef, version: current.version + 1, updatedAt: now };
    if (scope === 'product' && !rule.productId) throw new Error('商品级规则必须指定商品');
    if (scope === 'category' && !rule.category) throw new Error('品类级规则必须指定品类');
    return this.store.saveRule(rule, { actorId, action: patch.enabled === undefined ? 'edited' : patch.enabled ? 'enabled' : 'disabled', details: { previousVersion: current.version }, occurredAt: now });
  }

  review(ruleId: string, actorId: string, decision: 'approved' | 'rejected'): ComplianceRule {
    const current = this.store.getRule(ruleId);
    if (!current) throw new Error('规则不存在');
    const now = this.now();
    const rule: ComplianceRule = { ...current, enabled: decision === 'approved', status: decision === 'approved' ? 'published' : 'rejected', approvedBy: decision === 'approved' ? actorId : undefined, version: current.version + 1, updatedAt: now };
    return this.store.saveRule(rule, { actorId, action: decision, details: { previousVersion: current.version }, occurredAt: now });
  }

  rollback(ruleId: string, actorId: string, targetVersion: number): ComplianceRule {
    const current = this.store.getRule(ruleId);
    const target = this.store.getRuleVersion(ruleId, targetVersion);
    if (!current || !target) throw new Error('规则版本不存在');
    const now = this.now();
    const rule: ComplianceRule = { ...target, id: current.id, roomId: current.roomId, version: current.version + 1, updatedAt: now };
    return this.store.saveRule(rule, { actorId, action: 'rolled_back', details: { previousVersion: current.version, targetVersion }, occurredAt: now });
  }

  learn(roomId: string, sessionId: string, result: ComplianceResult, product?: Product): ComplianceRule[] {
    // Local built-ins already run on every sentence. Only a high-confidence
    // remote term finding is novel enough to become a durable room rule.
    if (result.source !== 'doubao' || result.risk === 'safe' || result.ruleKind !== 'term' || result.confidence < 0.95) return [];
    return (result.matchedTerms ?? []).map((term) => term.trim()).filter((term) => term.length >= 2 && term.length <= 40).slice(0, 4).map((term) => {
      const existing = this.list(roomId).find((rule) => rule.matchType === 'contains' && rule.pattern.toLocaleLowerCase() === term.toLocaleLowerCase() && (rule.scope !== 'product' || rule.productId === product?.id));
      const now = this.now();
      if (existing) {
        const observed: ComplianceRule = { ...existing, version: existing.version + 1, confidence: Math.max(existing.confidence ?? 0, result.confidence), evidenceCount: (existing.evidenceCount ?? 1) + 1, lastSeenAt: now, lastSessionId: sessionId, updatedAt: now };
        return this.store.saveRule(observed, { actorId: 'system', action: 'observed', details: { sessionId, confidence: result.confidence }, occurredAt: now });
      }
      const learned: ComplianceRule = { id: `rule-${randomUUID()}`, roomId, scope: product ? 'product' : 'room', ...(product ? { productId: product.id, category: product.category } : {}), name: `待审核风险词：${term}`, matchType: 'contains', pattern: term, risk: result.risk, title: result.title, reason: result.reason, alternative: result.alternative, policyRef: result.policyRef, enabled: false, status: 'pending_review', version: 1, origin: 'learned', confidence: result.confidence, evidenceCount: 1, evidenceRoomIds: [roomId], evidenceText: result.transcript.trim(), matchedTerms: result.matchedTerms, ruleKind: result.ruleKind, lastFindingId: result.id, lastSeenAt: now, lastSessionId: sessionId, createdBy: 'system', createdAt: now, updatedAt: now };
      return this.store.saveRule(learned, { actorId: 'system', action: 'learned', details: { sessionId, confidence: result.confidence }, occurredAt: now });
    });
  }
}
