import safeRegex from 'safe-regex2';
import type { ComplianceCategory, ComplianceEnforcement, ComplianceResult, ComplianceRule, Product, RiskLevel, RiskProfile } from '../shared/types';

export type AnalysisInput = {
  roomId?: string;
  productId: string;
  transcript: string;
  product?: Pick<Product, 'id' | 'name' | 'category' | 'price' | 'compliantPhrases'>;
  customRules?: ComplianceRule[];
  riskProfile?: RiskProfile;
  context?: { text: string; segmentCount: number; windowStartMs: number; windowEndMs: number };
};

export type ComplianceAnalyzer = {
  analyze(input: AnalysisInput): Promise<ComplianceResult>;
};

type Rule = {
  id: string;
  pattern: RegExp;
  risk: RiskLevel;
  category: ComplianceCategory;
  ruleKind: 'term' | 'sentence' | 'context';
  priority: number;
  title: string;
  reason: string;
  alternative: string | ((product?: AnalysisInput['product']) => string);
  policyRef: string;
};

const MEDICAL_CONDITION_CLAIM = /(?:治疗|治愈|治好|根治|医治).{0,12}(?:耳聋|失聪|耳鸣|近视|白内障|糖尿病|高血压|癌症|肿瘤|抑郁症|关节炎)|(?:耳聋|失聪|耳鸣|近视|白内障|糖尿病|高血压|癌症|肿瘤|抑郁症|关节炎).{0,12}(?:治疗|治愈|治好|根治|医治)/iu;
const SENSITIVE_CLAIM_NEGATION = /(?:不能|不可|不得|禁止|不要|不建议|不可以|没有|并非|不是|不具备|无法|别说|严禁|切勿|避免).{0,18}$/iu;
const SENSITIVE_CLAIM_REFERENCE = /(?:例如|比如|所谓|有人说|常见说法|错误说法|不要说|不应说|不能说|平台不允许|科普|引用|广告中).{0,18}$/iu;
const ABSOLUTE_EFFECT_CLAIM = /(?:保证|一定|绝对|百分之百|100%|完全|全部|永远|永久|立刻|马上).{0,14}(?:有效|见效|改善|消失|恢复|年轻|减肥|减重|降下来|提升|解决|没有噪音|不反弹|不复发)|(?:有效|见效|改善|消失|恢复|年轻|减肥|减重|降下来|提升|解决|没有噪音|不反弹|不复发).{0,14}(?:保证|一定|绝对|百分之百|100%|完全|全部|永远|永久)/iu;
const MEDICAL_ACTION_CLAIM = /(?:治疗|治愈|治好|根治|医治|药效|处方|降血糖|降血压|抗癌|消炎|杀菌|医学证明)/iu;

const NEGATED_CLAIM_RULE: Rule = {
  id: 'sensitive-claim-reference',
  pattern: /[\s\S]+/u,
  risk: 'warning',
  category: 'context',
  ruleKind: 'sentence',
  priority: 110,
  title: '敏感词语境提醒',
  reason: '当前表达是在否定、引用或科普敏感功效，但仍重复了平台容易误判的词语。',
  alternative: '可以改为：只介绍商品材质、规格和使用场景，不复述敏感功效词。',
  policyRef: '直播间敏感词控制',
};

function customMatchedTerms(transcript: string, rule: ComplianceRule): string[] {
  if (rule.matchType === 'contains') {
    const index = transcript.toLocaleLowerCase().indexOf(rule.pattern.toLocaleLowerCase());
    return index < 0 ? [] : [transcript.slice(index, index + rule.pattern.length)];
  }
  try {
    const match = safeRegex(rule.pattern) ? transcript.match(new RegExp(rule.pattern, 'iu')) : null;
    return match?.[0] ? [match[0]] : [];
  } catch {
    return [];
  }
}

const RULES: Rule[] = [
  {
    id: 'appearance-effect',
    pattern: /毛孔.*(?:看不见|消失)|皮肤.*像(?:婴儿|换了一层皮)|(?:显瘦|减肥).{0,8}\d+斤|穿上.*年轻\d+岁/iu,
    risk: 'blocked',
    category: 'appearance',
    ruleKind: 'sentence',
    priority: 90,
    title: '无依据的外观效果承诺',
    reason: '把商品宣传成可以确定改变外观或体重，属于无法由普通商品保证的效果承诺。',
    alternative: (product) => `可以改为：${product?.name ?? '这款商品'}适合日常使用，具体体验会因人而异，请以商品页面信息为准。`,
    policyRef: '直播电商｜虚假或夸大效果宣传',
  },
  {
    id: 'universal-suitability',
    pattern: /适合所有(?:肤质|人群|人)|所有肤质|任何人都适合/iu,
    risk: 'warning',
    category: 'suitability',
    ruleKind: 'sentence',
    priority: 40,
    title: '不适配所有人群的绝对表述',
    reason: '不同肤质、体质和使用场景存在差异，不能保证商品适合所有人。',
    alternative: '可以改为：适用范围和具体体验会因个人情况而异，请先查看商品详情并按需选择。',
    policyRef: '直播电商｜商品适用范围宣传',
  },
  {
    id: 'health-efficacy',
    pattern: /调理(?:血糖|血压)|改善(?:三高|糖尿病)|(?:降糖|降压|减肥).{0,6}(?:效果|作用|立刻)/iu,
    risk: 'blocked',
    category: 'health',
    ruleKind: 'sentence',
    priority: 95,
    title: '医疗或健康功效暗示',
    reason: '将普通商品与疾病、血糖血压或减重效果绑定，容易构成未经证明的健康功效宣传。',
    alternative: (product) => `可以改为：介绍${product?.name ?? '这款商品'}的材质、规格和日常使用场景，健康问题请咨询专业人士。`,
    policyRef: '广告法｜医疗健康功效宣传',
  },
  {
    id: 'false-urgency',
    pattern: /以后就再也没有.*(?:价格|机会)|不买.*(?:后悔|没有了)/iu,
    risk: 'warning',
    category: 'urgency',
    ruleKind: 'sentence',
    priority: 35,
    title: '无依据的紧迫性诱导',
    reason: '用无法核验的未来价格或机会承诺制造紧迫感，可能诱导消费者冲动购买。',
    alternative: '可以改为：当前活动和到手价以直播间商品页面实时展示为准。',
    policyRef: '直播电商｜价格与促销宣传',
  },
  {
    id: 'medical-condition-efficacy',
    pattern: MEDICAL_CONDITION_CLAIM,
    risk: 'blocked',
    category: 'medical',
    ruleKind: 'sentence',
    priority: 120,
    title: '医疗功效暗示',
    reason: '将疾病或症状与治疗、治愈等医学功效绑定，属于高风险医疗功效宣传。',
    alternative: (product) => `可以改为：介绍${product?.name ?? '这款商品'}的日常使用场景，不对疾病治疗或恢复作承诺。`,
    policyRef: '广告法｜直播电商营销行为规范',
  },
  {
    id: 'absolute-efficacy',
    pattern: ABSOLUTE_EFFECT_CLAIM,
    risk: 'blocked',
    category: 'guarantee',
    ruleKind: 'sentence',
    priority: 100,
    title: '绝对化功效承诺',
    reason: '使用“保证 / 全部消失”等绝对化表述，暗示所有消费者都能获得确定效果。',
    alternative: (product) => product?.category === '护肤'
      ? '可以改为：坚持使用，肤感和气色会因人而异地逐步改善，属于个体体验，请按个人情况体验。'
      : `可以改为：${product?.name ?? '这款商品'}适合日常使用，具体体验会因人而异，请按个人情况体验。`,
    policyRef: '广告法｜化妆品功效宣称规范',
  },
  {
    id: 'medical-action',
    pattern: MEDICAL_ACTION_CLAIM,
    risk: 'blocked',
    category: 'medical',
    ruleKind: 'term',
    priority: 80,
    title: '医疗功效暗示',
    reason: '把日常消费品与疾病治疗、药效或医学结论绑定，容易构成医疗功效暗示。',
    alternative: (product) => `可以改为：${product?.name ?? '这款商品'}用于日常${product?.category ?? '使用'}场景，具体感受请以个人体验和专业建议为准。`,
    policyRef: '广告法｜直播电商营销行为规范',
  },
  {
    id: 'extreme-claim',
    pattern: /全网最低|全网第一|史上最低|唯一|顶级|国家级|最后(一件|一次)|错过.*后悔/iu,
    risk: 'warning',
    category: 'extreme',
    ruleKind: 'term',
    priority: 30,
    title: '极限词或制造紧迫感',
    reason: '“全网最低 / 最后一次”等表述需要可核验依据，且可能造成不必要的购买压力。',
    alternative: '可以改为：今天直播间有专属到手价，库存和活动以商品页面实时信息为准。',
    policyRef: '广告法｜互联网广告管理办法',
  },
  {
    id: 'unconditional-guarantee',
    pattern: /不满意.*(?:赔|退款)|零风险|稳赚|绝不会(?:反弹|过敏|出问题|失效|亏损)|(?:100%|百分百).{0,8}(?:有效|满意|成功|赚钱)/iu,
    risk: 'warning',
    category: 'guarantee',
    ruleKind: 'sentence',
    priority: 45,
    title: '结果或售后保证',
    reason: '对效果、收益或售后结果作无条件保证，可能超出平台允许的承诺边界。',
    alternative: '可以改为：售后按平台规则执行，具体权益请以商品详情和订单页面为准。',
    policyRef: '直播电商｜平台交易与售后规则',
  },
];

const makeId = () => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const severity: Record<RiskLevel, number> = { safe: 0, warning: 1, blocked: 2 };

function enforcementFor(risk: RiskLevel): ComplianceEnforcement {
  return risk === 'blocked' ? 'block_phrase' : risk === 'warning' ? 'warn' : 'allow';
}

type LocalRuleMatch = { rule: Rule; terms: string[]; matchIndex: number };

function ruleMatch(transcript: string, rule: Rule): LocalRuleMatch | null {
  const match = transcript.match(rule.pattern);
  if (!match?.[0]) return null;
  return { rule, terms: [match[0]], matchIndex: match.index ?? 0 };
}

function isNegatedOrReferenced(transcript: string, match: LocalRuleMatch): boolean {
  if (match.rule.risk !== 'blocked') return false;
  const prefix = transcript.slice(Math.max(0, match.matchIndex - 24), match.matchIndex);
  return SENSITIVE_CLAIM_NEGATION.test(prefix) || SENSITIVE_CLAIM_REFERENCE.test(prefix);
}

function resolveBuiltInRule(transcript: string): LocalRuleMatch | null {
  const matches = RULES.map((rule) => ruleMatch(transcript, rule))
    .filter((match): match is LocalRuleMatch => Boolean(match))
    .map((match) => isNegatedOrReferenced(transcript, match) ? { ...match, rule: NEGATED_CLAIM_RULE } : match);
  if (!matches.length) return null;
  matches.sort((first, second) => severity[second.rule.risk] - severity[first.rule.risk] || second.rule.priority - first.rule.priority);
  return matches[0];
}

function resultFromRule(input: AnalysisInput, rule: Rule, terms: string[], now: number, source: ComplianceResult['source'], id = makeId()): ComplianceResult {
  return {
    id,
    productId: input.productId,
    risk: rule.risk,
    title: rule.title,
    reason: rule.reason,
    alternative: typeof rule.alternative === 'function' ? rule.alternative(input.product) : rule.alternative,
    policyRef: rule.policyRef,
    confidence: rule.risk === 'blocked' ? 0.96 : 0.88,
    source,
    enforcement: enforcementFor(rule.risk),
    category: rule.category,
    ruleId: rule.id,
    transcript: input.transcript,
    createdAt: now,
    matchedTerms: terms,
    ruleKind: rule.ruleKind,
  };
}

export function evaluateCustomRules(input: AnalysisInput): ComplianceResult | null {
  const rule = input.customRules?.filter((candidate) => {
    if (!candidate.enabled || candidate.status !== 'published') return false;
    try {
      return candidate.matchType === 'contains'
        ? input.transcript.toLocaleLowerCase().includes(candidate.pattern.toLocaleLowerCase())
        : safeRegex(candidate.pattern) && new RegExp(candidate.pattern, 'iu').test(input.transcript);
    } catch {
      return false;
    }
  }).sort((first, second) => severity[second.risk] - severity[first.risk])[0];
  if (!rule) return null;
  return {
    id: `rule-${rule.id}-${Date.now()}`,
    productId: input.productId,
    risk: rule.risk,
    title: rule.title,
    reason: rule.reason,
    alternative: rule.alternative,
    policyRef: rule.policyRef,
    confidence: 0.99,
    source: 'custom-rule',
    enforcement: enforcementFor(rule.risk),
    category: 'context',
    ruleId: rule.id,
    transcript: input.transcript,
    createdAt: Date.now(),
    matchedTerms: customMatchedTerms(input.transcript, rule),
    ruleKind: rule.matchType === 'contains' ? 'term' : 'sentence',
  };
}

export async function analyzeTranscript(input: AnalysisInput): Promise<ComplianceResult> {
  const customResult = evaluateCustomRules(input);
  const builtIn = resolveBuiltInRule(input.transcript);
  const localResult = builtIn ? resultFromRule(input, builtIn.rule, builtIn.terms, Date.now(), 'local-fallback') : null;
  const now = Date.now();

  if (customResult && (!localResult || severity[customResult.risk] > severity[localResult.risk])) return customResult;

  if (!localResult) {
    if (customResult) return customResult;
    return {
      id: makeId(),
      productId: input.productId,
      risk: 'safe',
      title: '当前表达可继续',
      reason: '未发现需要即时拦截的高风险表述。',
      alternative: '可继续介绍产品材质、使用场景、活动和页面展示的真实信息。',
      policyRef: '直播合规基础检查',
      confidence: 0.78,
      source: 'local-fallback',
      enforcement: 'allow',
      transcript: input.transcript,
      createdAt: now,
      matchedTerms: [],
    };
  }
  return localResult;
}

export function createLocalAnalyzer(): ComplianceAnalyzer {
  return { analyze: analyzeTranscript };
}
