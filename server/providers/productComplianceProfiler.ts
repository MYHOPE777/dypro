import type { Product, ProductComplianceProfile } from '../../src/shared/types';
import { getArkConfig, requestArk, type ArkConfig } from './ark';
import { parseArkJson } from './doubao';

export type ProductComplianceProfiler = { profile(product: Product): Promise<ProductComplianceProfile> };

const SYSTEM_PROMPT = `你是抖音电商带货直播商品合规资料专员。根据商品名称、已有分类、描述和卖点，识别所属行业和标准商品类目，并生成直播前置合规画像。
只输出 JSON，不要 Markdown：{"industry":"行业","category":"标准类目","complianceSummary":"不超过120字的合规资料描述","riskKeywords":["可直接词审的高风险词或短语"],"riskBoundaries":["需要结合语义审核的宣传边界"],"requiredDisclosures":["需要资质、证据或页面披露的事项"],"safeSellingPoints":["可安全介绍且仍需真实可核验的方向"],"confidence":0到1}。
riskKeywords 只放稳定、明确、可直接匹配的高风险宣传短语，不要放宽泛单字；riskBoundaries 描述行业和类目特有的语义风险。
默认规则环境是抖音带货直播间，同时遵守广告法、平台营销宣传、价格促销、资质和商品信息真实性要求。不要编造商品功效、资质、成分或检测数据。`;

type ProfileSeed = Omit<ProductComplianceProfile, 'platformRuleset' | 'confidence' | 'source' | 'status' | 'updatedAt'>;

const GENERIC: ProfileSeed = {
  industry: '综合零售', category: '其他商品',
  complianceSummary: '按照抖音带货直播通用规则介绍真实、可核验的商品信息，不作医疗、绝对效果、虚假价格或无依据权威背书。',
  riskKeywords: ['全网第一', '百分百有效', '治疗疾病', '假一赔万'],
  riskBoundaries: ['商品效果、适用性和耐用性不得作绝对保证', '价格、销量、排名和资质必须真实可核验'],
  requiredDisclosures: ['商品规格、资质、价格、库存和售后以页面实时信息为准'],
  safeSellingPoints: ['介绍商品页面可核验的材质、规格、功能和使用场景'],
};

const PROFILES: Array<{ pattern: RegExp; value: ProfileSeed }> = [
  { pattern: /精华|面霜|乳液|面膜|护肤|化妆品|口红|粉底|防晒/u, value: { industry: '美妆个护', category: '护肤品/化妆品', complianceSummary: '围绕成分、质地、使用方法和可核验功效介绍，不宣称医疗作用，不作绝对效果或全人群适用保证。', riskKeywords: ['治疗皮肤病', '医学治愈', '永久祛斑', '百分百不过敏'], riskBoundaries: ['功效宣称需与备案或商品页面一致', '不得将化妆品宣传为医疗或疾病治疗手段', '肤质适用性和效果不得绝对化'], requiredDisclosures: ['特殊化妆品功效及备案信息需可核验', '成分、适用人群和使用方法以商品页面为准'], safeSellingPoints: ['介绍真实成分、质地和使用步骤', '描述个人肤感时明确体验因人而异'] } },
  { pattern: /保健|营养|维生素|益生菌|膳食|食品|茶|饮料|零食/u, value: { industry: '食品饮料', category: '食品/营养补充类', complianceSummary: '只介绍配料、口味、规格和食用场景；普通食品不得宣称保健、疾病治疗或替代药物。', riskKeywords: ['治疗疾病', '替代药物', '降血糖', '降血压', '抗癌'], riskBoundaries: ['普通食品不得宣传保健或医疗功效', '营养与成分数据必须有标签或检测依据', '不得对减重、体质改善作结果保证'], requiredDisclosures: ['配料表、过敏原、保质期和食用方式以页面为准', '特殊膳食或保健食品资质需可核验'], safeSellingPoints: ['介绍口味、配料、规格和真实食用场景', '营养信息引用商品标签或页面数据'] } },
  { pattern: /耳机|手机|电脑|平板|相机|数码|充电|电器|家电/u, value: { industry: '数码家电', category: '数码电子/家用电器', complianceSummary: '以实测参数、功能、兼容性和使用条件为准，不夸大性能，不虚构权威排名或无条件效果。', riskKeywords: ['全网第一', '永久不卡', '绝对无噪音', '百分百兼容'], riskBoundaries: ['性能、续航和降噪受环境及使用方式影响', '对比、排名和认证必须有可核验证据', '兼容性与售后承诺不得超出页面规则'], requiredDisclosures: ['关键参数、适配型号和质保范围以页面为准'], safeSellingPoints: ['介绍可核验参数、操作体验和适用场景', '说明性能会受环境和使用方式影响'] } },
  { pattern: /服装|女装|男装|鞋|包|面料|穿搭|饰品|珠宝/u, value: { industry: '服饰鞋包', category: '服饰鞋包/珠宝饰品', complianceSummary: '围绕材质、版型、尺寸和搭配场景介绍，不保证显瘦、减龄等确定效果，不虚构材质和鉴定结论。', riskKeywords: ['保证显瘦', '年轻十岁', '假一赔万'], riskBoundaries: ['外观和穿着效果存在个体差异', '材质、贵金属和珠宝鉴定结论需可核验', '价格对比和稀缺性表述需有依据'], requiredDisclosures: ['材质、尺寸、鉴定证书和售后规则以页面为准'], safeSellingPoints: ['介绍面料、版型、尺寸和搭配建议', '说明上身效果因体型和搭配而异'] } },
  { pattern: /母婴|婴儿|儿童|奶粉|纸尿裤|玩具/u, value: { industry: '母婴用品', category: '母婴/儿童用品', complianceSummary: '优先核验适用年龄、材质和安全标准，不宣传治疗、发育提升或绝对安全，不替代专业育儿建议。', riskKeywords: ['促进智力发育', '治疗湿疹', '绝对安全', '零过敏'], riskBoundaries: ['适用年龄和使用条件必须准确', '不得承诺疾病治疗或确定的发育效果', '安全性不得作无条件保证'], requiredDisclosures: ['适用年龄、执行标准、警示信息和使用方式以页面为准'], safeSellingPoints: ['介绍材质、规格、适龄范围和使用方法', '提醒按商品说明和监护要求使用'] } },
  { pattern: /杯|锅|收纳|家居|床品|清洁|日用/u, value: { industry: '家居日用', category: '家居日用', complianceSummary: '围绕材质、规格、使用方法和适用场景介绍；效果、耐用性及保温等参数需说明测试条件。', riskKeywords: ['永久保温', '绝对不漏', '终身不坏'], riskBoundaries: ['性能数据受环境和使用条件影响', '材质与食品接触安全声明需有依据', '不得作无条件耐用或售后承诺'], requiredDisclosures: ['材质、尺寸、执行标准和使用限制以页面为准'], safeSellingPoints: ['介绍材质、规格、操作方式和日常场景', '参数说明同时交代测试或使用条件'] } },
];

function normalizeList(value: unknown, limit: number, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const result = value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim().slice(0, 120)).slice(0, limit);
  return result.length ? result : fallback;
}

export function localProductComplianceProfile(product: Product, now = Date.now()): ProductComplianceProfile {
  const source = [product.name, product.category, product.description, ...product.sellingPoints].join(' ');
  const seed = PROFILES.find((candidate) => candidate.pattern.test(source))?.value ?? { ...GENERIC, category: product.category && product.category !== '其他' ? product.category : GENERIC.category };
  return { ...seed, platformRuleset: 'douyin-ecommerce-live', confidence: 0.68, source: 'local-fallback', status: 'needs_review', updatedAt: now };
}

function profileFromPayload(payload: Record<string, unknown>, fallback: ProductComplianceProfile): ProductComplianceProfile {
  const text = (value: unknown, backup: string, maximum: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : backup;
  const confidence = typeof payload.confidence === 'number' ? Math.max(0, Math.min(1, payload.confidence)) : 0.85;
  return {
    industry: text(payload.industry, fallback.industry, 80), category: text(payload.category, fallback.category, 80), platformRuleset: 'douyin-ecommerce-live',
    complianceSummary: text(payload.complianceSummary, fallback.complianceSummary, 500),
    riskKeywords: normalizeList(payload.riskKeywords, 20, fallback.riskKeywords), riskBoundaries: normalizeList(payload.riskBoundaries, 20, fallback.riskBoundaries),
    requiredDisclosures: normalizeList(payload.requiredDisclosures, 20, fallback.requiredDisclosures), safeSellingPoints: normalizeList(payload.safeSellingPoints, 20, fallback.safeSellingPoints),
    confidence, source: 'doubao', status: 'generated', updatedAt: Date.now(),
  };
}

export class DoubaoProductComplianceProfiler implements ProductComplianceProfiler {
  private readonly config: ArkConfig | null;
  constructor(env: NodeJS.ProcessEnv = process.env) { this.config = getArkConfig(env, 'ARK_PRODUCT_PROFILE_TIMEOUT_MS', 5_000); }
  async profile(product: Product): Promise<ProductComplianceProfile> {
    const fallback = localProductComplianceProfile(product);
    if (!this.config) return fallback;
    try {
      const source = { name: product.name, currentCategory: product.category, description: product.description, sellingPoints: product.sellingPoints, sourceText: product.sourceText?.slice(0, 2_000) };
      const content = await requestArk(this.config, SYSTEM_PROMPT, `默认平台规则：抖音带货直播间\n商品资料：${JSON.stringify(source)}`, 700);
      return profileFromPayload(parseArkJson(content), fallback);
    } catch { return fallback; }
  }
}
