import { randomUUID } from 'node:crypto';
import type { ComplianceRule, Product, PublicRuleStatus, RuleDocument, RulePackage, RuleReview, RuleUnit, RuleUnitKind, RiskLevel } from '../../src/shared/types';
import { SqliteFactStore } from './store';

const layerWeight: Record<RulePackage['layer'], number> = { legal: 5, platform: 4, industry: 3, room: 2, product: 1 };

export type RulePackageDraft = {
  name: string;
  layer: RulePackage['layer'];
  platform?: RulePackage['platform'];
  industry?: string;
  roomId?: string;
  productId?: string;
  documentId?: string;
  documentVersion?: number;
  immutable?: boolean;
};

export type RuleUnitDraft = {
  kind: RuleUnitKind;
  pattern?: string;
  instruction?: string;
  contextWindow?: string;
  title: string;
  reason: string;
  alternative: string;
  policyRef: string;
  risk: RiskLevel;
  confidence?: number;
  evidenceText?: string;
  matchedTerms?: string[];
  source?: RuleUnit['source'];
};

export class RulePackageRegistry {
  constructor(private readonly store: SqliteFactStore, private readonly now: () => number = Date.now) {}

  listPackages(status?: RulePackage['status']): RulePackage[] { return this.store.listRulePackages(status); }
  listUnits(status?: RuleUnit['status']): RuleUnit[] { return this.store.listRuleUnits(status); }
  getPackage(packageId: string): RulePackage | null { return this.store.getRulePackage(packageId); }
  getUnit(unitId: string): RuleUnit | null { return this.store.getRuleUnit(unitId); }
  listPublicCandidates(): RuleUnit[] { return this.store.listRuleUnits().filter((unit) => unit.publicStatus === 'pending'); }
  listUnitsForRoom(roomId: string, status?: RuleUnit['status']): RuleUnit[] {
    const packageIds = new Set(this.store.listRulePackages().filter((pkg) => pkg.roomId === roomId).map((pkg) => pkg.id));
    return this.store.listRuleUnits(status).filter((unit) => packageIds.has(unit.packageId));
  }
  listDocuments(status?: RuleDocument['status']): RuleDocument[] { return this.store.listRuleDocuments(status); }
  getDocument(documentId: string): RuleDocument | null { return this.store.getRuleDocument(documentId); }
  documentVersions(documentId: string) { return this.store.listRuleDocumentVersions(documentId); }
  reviews(resourceId?: string): RuleReview[] { return this.store.listRuleReviews(resourceId); }

  ingestDocument(input: Parameters<SqliteFactStore['createRuleDocumentVersion']>[0]) {
    return this.store.createRuleDocumentVersion(input);
  }

  async ingestUrl(input: Omit<Parameters<SqliteFactStore['createRuleDocumentVersion']>[0], 'content' | 'source'> & { sourceUrl: string; now?: number }) {
    let url: URL;
    try { url = new URL(input.sourceUrl); } catch { throw new Error('规则文档 URL 无效'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('规则文档只支持 HTTP 或 HTTPS URL');
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { accept: 'text/plain,text/markdown,text/html;q=0.8' } });
    if (!response.ok) throw new Error(`规则文档抓取失败：HTTP ${response.status}`);
    const content = await response.text();
    if (!content.trim()) throw new Error('规则文档内容为空');
    if (content.length > 2_000_000) throw new Error('规则文档超过 2MB 限制');
    return this.ingestDocument({ ...input, source: 'url', content });
  }

  extractDraftUnits(document: RuleDocument, version: { version: number; content: string }, actorId: string): RuleUnit[] {
    const layer: RulePackage['layer'] = document.platform !== 'general' ? 'platform' : document.industry ? 'industry' : 'room';
    const pkg = this.createPackage(actorId, { name: `${document.title} v${version.version}`, layer, platform: document.platform, industry: document.industry, documentId: document.id, documentVersion: version.version });
    const lines = version.content.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length >= 4).slice(0, 500);
    return lines.map((line) => {
      const quoted = line.match(/[“"「『]([^”"」』]{2,40})[”"」』]/u)?.[1];
      const kind: RuleUnitKind = /语义|上下文|隐喻|暗示|连续|场景/u.test(line) ? 'context' : quoted ? 'term' : 'sentence';
      const risk: RiskLevel = /禁止|严禁|不得|违法|违规|处罚/u.test(line) ? 'blocked' : 'warning';
      return this.addUnit(pkg.id, actorId, { kind, pattern: kind === 'term' ? quoted : undefined, instruction: kind === 'term' ? undefined : line, contextWindow: kind === 'context' ? line : undefined, title: `${document.title}规则`, reason: line.slice(0, 180), alternative: '改为仅介绍商品页面可核验的信息。', policyRef: `${document.publisher}·${document.title}`.slice(0, 120), risk, confidence: 0.8, evidenceText: line, source: 'document' });
    });
  }

  createPackage(actorId: string, draft: RulePackageDraft): RulePackage {
    if (draft.layer === 'platform' && !draft.platform) throw new Error('平台规则包必须指定平台');
    if (draft.layer === 'industry' && !draft.industry?.trim()) throw new Error('行业规则包必须指定行业');
    if (draft.layer === 'room' && !draft.roomId) throw new Error('直播间规则包必须指定直播间');
    if (draft.layer === 'product' && (!draft.roomId || !draft.productId)) throw new Error('商品规则包必须同时指定直播间和商品');
    const now = this.now();
    const pkg: RulePackage = { id: `rule-package-${randomUUID()}`, ...draft, version: 1, status: draft.layer === 'legal' && draft.immutable ? 'active' : 'pending_review', enabled: draft.layer === 'legal' && draft.immutable === true, immutable: draft.immutable, createdBy: actorId, createdAt: now, updatedAt: now };
    return this.store.saveRulePackage(pkg);
  }

  addUnit(packageId: string, actorId: string, draft: RuleUnitDraft): RuleUnit {
    const pkg = this.store.getRulePackage(packageId);
    if (!pkg) throw new Error('规则包不存在');
    if (pkg.immutable) throw new Error('内置法律基线不可编辑');
    const now = this.now();
    const unit: RuleUnit = { id: `rule-unit-${randomUUID()}`, packageId, version: 1, kind: draft.kind, pattern: draft.pattern?.trim() || undefined, instruction: draft.instruction?.trim() || undefined, contextWindow: draft.contextWindow?.trim() || undefined, title: draft.title.trim(), reason: draft.reason.trim(), alternative: draft.alternative.trim(), policyRef: draft.policyRef.trim(), risk: draft.risk, confidence: draft.confidence ?? 1, evidenceText: draft.evidenceText?.trim() || undefined, matchedTerms: draft.matchedTerms, status: 'pending_review', enabled: false, source: draft.source ?? 'manual', publicStatus: 'not_submitted', createdAt: now, updatedAt: now };
    if (!unit.title || (!unit.pattern && !unit.instruction)) throw new Error('规则单元必须包含匹配内容或语义指令');
    return this.store.saveRuleUnit(unit);
  }

  confirmSemanticFinding(roomId: string, actorId: string, result: { ruleKind?: RuleUnitKind; productId: string; risk: RiskLevel; title: string; reason: string; alternative: string; policyRef: string; confidence: number; transcript: string; matchedTerms?: string[] }, product: Product): RuleUnit {
    if (result.ruleKind === 'term') throw new Error('词级发现应使用本地词规则确认流程');
    const pkg = this.createPackage(actorId, { name: `语义规则：${result.title}`, layer: 'product', roomId, productId: product.id, industry: product.complianceProfile?.industry, platform: product.complianceProfile?.platformRuleset, immutable: false });
    return this.addUnit(pkg.id, actorId, { kind: result.ruleKind ?? 'sentence', instruction: result.reason, contextWindow: result.transcript, title: result.title, reason: result.reason, alternative: result.alternative, policyRef: result.policyRef, risk: result.risk, confidence: result.confidence, evidenceText: result.transcript, matchedTerms: result.matchedTerms, source: 'doubao' });
  }

  reviewDocument(documentId: string, actorId: string, decision: 'approved' | 'rejected', note?: string): RuleDocument {
    const document = this.store.getRuleDocument(documentId);
    if (!document) throw new Error('规则文档不存在');
    const now = this.now();
    const next: RuleDocument = { ...document, status: decision === 'approved' ? 'published' : 'rejected', updatedAt: now };
    this.store.saveRuleDocument(next, this.store.listRuleDocumentVersions(documentId)[0] ?? { id: `rule-doc-version-${randomUUID()}`, documentId, version: next.latestVersion, content: '', contentHash: '', fetchedAt: now, createdAt: now });
    this.store.saveRuleReview({ id: `rule-review-${randomUUID()}`, resourceType: 'document', resourceId: documentId, decision, actorId, note, createdAt: now });
    if (decision === 'approved') {
      for (const pkg of this.store.listRulePackages().filter((candidate) => candidate.documentId === documentId && candidate.documentVersion === next.latestVersion)) {
        const units = this.store.listRuleUnits().filter((unit) => unit.packageId === pkg.id && unit.status === 'pending_publish');
        for (const unit of units) this.store.saveRuleUnit({ ...unit, status: 'active', enabled: true, version: unit.version + 1, updatedAt: now });
        if (units.length > 0) this.store.saveRulePackage({ ...pkg, status: 'active', enabled: true, version: pkg.version + 1, approvedBy: actorId, updatedAt: now });
      }
    }
    return next;
  }

  reviewUnit(unitId: string, actorId: string, decision: 'approved' | 'rejected' | 'deferred' | 'discarded', note?: string): RuleUnit {
    const current = this.store.getRuleUnit(unitId);
    if (!current) throw new Error('规则单元不存在');
    const pkg = this.store.getRulePackage(current.packageId);
    if (!pkg) throw new Error('规则包不存在');
    if (pkg.immutable) throw new Error('内置法律基线不可修改');
    const now = this.now();
    const document = pkg.documentId ? this.store.getRuleDocument(pkg.documentId) : null;
    const canActivate = decision === 'approved' && (!document || document.status === 'published');
    const status: RuleUnit['status'] = canActivate ? 'active' : decision === 'approved' ? 'pending_publish' : decision === 'rejected' || decision === 'discarded' ? 'rejected' : 'pending_review';
    const next: RuleUnit = { ...current, version: current.version + 1, status, enabled: canActivate, updatedAt: now };
    this.store.saveRuleUnit(next);
    this.store.saveRuleReview({ id: `rule-review-${randomUUID()}`, resourceType: 'rule_unit', resourceId: unitId, decision, actorId, note, createdAt: now });
    if (canActivate && pkg.status !== 'active') this.store.saveRulePackage({ ...pkg, status: 'active', enabled: true, approvedBy: actorId, version: pkg.version + 1, updatedAt: now });
    return next;
  }

  submitPublicUnit(unitId: string, actorId: string): RuleUnit {
    const current = this.store.getRuleUnit(unitId);
    if (!current) throw new Error('规则单元不存在');
    const pkg = this.store.getRulePackage(current.packageId);
    if (!pkg) throw new Error('规则包不存在');
    if (!pkg.roomId) throw new Error('只有商家直播间规则单元可以提交公共审核');
    if (!current.enabled || current.status !== 'active') throw new Error('只有已激活的本地规则单元才能提交运营审核');
    if (current.publicStatus === 'pending' || current.publicStatus === 'adopted') return current;
    const now = this.now();
    const next: RuleUnit = { ...current, publicStatus: 'pending', publicSubmittedBy: actorId, publicSubmittedAt: now, publicReviewedBy: undefined, publicReviewedAt: undefined, version: current.version + 1, updatedAt: now };
    this.store.saveRuleUnit(next);
    this.store.saveRuleReview({ id: `rule-review-${randomUUID()}`, resourceType: 'public_rule', resourceId: unitId, decision: 'deferred', actorId, note: '提交公共运营审核', createdAt: now });
    return next;
  }

  reviewPublicUnit(unitId: string, actorId: string, decision: Exclude<PublicRuleStatus, 'not_submitted' | 'pending'>, note?: string): RuleUnit {
    const current = this.store.getRuleUnit(unitId);
    if (!current) throw new Error('规则单元不存在');
    if (current.publicStatus !== 'pending') throw new Error('规则单元当前不在运营审核队列');
    const pkg = this.store.getRulePackage(current.packageId);
    if (!pkg) throw new Error('规则包不存在');
    const now = this.now();
    const reviewed: RuleUnit = { ...current, publicStatus: decision, publicReviewedBy: actorId, publicReviewedAt: now, version: current.version + 1, updatedAt: now };
    this.store.saveRuleUnit(reviewed);
    this.store.saveRuleReview({ id: `rule-review-${randomUUID()}`, resourceType: 'public_rule', resourceId: unitId, decision: decision === 'adopted' ? 'approved' : decision, actorId, note, createdAt: now });
    if (decision === 'adopted') this.publishPublicUnit(pkg, reviewed, actorId, now);
    return reviewed;
  }

  private publishPublicUnit(sourcePackage: RulePackage, unit: RuleUnit, actorId: string, now: number): void {
    const layer: RulePackage['layer'] = sourcePackage.platform && sourcePackage.platform !== 'general'
      ? 'platform'
      : sourcePackage.industry
        ? 'industry'
        : 'legal';
    const publicPackageId = `public-package-${sourcePackage.id}`;
    const existingPackage = this.store.getRulePackage(publicPackageId);
    const publicPackage: RulePackage = {
      id: publicPackageId,
      tenantId: sourcePackage.tenantId,
      layer,
      name: `公共规则包：${sourcePackage.name}`,
      ...(sourcePackage.platform ? { platform: sourcePackage.platform } : {}),
      ...(sourcePackage.industry ? { industry: sourcePackage.industry } : {}),
      documentId: sourcePackage.documentId,
      documentVersion: sourcePackage.documentVersion,
      version: (existingPackage?.version ?? 0) + 1,
      status: 'active',
      enabled: true,
      immutable: false,
      createdBy: existingPackage?.createdBy ?? actorId,
      approvedBy: actorId,
      createdAt: existingPackage?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.saveRulePackage(publicPackage);
    const publicUnit: RuleUnit = { ...unit, id: `public-unit-${unit.id}`, packageId: publicPackageId, version: 1, status: 'active', enabled: true, source: 'synced', publicStatus: 'adopted', publicSubmittedBy: undefined, publicSubmittedAt: undefined, publicReviewedBy: actorId, publicReviewedAt: now, createdAt: existingPackage?.createdAt ?? now, updatedAt: now };
    this.store.saveRuleUnit(publicUnit);
  }

  activeUnits(input: { roomId: string; product?: Product; platform?: RulePackage['platform']; industry?: string }): RuleUnit[] {
    const packages = this.store.listRulePackages('active').filter((pkg) => {
      if (!pkg.enabled) return false;
      if (pkg.platform && pkg.platform !== 'general' && pkg.platform !== input.platform) return false;
      if (pkg.industry && pkg.industry !== input.industry) return false;
      if (pkg.layer === 'room' && pkg.roomId !== input.roomId) return false;
      if (pkg.layer === 'product' && pkg.productId !== input.product?.id) return false;
      return true;
    });
    const packageIds = new Set(packages.map((pkg) => pkg.id));
    return this.store.listRuleUnits('active').filter((unit) => packageIds.has(unit.packageId));
  }

  semanticInstructions(input: { roomId: string; product?: Product; platform?: RulePackage['platform']; industry?: string }): Array<{ title: string; instruction?: string; contextWindow?: string; risk: RiskLevel; policyRef: string }> {
    const packages = new Set(this.activeUnits(input).map((unit) => unit.packageId));
    return this.store.listRuleUnits('active').filter((unit) => packages.has(unit.packageId) && (unit.kind === 'sentence' || unit.kind === 'context')).map((unit) => ({ title: unit.title, instruction: unit.instruction, contextWindow: unit.contextWindow, risk: unit.risk, policyRef: unit.policyRef })).slice(0, 20);
  }

  asComplianceRules(input: { roomId: string; product?: Product; platform?: RulePackage['platform']; industry?: string }): ComplianceRule[] {
    return this.activeUnits(input).filter((unit) => unit.kind !== 'context' && unit.pattern).map((unit) => {
      const pkg = this.store.getRulePackage(unit.packageId)!;
      return { id: unit.id, roomId: pkg.roomId ?? input.roomId, scope: pkg.layer === 'product' ? 'product' : pkg.layer === 'industry' ? 'category' : 'room', layer: pkg.layer, ...(pkg.productId ? { productId: pkg.productId } : {}), ...(pkg.industry ? { category: pkg.industry } : {}), name: unit.title, matchType: 'contains', pattern: unit.pattern!, risk: unit.risk, title: unit.title, reason: unit.reason, alternative: unit.alternative, policyRef: unit.policyRef, enabled: unit.enabled, status: 'published', version: unit.version, origin: unit.source === 'doubao' ? 'learned' : 'synced', confidence: unit.confidence, evidenceText: unit.evidenceText, matchedTerms: unit.matchedTerms, ruleKind: unit.kind, createdBy: pkg.createdBy, createdAt: unit.createdAt, updatedAt: unit.updatedAt } as ComplianceRule;
    }).sort((left, right) => layerWeight[this.store.getRulePackage(this.store.getRuleUnit(left.id)!.packageId)!.layer] - layerWeight[this.store.getRulePackage(this.store.getRuleUnit(right.id)!.packageId)!.layer]);
  }
}
