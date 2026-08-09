import type { Product } from '../src/shared/types';

export type ProductMentionMatch = {
  product: Product;
  matchedTerm: string;
  matchType: 'name' | 'sku' | 'unique-name-fragment';
};

const GENERIC_NAME_FRAGMENTS = new Set([
  '一个', '下单', '产品', '价格', '今天', '体验', '使用', '商品', '库存', '我们', '日常', '活动', '现在', '直播', '适合', '这款', '页面',
]);

function normalizeMention(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function fragments(value: string): string[] {
  const characters = [...value];
  const candidates = new Set<string>();
  for (let length = 2; length <= Math.min(characters.length, 8); length += 1) {
    for (let start = 0; start + length <= characters.length; start += 1) {
      const candidate = characters.slice(start, start + length).join('');
      const containsHan = /\p{Script=Han}/u.test(candidate);
      if ((containsHan || length >= 4) && !/^\d+$/u.test(candidate) && !GENERIC_NAME_FRAGMENTS.has(candidate)) candidates.add(candidate);
    }
  }
  return [...candidates].sort((first, second) => second.length - first.length);
}

export function findMentionedProduct(transcript: string, products: Product[]): ProductMentionMatch | null {
  const normalizedTranscript = normalizeMention(transcript);
  if (!normalizedTranscript || products.length < 2) return null;
  const normalizedNames = products.map((product) => normalizeMention(product.name));
  const normalizedSkus = products.map((product) => normalizeMention(product.sku));
  const matches: Array<ProductMentionMatch & { strength: number; mentionIndex: number }> = [];

  products.forEach((product, index) => {
    const name = normalizedNames[index];
    const sku = normalizedSkus[index];
    if (sku.length >= 3 && normalizedTranscript.includes(sku)) {
      matches.push({ product, matchedTerm: product.sku, matchType: 'sku', strength: 2_000 + sku.length, mentionIndex: normalizedTranscript.lastIndexOf(sku) });
      return;
    }
    if (name.length >= 2 && normalizedTranscript.includes(name)) {
      const duplicateName = normalizedNames.some((candidate, candidateIndex) => candidateIndex !== index && candidate === name);
      if (!duplicateName) matches.push({ product, matchedTerm: product.name, matchType: 'name', strength: 1_000 + name.length, mentionIndex: normalizedTranscript.lastIndexOf(name) });
      return;
    }

    const fragment = fragments(name).find((candidate) => normalizedTranscript.includes(candidate)
      && normalizedNames.every((otherName, otherIndex) => otherIndex === index || !otherName.includes(candidate)));
    if (fragment) {
      matches.push({ product, matchedTerm: fragment, matchType: 'unique-name-fragment', strength: 100 + fragment.length, mentionIndex: normalizedTranscript.lastIndexOf(fragment) });
    }
  });

  matches.sort((first, second) => second.strength - first.strength || second.mentionIndex - first.mentionIndex);
  const best = matches[0];
  if (!best) return null;
  const equallyStrong = matches.some((candidate, index) => index > 0 && candidate.strength === best.strength && candidate.mentionIndex === best.mentionIndex);
  if (equallyStrong) return null;
  return { product: best.product, matchedTerm: best.matchedTerm, matchType: best.matchType };
}
