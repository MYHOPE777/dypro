import { createHash } from 'node:crypto';
import type { Product, ProductImportResponse } from '../src/shared/types';

type ProductFields = {
  name?: unknown;
  category?: unknown;
  price?: unknown;
  stock?: unknown;
  sku?: unknown;
  description?: unknown;
  sellingPoints?: unknown;
  compliantPhrases?: unknown;
  image?: unknown;
  accent?: unknown;
};

const DEFAULT_IMAGE = '/products/mug.svg';
const DEFAULT_ACCENT = '#9fb6d8';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[、,，;；|\n]/u).map((item) => item.trim()).filter(Boolean);
  return [];
}

function makeId(name: string, sku = ''): string {
  const digest = createHash('sha1').update(`${name}\0${sku.trim() || 'no-sku'}`).digest('hex').slice(0, 12);
  return `product-${digest}`;
}

function extractLabel(input: string, labels: string[]): string {
  const pattern = new RegExp(`(?:${labels.join('|')})\\s*[:：]\\s*([^\\n]+)`, 'iu');
  return pattern.exec(input)?.[1]?.trim() ?? '';
}

function extractPrice(input: string): string {
  const value = /(?:直播价|活动价|价格|售价|到手价|券后价|零售价|单价)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/iu.exec(input)?.[1];
  return value ? `¥${value}` : '';
}

function extractStock(input: string): number | null {
  const value = /(?:库存|现货|数量)\s*[:：]?\s*([\d,，]+)/iu.exec(input)?.[1]?.replace(/[,，]/gu, '');
  if (!value) return null;
  const stock = Number(value);
  return Number.isSafeInteger(stock) ? stock : null;
}

function localParse(sourceText: string, extraWarning = ''): ProductImportResponse {
  const lines = sourceText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const name = extractLabel(sourceText, ['商品名称', '商品标题', '商品名', '品名', '商品', '名称']) || lines.find((line) => !/[：:]/u.test(line) && !/^https?:\/\//iu.test(line))?.replace(/^[•·*-]\s*/u, '') || '待命名商品';
  const category = extractLabel(sourceText, ['商品分类', '分类', '类目']) || '其他';
  const price = extractPrice(sourceText) || extractLabel(sourceText, ['直播价', '活动价', '价格', '售价', '到手价', '券后价', '零售价', '单价']) || '价格待确认';
  const stock = extractStock(sourceText);
  const sku = extractLabel(sourceText, ['SKU', '货号', '商品编码']);
  const description = extractLabel(sourceText, ['商品描述', '描述', '简介']);
  const sellingPoints = list(extractLabel(sourceText, ['卖点', '核心卖点', '商品特点', '特点', '优势']));
  const fallbackPoints = lines.filter((line) => /^(?:卖点|特点|优势)\s*[:：]/u.test(line)).flatMap((line) => list(line.replace(/^[^:：]+[:：]/u, '')));
  const normalizedSellingPoints = [...new Set([...sellingPoints, ...fallbackPoints])].slice(0, 8);
  const compliantPhrases = category.includes('护肤')
    ? ['根据页面信息介绍成分、质地和使用场景，具体感受因人而异。', '价格和库存以商品页面实时信息为准。']
    : ['根据页面信息介绍材质、规格和使用场景，具体体验因人而异。', '价格和库存以商品页面实时信息为准。'];
  const warnings = [extraWarning].filter(Boolean);
  if (name === '待命名商品') warnings.push('未识别到明确商品名称，请保存前确认。');
  if (price === '价格待确认') warnings.push('未识别到价格，请保存前补充。');
  if (stock === null) warnings.push('未识别到库存，库存暂按待确认处理。');
  return {
    product: {
      id: makeId(name, sku),
      name,
      category,
      price,
      stock,
      sku,
      description,
      sellingPoints: normalizedSellingPoints,
      image: DEFAULT_IMAGE,
      accent: DEFAULT_ACCENT,
      compliantPhrases,
      source: 'local-fallback',
      sourceText: sourceText.slice(0, 20_000),
      updatedAt: Date.now(),
    },
    source: 'local-fallback',
    confidence: warnings.length > 1 ? 0.45 : 0.62,
    warnings,
  };
}

function getDoubaoConfig(): { apiKey: string; endpointId: string; baseUrl: string } | null {
  if (!process.env.DOUBAO_API_KEY || !process.env.DOUBAO_ENDPOINT_ID) return null;
  return {
    apiKey: process.env.DOUBAO_API_KEY,
    endpointId: process.env.DOUBAO_ENDPOINT_ID,
    baseUrl: process.env.DOUBAO_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  };
}

function parseJsonObject(content: string): ProductFields {
  const normalized = content.replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim();
  const start = normalized.indexOf('{');
  const end = normalized.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('豆包返回内容不是 JSON');
  return JSON.parse(normalized.slice(start, end + 1)) as ProductFields;
}

function normalizeDoubao(fields: ProductFields, sourceText: string): ProductImportResponse {
  const name = text(fields.name) || '待命名商品';
  const rawPrice = fields.price;
  const price = typeof rawPrice === 'number' ? `¥${rawPrice}` : text(rawPrice) || '价格待确认';
  const stockText = text(fields.stock).replace(/[,，]/gu, '');
  const rawStock = typeof fields.stock === 'number' ? fields.stock : stockText ? Number(stockText) : Number.NaN;
  const stock = Number.isSafeInteger(rawStock) && rawStock >= 0 ? rawStock : null;
  const warnings: string[] = [];
  if (name === '待命名商品') warnings.push('豆包未识别到明确商品名称，请保存前确认。');
  if (price === '价格待确认') warnings.push('豆包未识别到价格，请保存前补充。');
  if (stock === null) warnings.push('豆包未识别到库存，库存暂按待确认处理。');
  return {
    product: {
      id: makeId(name, text(fields.sku)),
      name,
      category: text(fields.category) || '其他',
      price,
      stock,
      sku: text(fields.sku),
      description: text(fields.description),
      sellingPoints: list(fields.sellingPoints),
      image: text(fields.image) || DEFAULT_IMAGE,
      accent: text(fields.accent) || DEFAULT_ACCENT,
      compliantPhrases: list(fields.compliantPhrases).length > 0 ? list(fields.compliantPhrases) : ['根据页面信息介绍材质、规格和使用场景，具体体验因人而异。', '价格和库存以商品页面实时信息为准。'],
      source: 'doubao',
      sourceText: sourceText.slice(0, 20_000),
      updatedAt: Date.now(),
    },
    source: 'doubao',
    confidence: warnings.length > 0 ? 0.78 : 0.92,
    warnings,
  };
}

export async function parseProductText(sourceText: string): Promise<ProductImportResponse> {
  const normalizedText = sourceText.trim();
  if (!normalizedText) throw new Error('请先粘贴商品信息');
  if (normalizedText.length > 20_000) throw new Error('商品信息不能超过 20000 个字符');
  const config = getDoubaoConfig();
  if (!config) return localParse(normalizedText);
  try {
    const response = await fetch(config.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.endpointId,
        temperature: 0.1,
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content: '你是商品资料结构化助手。把用户粘贴的商品详情整理成 JSON，不要补造未提供的库存和价格。只输出 JSON：{"name":"","category":"","price":"","stock":null,"sku":"","description":"","sellingPoints":[],"compliantPhrases":[],"image":"","accent":""}。compliantPhrases 必须是适合直播口播、避免绝对化和医疗功效承诺的表达。',
          },
          { role: 'user', content: normalizedText },
        ],
      }),
    });
    if (!response.ok) throw new Error(`豆包接口返回 ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('豆包返回为空');
    return normalizeDoubao(parseJsonObject(content), normalizedText);
  } catch (error) {
    return localParse(normalizedText, `豆包解析暂不可用，已切换本地识别：${error instanceof Error ? error.message : String(error)}`);
  }
}
