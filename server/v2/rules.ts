import { randomUUID } from 'node:crypto';
import type { ComplianceResult, ComplianceRule, RiskLevel, RuleAuditEntry } from '../../src/shared/types';
import { SqliteFactStore } from './store';

export type RuleDraft = { name: string; pattern: string; matchType?: 'contains' | 'regex'; risk: RiskLevel; title: string; reason: string; alternative: string; policyRef: string };

export class RuleModule {
  constructor(private readonly store: SqliteFactStore, private readonly now: () => number = Date.now) {}
  list(roomId: string): ComplianceRule[] { return this.store.listRules(roomId); }
  active(roomId: string): ComplianceRule[] { return this.store.listRules(roomId, true); }
  audits(roomId: string): RuleAuditEntry[] { return this.store.listRuleAudits(roomId); }

  create(roomId: string, actorId: string, draft: RuleDraft): ComplianceRule {
    const now = this.now();
    const rule: ComplianceRule = { id: `rule-${randomUUID()}`, roomId, scope: 'room', name: draft.name.trim(), matchType: draft.matchType ?? 'contains', pattern: draft.pattern.trim(), risk: draft.risk, title: draft.title.trim(), reason: draft.reason.trim(), alternative: draft.alternative.trim(), policyRef: draft.policyRef.trim(), enabled: true, status: 'published', version: 1, origin: 'manual', confidence: 1, evidenceCount: 1, evidenceRoomIds: [roomId], createdBy: actorId, approvedBy: actorId, createdAt: now, updatedAt: now };
    if (!rule.name || !rule.pattern || !rule.title) throw new Error('规则名称、匹配内容和提醒标题不能为空');
    return this.store.saveRule(rule, { actorId, action: 'created', details: { origin: 'manual' }, occurredAt: now });
  }

  update(ruleId: string, actorId: string, patch: Partial<RuleDraft> & { enabled?: boolean }): ComplianceRule {
    const current = this.store.getRule(ruleId);
    if (!current) throw new Error('规则不存在');
    const now = this.now();
    const rule: ComplianceRule = { ...current, ...patch, name: patch.name?.trim() ?? current.name, pattern: patch.pattern?.trim() ?? current.pattern, title: patch.title?.trim() ?? current.title, reason: patch.reason?.trim() ?? current.reason, alternative: patch.alternative?.trim() ?? current.alternative, policyRef: patch.policyRef?.trim() ?? current.policyRef, version: current.version + 1, updatedAt: now };
    return this.store.saveRule(rule, { actorId, action: patch.enabled === undefined ? 'edited' : patch.enabled ? 'enabled' : 'disabled', details: { previousVersion: current.version }, occurredAt: now });
  }

  learn(roomId: string, sessionId: string, result: ComplianceResult): ComplianceRule[] {
    if (result.risk === 'safe' || result.ruleKind !== 'term' || result.confidence < 0.95) return [];
    return (result.matchedTerms ?? []).map((term) => term.trim()).filter((term) => term.length >= 2 && term.length <= 40).slice(0, 4).map((term) => {
      const existing = this.list(roomId).find((rule) => rule.matchType === 'contains' && rule.pattern.toLocaleLowerCase() === term.toLocaleLowerCase());
      const now = this.now();
      if (existing) {
        const observed: ComplianceRule = { ...existing, version: existing.version + 1, confidence: Math.max(existing.confidence ?? 0, result.confidence), evidenceCount: (existing.evidenceCount ?? 1) + 1, lastSeenAt: now, lastSessionId: sessionId, updatedAt: now };
        return this.store.saveRule(observed, { actorId: 'system', action: 'observed', details: { sessionId, confidence: result.confidence }, occurredAt: now });
      }
      const learned: ComplianceRule = { id: `rule-${randomUUID()}`, roomId, scope: 'room', name: `高置信风险词：${term}`, matchType: 'contains', pattern: term, risk: result.risk, title: result.title, reason: result.reason, alternative: result.alternative, policyRef: result.policyRef, enabled: true, status: 'published', version: 1, origin: 'learned', confidence: result.confidence, evidenceCount: 1, evidenceRoomIds: [roomId], lastSeenAt: now, lastSessionId: sessionId, createdBy: 'system', approvedBy: 'system', createdAt: now, updatedAt: now };
      return this.store.saveRule(learned, { actorId: 'system', action: 'learned', details: { sessionId, confidence: result.confidence }, occurredAt: now });
    });
  }
}
