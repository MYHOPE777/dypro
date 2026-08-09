import { describe, expect, it } from 'vitest';
import { findMentionedProduct } from '../../server/productMentionMatcher';
import { PRODUCTS } from '../shared/products';
import type { Product } from '../shared/types';

function product(id: string, name: string, sku: string): Product {
  return {
    ...PRODUCTS[0],
    id,
    name,
    sku,
  };
}

describe('findMentionedProduct', () => {
  it('matches a complete product name', () => {
    expect(findMentionedProduct('接下来介绍云感降噪耳机', PRODUCTS)).toMatchObject({
      product: { id: 'headphones' },
      matchType: 'name',
    });
  });

  it('matches a unique spoken fragment of a product name', () => {
    expect(findMentionedProduct('现在看一下这款降噪耳机', PRODUCTS)).toMatchObject({
      product: { id: 'headphones' },
      matchType: 'unique-name-fragment',
    });
  });

  it('does not guess when a spoken fragment belongs to multiple products', () => {
    const lineup = [
      product('commute-headphones', '云感降噪耳机', 'HEADPHONE-01'),
      product('sport-headphones', '轻盈运动耳机', 'HEADPHONE-02'),
    ];
    expect(findMentionedProduct('现在来看这款耳机', lineup)).toBeNull();
    expect(findMentionedProduct('现在来看轻盈运动耳机', lineup)?.product.id).toBe('sport-headphones');
  });

  it('ignores generic sales copy without a product name', () => {
    expect(findMentionedProduct('这款商品适合日常使用，价格以页面为准', PRODUCTS)).toBeNull();
  });
});
