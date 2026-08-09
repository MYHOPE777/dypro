import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import safeRegex from 'safe-regex2';
import type { ComplianceResult, ComplianceRule, ComplianceRuleScope, ComplianceRuleStatus, LiveRoom, RuleAuditEntry, RiskLevel } from '../src/shared/types';
import type { ProductCatalog } from './productCatalog';

export type RuleMutationListener = (event: { action: RuleAuditEntry['action']; rule: ComplianceRule; occurredAt: number }) => void;

type RuleInput = {
  name: string;
  scope: ComplianceRuleScope;
  matchType: 'contains' | 'regex';
  pattern: string;
  risk: RiskLevel;
  title: string;
  reason: string;
  alternative: string;
  policyRef: string;
};

type RuleFile = {
  schemaVersion: 1;
  rules: ComplianceRule[];
  versions: Record<string, ComplianceRule[]>;
  audits: RuleAuditEntry[];
};

export interface RuleCatalog {
  list(roomId: string): ComplianceRule[];
  listActive(roomId: string): ComplianceRule[];
  create(roomId: string, actorId: string, input: RuleInput): ComplianceRule;
  update(ruleId: string, actorId: string, patch: Partial<RuleInput>): ComplianceRule;
  approve(ruleId: string, actorId: string): ComplianceRule;
  reject(ruleId: string, actorId: string, reason?: string): ComplianceRule;
  rollback(ruleId: string, targetVersion: number, actorId: string): ComplianceRule;
  setEnabled(ruleId: string, enabled: boolean, actorId: string): ComplianceRule;
  versions(ruleId: string): ComplianceRule[];
  audits(roomId: string): RuleAuditEntry[];
  learnFromResult(roomId: string, sessionId: string, result: ComplianceResult): ComplianceRule[];
}

const DEFAULT_LEARNING_CONFIDENCE = 0.93;

function learningConfidenceFromEnv(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.RULE_LEARNING_MIN_CONFIDENCE);
  return Number.isFinite(configured) && configured >= 0.8 && configured <= 1 ? configured : DEFAULT_LEARNING_CONFIDENCE;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeId(name: string): string {
  return `rule-${createHash('sha1').update(`${name}-${Date.now()}-${randomUUID()}`).digest('hex').slice(0, 14)}`;
}

function defaultFile(): RuleFile {
  return { schemaVersion: 1, rules: [], versions: {}, audits: [] };
}

export class FileRuleCatalog implements RuleCatalog {
  private readonly filePath: string;
  private readonly productCatalog: Pick<ProductCatalog, 'getRoom' | 'listRooms'>;
  private readonly reviewerActorId: string;
  private readonly onMutation?: RuleMutationListener;
  private readonly learningConfidence: number;
  private data: RuleFile;

  constructor(productCatalog: Pick<ProductCatalog, 'getRoom' | 'listRooms'>, filePath = path.resolve(process.cwd(), '.data/rules/catalog.json'), reviewerActorId = process.env.RULE_REVIEWER_ACTOR_ID ?? 'owner', onMutation?: RuleMutationListener, learningConfidence = learningConfidenceFromEnv(process.env)) {
    this.productCatalog = productCatalog;
    this.filePath = filePath;
    this.reviewerActorId = reviewerActorId;
    this.onMutation = onMutation;
    this.learningConfidence = learningConfidence;
    this.data = this.readFile();
  }

  list(roomId: string): ComplianceRule[] {
    return clone(this.data.rules.filter((rule) => rule.roomId === roomId || rule.scope === 'shared'));
  }

  listActive(roomId: string): ComplianceRule[] {
    return clone(this.list(roomId).filter((rule) => rule.enabled && rule.status === 'published'));
  }

  create(roomId: string, actorId: string, input: RuleInput): ComplianceRule {
    const room = this.requireRoom(roomId);
    const now = Date.now();
    const rule: ComplianceRule = {
      id: makeId(input.name),
      roomId,
      scope: input.scope,
      name: input.name.trim(),
      matchType: input.matchType,
      pattern: input.pattern.trim(),
      risk: input.risk,
      title: input.title.trim(),
      reason: input.reason.trim(),
      alternative: input.alternative.trim(),
      policyRef: input.policyRef.trim(),
      enabled: true,
      status: this.nextStatus(input.scope, actorId, room),
      version: 1,
      origin: 'manual',
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    this.validateRule(rule);
    this.data.rules.push(rule);
    this.data.versions[rule.id] = [clone(rule)];
    this.audit(rule, 'created', actorId, { status: rule.status });
    this.writeFile();
    this.notify('created', rule);
    return clone(rule);
  }

  update(ruleId: string, actorId: string, patch: Partial<RuleInput>): ComplianceRule {
    const current = this.requireRule(ruleId);
    const room = this.requireRoom(current.roomId);
    this.assertCanEdit(current, actorId, room);
    const next: ComplianceRule = {
      ...current,
      ...patch,
      name: patch.name?.trim() ?? current.name,
      pattern: patch.pattern?.trim() ?? current.pattern,
      title: patch.title?.trim() ?? current.title,
      reason: patch.reason?.trim() ?? current.reason,
      alternative: patch.alternative?.trim() ?? current.alternative,
      policyRef: patch.policyRef?.trim() ?? current.policyRef,
      status: this.nextStatus(patch.scope ?? current.scope, actorId, room),
      version: current.version + 1,
      updatedAt: Date.now(),
    };
    this.validateRule(next);
    this.replaceRule(next);
    this.data.versions[ruleId] = [...(this.data.versions[ruleId] ?? []), clone(next)];
    this.audit(next, 'edited', actorId, { status: next.status, version: next.version });
    this.writeFile();
    this.notify('edited', next);
    return clone(next);
  }

  approve(ruleId: string, actorId: string): ComplianceRule {
    const current = this.requireRule(ruleId);
    const room = this.requireRoom(current.roomId);
    this.assertCanReview(current, room, actorId);
    const next = { ...current, status: 'published' as const, approvedBy: actorId, updatedAt: Date.now() };
    this.replaceRule(next);
    this.data.versions[ruleId] = [...(this.data.versions[ruleId] ?? []), clone(next)];
    this.audit(next, 'approved', actorId, { version: next.version });
    this.writeFile();
    this.notify('approved', next);
    return clone(next);
  }

  reject(ruleId: string, actorId: string, reason = ''): ComplianceRule {
    const current = this.requireRule(ruleId);
    const room = this.requireRoom(current.roomId);
    this.assertCanReview(current, room, actorId);
    const next = { ...current, status: 'rejected' as const, updatedAt: Date.now() };
    this.replaceRule(next);
    this.data.versions[ruleId] = [...(this.data.versions[ruleId] ?? []), clone(next)];
    this.audit(next, 'rejected', actorId, { reason, version: next.version });
    this.writeFile();
    this.notify('rejected', next);
    return clone(next);
  }

  rollback(ruleId: string, targetVersion: number, actorId: string): ComplianceRule {
    const current = this.requireRule(ruleId);
    const room = this.requireRoom(current.roomId);
    this.assertCanReview(current, room, actorId);
    const target = (this.data.versions[ruleId] ?? []).find((version) => version.version === targetVersion);
    if (!target) throw new Error('目标规则版本不存在');
    const next: ComplianceRule = { ...target, version: current.version + 1, status: 'published', approvedBy: actorId, updatedAt: Date.now() };
    this.replaceRule(next);
    this.data.versions[ruleId] = [...(this.data.versions[ruleId] ?? []), clone(next)];
    this.audit(next, 'rolled_back', actorId, { targetVersion, version: next.version });
    this.writeFile();
    this.notify('rolled_back', next);
    return clone(next);
  }

  setEnabled(ruleId: string, enabled: boolean, actorId: string): ComplianceRule {
    const current = this.requireRule(ruleId);
    const room = this.requireRoom(current.roomId);
    this.assertCanEdit(current, actorId, room);
    const next: ComplianceRule = { ...current, enabled, updatedAt: Date.now() };
    this.replaceRule(next);
    this.data.versions[ruleId] = [...(this.data.versions[ruleId] ?? []), clone(next)];
    this.audit(next, enabled ? 'enabled' : 'disabled', actorId, { version: next.version });
    this.writeFile();
    this.notify(enabled ? 'enabled' : 'disabled', next);
    return clone(next);
  }

  versions(ruleId: string): ComplianceRule[] {
    return clone(this.data.versions[ruleId] ?? []);
  }

  audits(roomId: string): RuleAuditEntry[] {
    return clone(this.data.audits.filter((audit) => audit.roomId === roomId || this.data.rules.find((rule) => rule.id === audit.ruleId)?.scope === 'shared'));
  }

  learnFromResult(roomId: string, sessionId: string, result: ComplianceResult): ComplianceRule[] {
    if (result.source !== 'doubao' || result.ruleKind !== 'term' || result.risk === 'safe' || result.confidence < this.learningConfidence) return [];
    this.requireRoom(roomId);
    const terms = [...new Set((result.matchedTerms ?? [])
      .map((term) => term.trim())
      .filter((term) => term.length >= 2 && term.length <= 80 && result.transcript.includes(term)))]
      .slice(0, 3);
    if (terms.length === 0) return [];
    const learned: ComplianceRule[] = [];
    const mutations: Array<{ action: RuleAuditEntry['action']; rule: ComplianceRule }> = [];
    for (const term of terms) {
      const normalizedTerm = term.normalize('NFKC').toLocaleLowerCase();
      const existing = this.data.rules.find((rule) => rule.origin === 'learned'
        && rule.matchType === 'contains'
        && rule.pattern.normalize('NFKC').toLocaleLowerCase() === normalizedTerm);
      const now = Date.now();
      if (existing) {
        if (existing.status === 'rejected') continue;
        const evidenceRoomIds = [...new Set([...(existing.evidenceRoomIds ?? [existing.roomId]), roomId])];
        const promoted = existing.scope === 'room' && existing.status === 'pending_review' && !evidenceRoomIds.every((candidate) => candidate === existing.roomId);
        const stronger = existing.status === 'pending_review' && result.risk === 'blocked' && existing.risk !== 'blocked';
        const next: ComplianceRule = {
          ...existing,
          ...(promoted ? { scope: 'shared' as const } : {}),
          ...(stronger ? {
            risk: result.risk,
            title: result.title.trim(),
            reason: result.reason.trim(),
            alternative: result.alternative.trim(),
            policyRef: result.policyRef.trim(),
          } : {}),
          version: promoted || stronger ? existing.version + 1 : existing.version,
          confidence: Math.max(existing.confidence ?? 0, result.confidence),
          evidenceCount: (existing.evidenceCount ?? 1) + 1,
          evidenceRoomIds,
          lastSeenAt: now,
          lastSessionId: sessionId,
          updatedAt: now,
        };
        this.replaceRule(next);
        if (next.version !== existing.version) this.data.versions[next.id] = [...(this.data.versions[next.id] ?? []), clone(next)];
        this.audit(next, 'observed', 'doubao-learning', { confidence: result.confidence, sessionId, sourceResultId: result.id, promoted, stronger });
        mutations.push({ action: 'observed', rule: next });
        learned.push(next);
        continue;
      }
      const rule: ComplianceRule = {
        id: makeId(`learned-${term}`),
        roomId,
        scope: 'room',
        name: `智能发现：${result.title}`,
        matchType: 'contains',
        pattern: term,
        risk: result.risk,
        title: result.title.trim(),
        reason: result.reason.trim(),
        alternative: result.alternative.trim(),
        policyRef: result.policyRef.trim(),
        enabled: true,
        status: 'pending_review',
        version: 1,
        origin: 'learned',
        confidence: result.confidence,
        evidenceCount: 1,
        evidenceRoomIds: [roomId],
        lastSeenAt: now,
        lastSessionId: sessionId,
        createdBy: 'doubao-learning',
        createdAt: now,
        updatedAt: now,
      };
      this.validateRule(rule);
      this.data.rules.push(rule);
      this.data.versions[rule.id] = [clone(rule)];
      this.audit(rule, 'learned', 'doubao-learning', { confidence: result.confidence, sessionId, sourceResultId: result.id });
      mutations.push({ action: 'learned', rule });
      learned.push(rule);
    }
    this.writeFile();
    for (const mutation of mutations) this.notify(mutation.action, mutation.rule);
    return clone(learned);
  }

  private nextStatus(scope: ComplianceRuleScope, actorId: string, room: LiveRoom): ComplianceRuleStatus {
    return scope === 'room' || actorId === this.reviewerActorId ? 'published' : 'pending_review';
  }

  private requireRoom(roomId: string): LiveRoom {
    const room = this.productCatalog.getRoom(roomId);
    if (!room) throw new Error('直播间不存在');
    return room;
  }

  private requireRule(ruleId: string): ComplianceRule {
    const rule = this.data.rules.find((candidate) => candidate.id === ruleId);
    if (!rule) throw new Error('规则不存在');
    return rule;
  }

  private assertOwner(room: LiveRoom, actorId: string): void {
    if (room.ownerActorId !== actorId) throw new Error('只有直播间负责人可以执行该操作');
  }

  private assertCanReview(rule: ComplianceRule, room: LiveRoom, actorId: string): void {
    if (rule.scope === 'shared') {
      if (actorId !== this.reviewerActorId) throw new Error('只有系统规则审核人可以审核共享规则');
      return;
    }
    this.assertOwner(room, actorId);
  }

  private assertCanEdit(rule: ComplianceRule, actorId: string, room: LiveRoom): void {
    if (rule.scope === 'shared') {
      if (rule.createdBy !== actorId && actorId !== this.reviewerActorId) throw new Error('没有编辑这条共享规则的权限');
      return;
    }
    if (rule.createdBy !== actorId && room.ownerActorId !== actorId) throw new Error('没有编辑这条规则的权限');
  }

  private validateRule(rule: ComplianceRule): void {
    if (!rule.name || !rule.pattern || !rule.title || !rule.reason || !rule.alternative) throw new Error('规则名称、匹配内容、风险说明和替代表达不能为空');
    if (rule.pattern.length > 200) throw new Error('规则匹配内容不能超过 200 个字符');
    if (rule.matchType === 'regex') {
      if (!safeRegex(rule.pattern)) throw new Error('规则正则表达式存在性能风险');
      try {
        new RegExp(rule.pattern, 'iu');
      } catch {
        throw new Error('规则正则表达式无效');
      }
    }
  }

  private replaceRule(rule: ComplianceRule): void {
    const index = this.data.rules.findIndex((candidate) => candidate.id === rule.id);
    if (index < 0) throw new Error('规则不存在');
    this.data.rules[index] = rule;
  }

  private audit(rule: ComplianceRule, action: RuleAuditEntry['action'], actorId: string, details: Record<string, unknown>): void {
    this.data.audits.push({ id: `audit-${randomUUID()}`, ruleId: rule.id, roomId: rule.roomId, action, actorId, occurredAt: Date.now(), details });
  }

  private notify(action: RuleAuditEntry['action'], rule: ComplianceRule): void {
    try { this.onMutation?.({ action, rule: clone(rule), occurredAt: Date.now() }); } catch {
      // Sync is best effort; local rule writes remain authoritative.
    }
  }

  private readFile(): RuleFile {
    if (!existsSync(this.filePath)) return defaultFile();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as RuleFile;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.rules) && parsed.versions && parsed.audits) return parsed;
    } catch {
      // Use an empty rule set if local rule storage is unavailable.
    }
    return defaultFile();
  }

  private writeFile(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}
