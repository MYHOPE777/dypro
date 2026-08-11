import safeRegex from 'safe-regex2';
import type { ComplianceResult, ComplianceRule, Product, RiskLevel, RiskProfile } from '../shared/types';

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
  pattern: RegExp;
  risk: RiskLevel;
  title: string;
  reason: string;
  alternative: string | ((product?: AnalysisInput['product']) => string);
  policyRef: string;
};

const MEDICAL_CONDITION_CLAIM = /(?:治疗|治愈|治好|根治|医治).{0,12}(?:耳聋|失聪|耳鸣|近视|白内障|糖尿病|高血压|癌症|肿瘤|抑郁症|关节炎)|(?:耳聋|失聪|耳鸣|近视|白内障|糖尿病|高血压|癌症|肿瘤|抑郁症|关节炎).{0,12}(?:治疗|治愈|治好|根治|医治)/iu;

function matchedTerms(transcript: string, pattern: RegExp): string[] {
  const match = transcript.match(pattern);
  return match?.[0] ? [match[0]] : [];
}

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
    pattern: /毛孔.*(?:看不见|消失)|皮肤.*像(?:婴儿|换了一层皮)|(?:显瘦|减肥).{0,8}\d+斤|穿上.*年轻\d+岁/iu,
    risk: 'blocked',
    title: '无依据的外观效果承诺',
    reason: '把商品宣传成可以确定改变外观或体重，属于无法由普通商品保证的效果承诺。',
    alternative: (product) => `可以改为：${product?.name ?? '这款商品'}适合日常使用，具体体验会因人而异，请以商品页面信息为准。`,
    policyRef: '直播电商｜虚假或夸大效果宣传',
  },
  {
    pattern: /适合所有(?:肤质|人群|人)|所有肤质|任何人都适合/iu,
    risk: 'warning',
    title: '不适配所有人群的绝对表述',
    reason: '不同肤质、体质和使用场景存在差异，不能保证商品适合所有人。',
    alternative: '可以改为：适用范围和具体体验会因个人情况而异，请先查看商品详情并按需选择。',
    policyRef: '直播电商｜商品适用范围宣传',
  },
  {
    pattern: /调理(?:血糖|血压)|改善(?:三高|糖尿病)|(?:降糖|降压|减肥).{0,6}(?:效果|作用|立刻)/iu,
    risk: 'blocked',
    title: '医疗或健康功效暗示',
    reason: '将普通商品与疾病、血糖血压或减重效果绑定，容易构成未经证明的健康功效宣传。',
    alternative: (product) => `可以改为：介绍${product?.name ?? '这款商品'}的材质、规格和日常使用场景，健康问题请咨询专业人士。`,
    policyRef: '广告法｜医疗健康功效宣传',
  },
  {
    pattern: /以后就再也没有.*(?:价格|机会)|不买.*(?:后悔|没有了)/iu,
    risk: 'warning',
    title: '无依据的紧迫性诱导',
    reason: '用无法核验的未来价格或机会承诺制造紧迫感，可能诱导消费者冲动购买。',
    alternative: '可以改为：当前活动和到手价以直播间商品页面实时展示为准。',
    policyRef: '直播电商｜价格与促销宣传',
  },
  {
    pattern: MEDICAL_CONDITION_CLAIM,
    risk: 'blocked',
    title: '医疗功效暗示',
    reason: '将疾病或症状与治疗、治愈等医学功效绑定，属于高风险医疗功效宣传。',
    alternative: (product) => `可以改为：介绍${product?.name ?? '这款商品'}的日常使用场景，不对疾病治疗或恢复作承诺。`,
    policyRef: '广告法｜直播电商营销行为规范',
  },
  {
    pattern: /保证|一定|绝对|百分之百|100%|全部消失|永不反弹|根治|立刻见效|三天.*消失/iu,
    risk: 'blocked',
    title: '绝对化功效承诺',
    reason: '使用“保证 / 全部消失”等绝对化表述，暗示所有消费者都能获得确定效果。',
    alternative: (product) => product?.category === '护肤'
      ? '可以改为：坚持使用，肤感和气色会因人而异地逐步改善，属于个体体验，请按个人情况体验。'
      : `可以改为：${product?.name ?? '这款商品'}适合日常使用，具体体验会因人而异，请按个人情况体验。`,
    policyRef: '广告法｜化妆品功效宣称规范',
  },
  {
    pattern: /治疗|治愈|治好|药效|处方|降血糖|降血压|抗癌|消炎|杀菌|医学证明/iu,
    risk: 'blocked',
    title: '医疗功效暗示',
    reason: '把日常消费品与疾病治疗、药效或医学结论绑定，容易构成医疗功效暗示。',
    alternative: (product) => `可以改为：${product?.name ?? '这款商品'}用于日常${product?.category ?? '使用'}场景，具体感受请以个人体验和专业建议为准。`,
    policyRef: '广告法｜直播电商营销行为规范',
  },
  {
    pattern: /全网最低|全网第一|史上最低|唯一|顶级|国家级|最后(一件|一次)|错过.*后悔/iu,
    risk: 'warning',
    title: '极限词或制造紧迫感',
    reason: '“全网最低 / 最后一次”等表述需要可核验依据，且可能造成不必要的购买压力。',
    alternative: '可以改为：今天直播间有专属到手价，库存和活动以商品页面实时信息为准。',
    policyRef: '广告法｜互联网广告管理办法',
  },
  {
    pattern: /不满意.*赔|零风险|稳赚|绝不会|100%.*有效|百分百/iu,
    risk: 'warning',
    title: '结果或售后保证',
    reason: '对效果、收益或售后结果作无条件保证，可能超出平台允许的承诺边界。',
    alternative: '可以改为：售后按平台规则执行，具体权益请以商品详情和订单页面为准。',
    policyRef: '直播电商｜平台交易与售后规则',
  },
];

const makeId = () => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const severity: Record<RiskLevel, number> = { safe: 0, warning: 1, blocked: 2 };

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
    transcript: input.transcript,
    createdAt: Date.now(),
    matchedTerms: customMatchedTerms(input.transcript, rule),
  };
}

export async function analyzeTranscript(input: AnalysisInput): Promise<ComplianceResult> {
  const customResult = evaluateCustomRules(input);
  const rule = RULES.find((candidate) => candidate.pattern.test(input.transcript));
  const now = Date.now();

  if (customResult && (!rule || severity[customResult.risk] > severity[rule.risk])) return customResult;

  if (!rule) {
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
      transcript: input.transcript,
      createdAt: now,
      matchedTerms: [],
    };
  }

  return {
    id: makeId(),
    productId: input.productId,
    risk: rule.risk,
    title: rule.title,
    reason: rule.reason,
    alternative: typeof rule.alternative === 'function' ? rule.alternative(input.product) : rule.alternative,
    policyRef: rule.policyRef,
    confidence: rule.risk === 'blocked' ? 0.96 : 0.88,
    source: 'local-fallback',
    transcript: input.transcript,
    createdAt: now,
    matchedTerms: matchedTerms(input.transcript, rule.pattern),
  };
}

export function createLocalAnalyzer(): ComplianceAnalyzer {
  return { analyze: analyzeTranscript };
}
