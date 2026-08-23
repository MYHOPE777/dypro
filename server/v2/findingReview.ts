import type { ComplianceFinding, ComplianceFindingDisposition, ComplianceRule, Product } from '../../src/shared/types';
import type { LiveSessionSnapshot } from '../../src/shared/v2';
import { RuleModule } from './rules';
import { RulePackageRegistry } from './rulePackages';
import { SqliteFactStore } from './store';

export type FindingResolution = {
  finding: ComplianceFinding;
  rule?: ComplianceRule;
  semanticUnit?: ReturnType<RulePackageRegistry['confirmSemanticFinding']>;
};

export class FindingReviewModule {
  constructor(
    private readonly store: SqliteFactStore,
    private readonly rules: RuleModule,
    private readonly rulePackages: RulePackageRegistry,
    private readonly listProducts: (roomId: string) => Product[],
    private readonly snapshot: (sessionId: string) => LiveSessionSnapshot | null,
    private readonly now: () => number = Date.now,
  ) {}

  list(roomId: string, disposition: ComplianceFindingDisposition | 'all' = 'pending'): ComplianceFinding[] {
    return this.store.listComplianceFindings(roomId, disposition);
  }

  get(sessionId: string, segmentId: string): ComplianceFinding | null {
    return this.store.getComplianceFinding(sessionId, segmentId);
  }

  confirm(sessionId: string, segmentId: string, actorId: string, note?: string): FindingResolution | null {
    const finding = this.get(sessionId, segmentId);
    if (!finding) return null;
    if (finding.disposition === 'confirmed') {
      return { finding, ...(finding.ruleId ? { rule: this.store.getRule(finding.ruleId) ?? undefined } : {}) };
    }
    if (finding.disposition !== 'pending') throw new Error('该风险已完成处置');
    const product = this.resolveProduct(finding);
    if (!product) throw new Error('无法找到风险发生时的商品资料，请先恢复该商品后再确认');
    const resolutionNote = typeof note === 'string' ? note : undefined;
    if (finding.result.ruleKind === 'sentence' || finding.result.ruleKind === 'context') {
      const semanticUnit = this.rulePackages.confirmSemanticFinding(finding.roomId, actorId, finding.result, product);
      const resolved = this.store.resolveComplianceFinding(sessionId, segmentId, 'confirmed', actorId, undefined, resolutionNote, this.now());
      return { finding: resolved, semanticUnit };
    }
    const rule = this.rules.confirmFinding(finding.roomId, actorId, finding.result, product);
    const resolved = this.store.resolveComplianceFinding(sessionId, segmentId, 'confirmed', actorId, rule.id, resolutionNote, this.now());
    return { finding: resolved, rule };
  }

  dismiss(sessionId: string, segmentId: string, actorId: string, note?: string): ComplianceFinding | null {
    const finding = this.get(sessionId, segmentId);
    if (!finding) return null;
    if (finding.disposition === 'dismissed') return finding;
    if (finding.disposition !== 'pending') throw new Error('该风险已完成处置');
    return this.store.resolveComplianceFinding(sessionId, segmentId, 'dismissed', actorId, undefined, typeof note === 'string' ? note : undefined, this.now());
  }

  private resolveProduct(finding: ComplianceFinding): Product | undefined {
    const snapshot = this.snapshot(finding.sessionId);
    return (finding.product?.id === finding.productId ? finding.product : undefined)
      ?? this.listProducts(finding.roomId).find((candidate) => candidate.id === finding.productId)
      ?? snapshot?.lineup.find((candidate) => candidate.id === finding.productId)
      ?? (snapshot?.product.id === finding.productId ? snapshot.product : undefined);
  }
}

