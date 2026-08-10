import type { ComplianceRule, CoachPurpose, PresenterPhrase, PresenterProfile, RuleAuditEntry } from '../shared/types';
import { authenticatedHeaders } from './authHeaders';

export class CatalogClient {
  constructor(private readonly actorId = 'local-operator') {}
  async rules(roomId: string): Promise<{ rules: ComplianceRule[]; audits: RuleAuditEntry[] }> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/rules`); }
  async createRule(roomId: string, input: { name: string; pattern: string; risk: 'warning' | 'blocked'; title: string; reason: string; alternative: string; policyRef: string }): Promise<ComplianceRule> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/rules`, { method: 'POST', body: JSON.stringify(input) }); }
  async setRuleEnabled(rule: ComplianceRule, enabled: boolean): Promise<ComplianceRule> { return this.request(`/api/v2/rules/${encodeURIComponent(rule.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }); }
  async presenters(roomId: string): Promise<PresenterProfile[]> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/presenters`); }
  async createPresenter(roomId: string, name: string): Promise<PresenterProfile> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/presenters`, { method: 'POST', body: JSON.stringify({ name }) }); }
  async phrases(presenterId: string, productId?: string): Promise<PresenterPhrase[]> { return this.request(`/api/v2/presenters/${encodeURIComponent(presenterId)}/phrases${productId ? `?productId=${encodeURIComponent(productId)}` : ''}`); }
  async createPhrase(presenterId: string, input: { text: string; productId?: string; purpose?: CoachPurpose; status?: 'draft' | 'reference' }): Promise<PresenterPhrase> { return this.request(`/api/v2/presenters/${encodeURIComponent(presenterId)}/phrases`, { method: 'POST', body: JSON.stringify(input) }); }
  async updatePhrase(phraseId: string, input: Partial<Pick<PresenterPhrase, 'text' | 'purpose' | 'status'>>): Promise<PresenterPhrase> { return this.request(`/api/v2/phrases/${encodeURIComponent(phraseId)}`, { method: 'PATCH', body: JSON.stringify(input) }); }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = authenticatedHeaders(init.headers, this.actorId); if (init.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { ...init, headers }); const body = await response.json().catch(() => ({})) as T & { message?: string };
    if (!response.ok) throw new Error(body.message ?? '请求失败'); return body as T;
  }
}
