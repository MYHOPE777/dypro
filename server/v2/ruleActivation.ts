import type { AnalysisInput } from '../../src/compliance/engine';
import type { ComplianceRule, Product, RuleLayer, RulePackage, RiskLevel } from '../../src/shared/types';
import { RuleModule } from './rules';
import { RulePackageRegistry } from './rulePackages';

type SemanticInstruction = NonNullable<AnalysisInput['semanticRules']>[number];

export type RuleActivationInput = {
  roomId: string;
  product?: Product;
  platform?: RulePackage['platform'];
  industry?: string;
};

export type ActivatedRuleSnapshot = {
  roomId: string;
  productId?: string;
  platform?: RulePackage['platform'];
  industry?: string;
  version: string;
  rules: ComplianceRule[];
  semanticRules: SemanticInstruction[];
};

const riskWeight: Record<RiskLevel, number> = { safe: 0, warning: 1, blocked: 2 };
const layerWeight: Record<RuleLayer, number> = { legal: 5, platform: 4, industry: 3, room: 2, product: 1 };

function ruleLayer(rule: ComplianceRule): RuleLayer {
  if (rule.layer) return rule.layer;
  if (rule.scope === 'product') return 'product';
  if (rule.scope === 'category') return 'industry';
  return 'room';
}

function compareRules(left: ComplianceRule, right: ComplianceRule): number {
  return riskWeight[right.risk] - riskWeight[left.risk]
    || layerWeight[ruleLayer(right)] - layerWeight[ruleLayer(left)]
    || right.pattern.length - left.pattern.length
    || right.version - left.version
    || left.id.localeCompare(right.id);
}

/**
 * Compiles the legacy local rules and versioned rule packages into one
 * immutable-at-call-time view for a single room/product context. Transport and
 * LiveSession code should consume this result instead of knowing both stores.
 */
export class RuleActivationIndex {
  constructor(private readonly rules: RuleModule, private readonly packages: RulePackageRegistry) {}

  compile(input: RuleActivationInput): ActivatedRuleSnapshot {
    const packageInput = { roomId: input.roomId, product: input.product, platform: input.platform, industry: input.industry };
    const merged = [...this.rules.active(input.roomId, input.product), ...this.packages.asComplianceRules(packageInput)];
    const rules = [...new Map(merged.map((rule) => [rule.id, rule])).values()].sort(compareRules);
    const semanticRules = [...new Map(this.packages.semanticInstructions(packageInput).map((rule) => [this.semanticKey(rule), rule])).values()];
    const version = [
      ...rules.map((rule) => `${rule.id}@${rule.version}:${ruleLayer(rule)}:${rule.enabled ? 1 : 0}`),
      ...semanticRules.map((rule) => `${this.semanticKey(rule)}:${rule.risk}`),
    ].join('|') || 'empty';
    return {
      roomId: input.roomId,
      ...(input.product ? { productId: input.product.id } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.industry ? { industry: input.industry } : {}),
      version,
      rules,
      semanticRules,
    };
  }

  private semanticKey(rule: SemanticInstruction): string {
    return `${rule.title}|${rule.policyRef}|${rule.instruction ?? ''}|${rule.contextWindow ?? ''}`;
  }
}

