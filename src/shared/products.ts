import type { Product } from './types';

export const PRODUCTS: Product[] = [
  {
    id: 'serum',
    name: '轻透焕亮精华',
    category: '护肤',
    price: '¥129',
    image: '/products/serum.svg',
    accent: '#f2b8a3',
    compliantPhrases: [
      '配方清爽不黏，适合日常护肤流程',
      '坚持使用，肤感和气色会因人而异地逐步改善',
      '今天直播间下单可享专属到手价',
    ],
  },
  {
    id: 'headphones',
    name: '云感降噪耳机',
    category: '数码',
    price: '¥299',
    image: '/products/headphones.svg',
    accent: '#9fb6d8',
    compliantPhrases: [
      '通勤和办公场景都可以体验沉浸式听感',
      '降噪效果会受佩戴方式和环境影响',
      '现在拍下享受直播间赠品，库存以页面为准',
    ],
  },
  {
    id: 'mug',
    name: '云朵保温杯',
    category: '家居',
    price: '¥79',
    image: '/products/mug.svg',
    accent: '#c9b89d',
    compliantPhrases: [
      '轻量杯身，适合办公室和日常出行',
      '保温时长会因水量、环境温度而变化',
      '下单后按页面展示的物流信息发货',
    ],
  },
];

export const DEFAULT_PRODUCT = PRODUCTS[0];
