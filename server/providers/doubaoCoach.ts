import { analyzeTranscript } from '../../src/compliance/engine';
import type { CoachPurpose, CoachSuggestion, ComplianceResult, ComplianceRule, Product, SessionStats } from '../../src/shared/types';
import { getArkConfig, requestArk } from './ark';
import { parseArkJson } from './doubao';

export type CoachInput = {
  product: Product;
  transcript: string;
  compliance: ComplianceResult | null;
  stats: SessionStats;
  referencePhrases?: Array<{ text: string; purpose?: CoachPurpose }>;
  templateMode?: 'reference' | 'generate';
  customRules?: ComplianceRule[];
};

export type CoachProvider = {
  suggest(input: CoachInput): Promise<CoachSuggestion>;
  suggestMany?(input: CoachInput): Promise<CoachSuggestion[]>;
};

const PURPOSES: CoachPurpose[] = ['塑品', '憋单', '逼单', '转化', '互动', '留人', '答疑'];

const SYSTEM_PROMPT = `你是资深直播间运营教练，擅长把商品卖点、用户互动和合规表达组织成主播下一句可直接说的话。
根据当前商品、主播刚说的话、合规风险和直播进程，给出三段角度不同、自然、具体、短促的备选话术。若没有可复用的主播模板，必须基于商品事实独立生成，不要声称存在历史模板。
只输出 JSON：{"suggestions":[{"purpose":"塑品|憋单|逼单|转化|互动|留人|答疑","text":"主播下一句直接照读的话","reason":"这句建议的作用，不超过20字"}]}。
suggestions 必须正好三项，每段控制在 60 个汉字以内，不能编造价格、库存、功效或赠品；有合规风险时第一段必须先给安全替代表达，三段不得只是同义改写。
purpose 含义：塑品=建立商品价值，憋单=保留购买悬念，逼单=推动当下决策，转化=明确下单动作，互动=引导评论或回答观众，留人=留住观看，答疑=回应疑问。`;

function localSuggestion(input: CoachInput, createdAt = Date.now()): CoachSuggestion {
  const risk = input.compliance?.risk;
  const product = input.product;
  if (risk === 'blocked' || risk === 'warning') {
    return {
      id: `coach-local-${createdAt}`,
      purpose: '转化',
      text: product.compliantPhrases[0] || `可以先了解${product.name}的材质、规格和日常使用场景，具体体验因人而异。`,
      reason: '替换风险表达，继续承接转化',
      source: 'local-fallback',
      createdAt,
    };
  }
  if (/吗|什么|怎么|为什么|能不能|可以不可以|有没/u.test(input.transcript)) {
    return {
      id: `coach-local-${createdAt}`,
      purpose: '互动',
      text: `大家最关心${product.name}哪一点？把问题打在评论区，我按页面信息给大家说明。`,
      reason: '回应问题并引导评论',
      source: 'local-fallback',
      createdAt,
    };
  }
  if (/价格|到手|下单|拍下|优惠|活动|库存/u.test(input.transcript)) {
    return {
      id: `coach-local-${createdAt}`,
      purpose: '转化',
      text: `需要的朋友可以点击下方商品卡，价格和活动以页面实时展示为准。`,
      reason: '承接购买动作，避免绝对化承诺',
      source: 'local-fallback',
      createdAt,
    };
  }
  const sellingPoint = product.sellingPoints[0] || product.description || '适合日常使用';
  return {
    id: `coach-local-${createdAt}`,
    purpose: input.stats.words < 80 ? '留人' : '塑品',
    text: `${product.name}的核心特点是${sellingPoint}，大家可以结合自己的使用场景来选择。`,
    reason: '清晰讲商品价值，保持直播节奏',
    source: 'local-fallback',
    createdAt,
  };
}

export function localSuggestions(input: CoachInput, createdAt = Date.now()): CoachSuggestion[] {
  const primary = localSuggestion(input, createdAt);
  const product = input.product;
  const referenceCandidates: CoachSuggestion[] = (input.compliance?.risk === 'safe' ? input.referencePhrases ?? [] : [])
    .filter((phrase) => phrase.text.trim())
    .slice(0, 3)
    .map((phrase, index) => ({
      id: `coach-reference-${createdAt}-${index}`,
      purpose: phrase.purpose ?? '塑品',
      text: phrase.text.trim(),
      reason: '主播专属参考话术',
      source: 'local-fallback' as const,
      createdAt,
    }));
  const sellingPoint = product.sellingPoints[1] || product.sellingPoints[0] || product.description || '日常使用场景';
  const candidates: CoachSuggestion[] = [
    ...referenceCandidates,
    primary,
    {
      id: `coach-local-${createdAt}-2`,
      purpose: '塑品',
      text: `${product.name}还可以重点看看${sellingPoint}，大家按自己的实际需要来选择。`,
      reason: '补充卖点，建立商品价值',
      source: 'local-fallback',
      createdAt,
    },
    {
      id: `coach-local-${createdAt}-3`,
      purpose: input.stats.words < 120 ? '互动' : '转化',
      text: input.stats.words < 120
        ? `想了解${product.name}哪个细节？评论区告诉我，我按商品页面逐项说明。`
        : '需要的朋友可以打开商品卡查看规格与实时价格，确认适合自己后再下单。',
      reason: input.stats.words < 120 ? '引导评论，收集观众关注点' : '承接下单动作，保持合规表达',
      source: 'local-fallback',
      createdAt,
    },
  ];
  const unique = candidates.filter((candidate, index, all) => all.findIndex((item) => item.text === candidate.text) === index);
  while (unique.length < 3) unique.push({ ...primary, id: `${primary.id}-${unique.length + 1}`, text: `${primary.text.replace(/[。！]$/u, '')}，具体以商品页面为准。` });
  return unique.slice(0, 3);
}

function outputPurpose(value: unknown): CoachPurpose {
  return typeof value === 'string' && PURPOSES.includes(value as CoachPurpose) ? value as CoachPurpose : '塑品';
}

export class DoubaoCoach implements CoachProvider {
  private readonly config;
  private readonly maxOutputTokens: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.config = getArkConfig(env, 'ARK_COACH_TIMEOUT_MS', 3_500);
    const configured = Number(env.ARK_COACH_MAX_OUTPUT_TOKENS);
    this.maxOutputTokens = Number.isInteger(configured) && configured >= 320 && configured <= 900 ? configured : 520;
  }

  async suggest(input: CoachInput): Promise<CoachSuggestion> {
    return (await this.suggestMany(input))[0];
  }

  async suggestMany(input: CoachInput): Promise<CoachSuggestion[]> {
    const startedAt = performance.now();
    const fallback = localSuggestions(input);
    if (!this.config) return fallback;
    const references = (input.referencePhrases ?? []).filter((phrase) => phrase.text.trim()).slice(0, 10);
    const templateMode = references.length > 0 ? 'reference' : 'generate';
    try {
      const content = await requestArk(
        this.config,
        SYSTEM_PROMPT,
        JSON.stringify({
          product: {
            name: input.product.name,
            category: input.product.category,
            description: input.product.description,
            sellingPoints: input.product.sellingPoints.slice(0, 5),
            compliantPhrases: input.product.compliantPhrases.slice(0, 3),
          },
          transcript: input.transcript,
          compliance: input.compliance ? {
            risk: input.compliance.risk,
            reason: input.compliance.reason,
            alternative: input.compliance.alternative,
          } : { risk: 'safe' },
          progress: input.stats,
          templateMode,
          templateInstruction: templateMode === 'generate'
            ? '当前没有主播模板话术，请根据商品事实、主播原话和合规结果独立预测下一句，生成三段可直接照读的话术。'
            : '当前有主播模板话术，可以参考其风格，但必须结合当前商品和合规结果重新组织。',
          referencePhrases: references,
        }),
        this.maxOutputTokens,
        Boolean(this.config.knowledgeResourceId),
      );
      const payload = parseArkJson(content);
      const createdAt = Date.now();
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      const entries = Array.isArray(payload.suggestions) ? payload.suggestions as Array<Record<string, unknown>> : [];
      const suggestions = entries.flatMap((entry, index) => {
        const text = typeof entry.text === 'string' ? entry.text.trim() : '';
        if (!text || text.length > 120) return [];
        return [{
          id: `coach-doubao-${createdAt}-${index}-${Math.random().toString(36).slice(2, 8)}`,
          purpose: outputPurpose(entry.purpose),
          text,
          reason: typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason.trim().slice(0, 40) : '结合当前直播状态给出下一句建议',
          source: 'doubao' as const,
          createdAt,
          latencyMs,
        }];
      });
      const guardedSuggestions = (await Promise.all(suggestions.map(async (suggestion) => ({
        suggestion,
        result: await analyzeTranscript({
          productId: input.product.id,
          product: input.product,
          transcript: suggestion.text,
          customRules: input.customRules,
        }),
      })))).filter(({ result }) => result.risk === 'safe').map(({ suggestion }) => suggestion);
      const merged = [...guardedSuggestions, ...fallback.map((suggestion) => ({ ...suggestion, latencyMs }))]
        .filter((suggestion, index, all) => all.findIndex((item) => item.text === suggestion.text) === index)
        .slice(0, 3);
      return merged.length === 3 ? merged : fallback.map((suggestion) => ({ ...suggestion, latencyMs }));
    } catch {
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      return fallback.map((suggestion) => ({ ...suggestion, latencyMs }));
    }
  }
}

export function createDoubaoCoach(env: NodeJS.ProcessEnv = process.env): DoubaoCoach {
  return new DoubaoCoach(env);
}

export { localSuggestion };
