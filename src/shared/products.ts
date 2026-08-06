import type { Product } from './types';

export const PRODUCTS: Product[] = [
  {
    id: 'serum',
    name: '轻透焕亮精华',
    category: '护肤',
    price: '¥129',
    stock: 500,
    sku: 'SERUM-129',
    description: '轻薄清爽的日常护肤精华。',
    sellingPoints: ['质地清爽不黏', '适合日常护肤流程'],
    image: '/products/serum.svg',
    accent: '#f2b8a3',
    compliantPhrases: [
      '配方清爽不黏，适合日常护肤流程',
      '坚持使用，肤感和气色会因人而异地逐步改善',
      '今天直播间下单可享专属到手价',
    ],
    source: 'seed',
    updatedAt: 0,
  },
  {
    id: 'headphones',
    name: '云感降噪耳机',
    category: '数码',
    price: '¥299',
    stock: 120,
    sku: 'HEADPHONES-299',
    description: '适合通勤和办公场景的无线降噪耳机。',
    sellingPoints: ['通勤办公适用', '降噪效果受环境和佩戴方式影响'],
    image: '/products/headphones.svg',
    accent: '#9fb6d8',
    compliantPhrases: [
      '通勤和办公场景都可以体验沉浸式听感',
      '降噪效果会受佩戴方式和环境影响',
      '现在拍下享受直播间赠品，库存以页面为准',
    ],
    source: 'seed',
    updatedAt: 0,
  },
  {
    id: 'mug',
    name: '云朵保温杯',
    category: '家居',
    price: '¥79',
    stock: 300,
    sku: 'MUG-79',
    description: '轻量便携的日常保温杯。',
    sellingPoints: ['轻量杯身', '适合办公室和日常出行'],
    image: '/products/mug.svg',
    accent: '#c9b89d',
    compliantPhrases: [
      '轻量杯身，适合办公室和日常出行',
      '保温时长会因水量、环境温度而变化',
      '下单后按页面展示的物流信息发货',
    ],
    source: 'seed',
    updatedAt: 0,
  },
];

export const DEFAULT_PRODUCT = PRODUCTS[0];
