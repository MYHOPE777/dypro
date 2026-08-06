import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LiveRoom, Product } from '../src/shared/types';
import { PRODUCTS } from '../src/shared/products';

type CatalogFile = {
  schemaVersion: 2;
  rooms: LiveRoom[];
  products: Record<string, Product[]>;
  lineups: Record<string, string[]>;
};

export interface ProductCatalog {
  listRooms(): LiveRoom[];
  getRoom(roomId: string): LiveRoom | null;
  createRoom(input: { name: string; accountName: string; ownerActorId: string }): LiveRoom;
  list(roomId: string): Product[];
  getById(roomId: string, productId: string): Product | null;
  getLineup(sessionId: string, roomId: string): Product[];
  setLineup(sessionId: string, roomId: string, productIds: string[]): Product[];
  upsert(roomId: string, product: Product): Product;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isProduct(value: unknown): value is Product {
  if (!value || typeof value !== 'object') return false;
  const product = value as Record<string, unknown>;
  return typeof product.id === 'string'
    && typeof product.name === 'string'
    && typeof product.category === 'string'
    && typeof product.price === 'string'
    && (product.stock === null || (typeof product.stock === 'number' && Number.isSafeInteger(product.stock) && product.stock >= 0))
    && typeof product.sku === 'string'
    && typeof product.description === 'string'
    && Array.isArray(product.sellingPoints)
    && product.sellingPoints.every((item) => typeof item === 'string')
    && typeof product.image === 'string'
    && typeof product.accent === 'string'
    && Array.isArray(product.compliantPhrases)
    && product.compliantPhrases.every((item) => typeof item === 'string')
    && (product.source === 'seed' || product.source === 'manual' || product.source === 'doubao' || product.source === 'local-fallback')
    && typeof product.updatedAt === 'number';
}

function isRoom(value: unknown): value is LiveRoom {
  if (!value || typeof value !== 'object') return false;
  const room = value as Record<string, unknown>;
  return typeof room.id === 'string'
    && typeof room.name === 'string'
    && typeof room.accountName === 'string'
    && room.platform === 'douyin'
    && typeof room.ownerActorId === 'string'
    && typeof room.createdAt === 'number'
    && typeof room.updatedAt === 'number';
}

function isCatalogFile(value: unknown): value is CatalogFile {
  if (!value || typeof value !== 'object') return false;
  const catalog = value as Record<string, unknown>;
  return catalog.schemaVersion === 2
    && Array.isArray(catalog.rooms)
    && catalog.rooms.every(isRoom)
    && Boolean(catalog.products)
    && typeof catalog.products === 'object'
    && Object.values(catalog.products as Record<string, unknown>).every((items) => Array.isArray(items) && items.every(isProduct))
    && Boolean(catalog.lineups)
    && typeof catalog.lineups === 'object'
    && Object.values(catalog.lineups as Record<string, unknown>).every((items) => Array.isArray(items) && items.every((item) => typeof item === 'string'));
}

function assertRoomId(roomId: string): void {
  if (!/^room-[a-z0-9-]{4,64}$/u.test(roomId)) throw new Error('invalid room id');
}

function assertSessionId(sessionId: string): void {
  if (!/^live-[a-z0-9-]{4,32}$/u.test(sessionId)) throw new Error('invalid session id');
}

function assertProductId(productId: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/u.test(productId)) throw new Error('invalid product id');
}

function makeRoomId(name: string): string {
  return `room-${createHash('sha1').update(`${name}-${Date.now()}`).digest('hex').slice(0, 12)}`;
}

function defaultCatalog(): CatalogFile {
  const now = Date.now();
  const room: LiveRoom = {
    id: 'room-default',
    name: '默认抖音直播间',
    accountName: '演示账号',
    platform: 'douyin',
    ownerActorId: 'owner',
    createdAt: now,
    updatedAt: now,
  };
  return { schemaVersion: 2, rooms: [room], products: { [room.id]: clone(PRODUCTS) }, lineups: {} };
}

export class FileProductCatalog implements ProductCatalog {
  private readonly filePath: string;
  private data: CatalogFile;

  constructor(filePath = path.resolve(process.cwd(), '.data/products/catalog.json')) {
    this.filePath = filePath;
    this.data = this.readCatalog();
  }

  listRooms(): LiveRoom[] {
    return clone(this.data.rooms);
  }

  getRoom(roomId: string): LiveRoom | null {
    assertRoomId(roomId);
    return clone(this.data.rooms.find((room) => room.id === roomId) ?? null);
  }

  createRoom(input: { name: string; accountName: string; ownerActorId: string }): LiveRoom {
    const name = input.name.trim();
    const accountName = input.accountName.trim();
    const ownerActorId = input.ownerActorId.trim();
    if (!name || !accountName || !ownerActorId) throw new Error('直播间名称、账号名称和创建人不能为空');
    const now = Date.now();
    const room: LiveRoom = { id: makeRoomId(name), name, accountName, platform: 'douyin', ownerActorId, createdAt: now, updatedAt: now };
    this.data.rooms.push(room);
    this.data.products[room.id] = [];
    this.writeCatalog();
    return clone(room);
  }

  list(roomId: string): Product[] {
    assertRoomId(roomId);
    if (!this.getRoom(roomId)) throw new Error('直播间不存在');
    return clone(this.data.products[roomId] ?? []);
  }

  getById(roomId: string, productId: string): Product | null {
    return clone(this.list(roomId).find((product) => product.id === productId) ?? null);
  }

  getLineup(sessionId: string, roomId: string): Product[] {
    assertSessionId(sessionId);
    assertRoomId(roomId);
    const storedIds = this.data.lineups[`${roomId}:${sessionId}`];
    const products = this.list(roomId);
    if (!storedIds) return products;
    const selected = storedIds.map((productId) => products.find((product) => product.id === productId)).filter((product): product is Product => Boolean(product));
    return clone(selected.length > 0 ? selected : products);
  }

  setLineup(sessionId: string, roomId: string, productIds: string[]): Product[] {
    assertSessionId(sessionId);
    assertRoomId(roomId);
    const products = this.list(roomId);
    const validIds = [...new Set(productIds)].filter((productId) => products.some((product) => product.id === productId));
    if (validIds.length === 0) throw new Error('本场至少需要保留一个商品');
    this.data.lineups[`${roomId}:${sessionId}`] = validIds;
    this.writeCatalog();
    return this.getLineup(sessionId, roomId);
  }

  upsert(roomId: string, product: Product): Product {
    assertRoomId(roomId);
    assertProductId(product.id);
    if (!this.getRoom(roomId)) throw new Error('直播间不存在');
    if (!product.name.trim()) throw new Error('商品名称不能为空');
    if (product.stock !== null && (!Number.isSafeInteger(product.stock) || product.stock < 0)) throw new Error('商品库存必须是非负整数');
    const compliantPhrases = product.compliantPhrases.map((item) => item.trim()).filter(Boolean);
    const normalized: Product = {
      ...clone(product),
      name: product.name.trim(),
      category: product.category.trim() || '其他',
      price: product.price.trim() || '价格待确认',
      sku: product.sku.trim(),
      description: product.description.trim(),
      sellingPoints: product.sellingPoints.map((item) => item.trim()).filter(Boolean),
      compliantPhrases: compliantPhrases.length > 0 ? compliantPhrases : ['根据商品页面信息介绍材质、规格和使用场景，价格与库存以页面实时信息为准。'],
      updatedAt: Date.now(),
    };
    const products = this.data.products[roomId] ?? [];
    const index = products.findIndex((candidate) => candidate.id === normalized.id);
    if (index < 0) products.push(normalized);
    else products[index] = normalized;
    this.data.products[roomId] = products;
    this.writeCatalog();
    return clone(normalized);
  }

  private readCatalog(): CatalogFile {
    if (!existsSync(this.filePath)) return defaultCatalog();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (isCatalogFile(parsed)) return clone(parsed);
    } catch {
      // Fall back to the built-in room when the local catalog is incomplete.
    }
    return defaultCatalog();
  }

  private writeCatalog(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}
