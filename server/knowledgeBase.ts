import type { ComplianceRule, KnowledgeEvidence, LiveRoom, Product } from '../src/shared/types';

export type KnowledgeBaseStatus = {
  configured: boolean;
  available: boolean;
  label: string;
  detail: string;
  lastError?: string;
};

export type KnowledgeQuery = {
  roomId: string;
  transcript: string;
  product: Pick<Product, 'id' | 'name' | 'category' | 'price' | 'compliantPhrases'>;
  activeRules: ComplianceRule[];
};

export type KnowledgeRuleDocument = {
  rule: ComplianceRule;
  room?: Pick<LiveRoom, 'id' | 'name' | 'accountName'>;
  operation: 'upsert' | 'remove';
};

export interface ComplianceKnowledgeBase {
  retrieve(query: KnowledgeQuery): Promise<KnowledgeEvidence[]>;
  status(): KnowledgeBaseStatus;
}

export interface KnowledgeBaseIndexer {
  index(document: KnowledgeRuleDocument): Promise<void>;
  indexStatus(): KnowledgeBaseStatus;
}

const EMPTY_STATUS: KnowledgeBaseStatus = {
  configured: false,
  available: true,
  label: '方舟知识库未配置，使用规则库和豆包',
  detail: '知识库是增强召回层，不影响已发布规则的立即生效。',
};

export class DisabledKnowledgeBase implements ComplianceKnowledgeBase, KnowledgeBaseIndexer {
  retrieve(): Promise<KnowledgeEvidence[]> {
    return Promise.resolve([]);
  }

  status(): KnowledgeBaseStatus {
    return { ...EMPTY_STATUS };
  }

  indexStatus(): KnowledgeBaseStatus {
    return { ...EMPTY_STATUS, label: '方舟知识库索引待配置' };
  }

  index(): Promise<void> {
    return Promise.resolve();
  }
}

type ArkGatewayConfig = {
  retrieveUrl: string;
  indexUrl?: string;
  apiKey: string;
  collectionId?: string;
  timeoutMs: number;
};

function readPositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readConfig(env: NodeJS.ProcessEnv): ArkGatewayConfig | null {
  const retrieveUrl = env.ARK_KB_RETRIEVE_URL?.trim();
  const apiKey = env.ARK_KB_API_KEY?.trim();
  if (!retrieveUrl || !apiKey) return null;
  try {
    new URL(retrieveUrl);
  } catch {
    return null;
  }
  return {
    retrieveUrl,
    indexUrl: env.ARK_KB_INDEX_URL?.trim() || undefined,
    apiKey,
    collectionId: env.ARK_KB_COLLECTION_ID?.trim() || undefined,
    timeoutMs: readPositiveNumber(env.ARK_KB_TIMEOUT_MS, 1_500),
  };
}

function asEvidence(value: unknown, index: number): KnowledgeEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const content = typeof item.content === 'string' ? item.content : typeof item.text === 'string' ? item.text : '';
  if (!content.trim()) return null;
  const score = typeof item.score === 'number' && Number.isFinite(item.score) ? Math.max(0, Math.min(1, item.score)) : 0;
  const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : undefined;
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `ark-evidence-${index}`,
    title: typeof item.title === 'string' && item.title ? item.title : '方舟知识库召回片段',
    content: content.trim().slice(0, 2_000),
    source: typeof item.source === 'string' && item.source ? item.source : '方舟知识库',
    score,
    ...(metadata ? { metadata } : {}),
  };
}

function responseItems(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.data)) return record.data;
  if (record.data && typeof record.data === 'object' && Array.isArray((record.data as Record<string, unknown>).items)) return (record.data as Record<string, unknown>).items as unknown[];
  return [];
}

/**
 * HTTP adapter for a retrieval/index endpoint exposed by the Ark console or a
 * small in-house gateway. The endpoint and payload are explicit configuration
 * so this module never assumes an undocumented Ark URL or schema.
 */
export class ArkKnowledgeBase implements ComplianceKnowledgeBase, KnowledgeBaseIndexer {
  private readonly config: ArkGatewayConfig;
  private lastRetrieveError: string | undefined;
  private lastIndexError: string | undefined;
  private lastRetrieveAt: number | undefined;
  private lastIndexAt: number | undefined;

  constructor(config: ArkGatewayConfig) {
    this.config = config;
  }

  async retrieve(query: KnowledgeQuery): Promise<KnowledgeEvidence[]> {
    try {
      const response = await this.request(this.config.retrieveUrl, {
        collection_id: this.config.collectionId,
        query: query.transcript,
        top_k: 5,
        filters: { room_id: query.roomId, product_id: query.product.id },
      });
      const evidence = responseItems(response).map(asEvidence).filter((item): item is KnowledgeEvidence => Boolean(item)).slice(0, 5);
      this.lastRetrieveError = undefined;
      this.lastRetrieveAt = Date.now();
      return evidence;
    } catch (error) {
      this.lastRetrieveError = error instanceof Error ? error.message : String(error);
      return [];
    }
  }

  async index(document: KnowledgeRuleDocument): Promise<void> {
    if (!this.config.indexUrl) throw new Error('ARK_KB_INDEX_URL 未配置');
    try {
      await this.request(this.config.indexUrl, {
        collection_id: this.config.collectionId,
        operation: document.operation,
        document: {
          id: document.rule.id,
          room_id: document.rule.roomId,
          scope: document.rule.scope,
          version: document.rule.version,
          enabled: document.rule.enabled,
          name: document.rule.name,
          pattern: document.rule.pattern,
          risk: document.rule.risk,
          reason: document.rule.reason,
          alternative: document.rule.alternative,
          policy_ref: document.rule.policyRef,
          room: document.room,
        },
      });
      this.lastIndexError = undefined;
      this.lastIndexAt = Date.now();
    } catch (error) {
      this.lastIndexError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  status(): KnowledgeBaseStatus {
    return {
      configured: true,
      available: !this.lastRetrieveError,
      label: this.lastRetrieveError ? '方舟知识库连接异常，已降级' : '方舟知识库已配置，首句时验证',
      detail: this.lastRetrieveAt ? `最近检索成功 ${new Date(this.lastRetrieveAt).toLocaleString('zh-CN', { hour12: false })}` : '检索通过显式地址接入，不影响规则库事实源。',
      ...(this.lastRetrieveError ? { lastError: this.lastRetrieveError } : {}),
    };
  }

  indexStatus(): KnowledgeBaseStatus {
    if (!this.config.indexUrl) return { ...EMPTY_STATUS, label: '方舟知识库索引地址待配置' };
    return {
      configured: true,
      available: !this.lastIndexError,
      label: this.lastIndexError ? '方舟知识库索引异常，后台将重试' : '方舟知识库索引已配置',
      detail: this.lastIndexAt ? `最近索引成功 ${new Date(this.lastIndexAt).toLocaleString('zh-CN', { hour12: false })}` : '已发布规则由后台队列同步。',
      ...(this.lastIndexError ? { lastError: this.lastIndexError } : {}),
    };
  }

  private async request(url: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`知识库接口返回 ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

}

export function createKnowledgeBase(env: NodeJS.ProcessEnv = process.env): ComplianceKnowledgeBase & KnowledgeBaseIndexer {
  const config = readConfig(env);
  return config ? new ArkKnowledgeBase(config) : new DisabledKnowledgeBase();
}
