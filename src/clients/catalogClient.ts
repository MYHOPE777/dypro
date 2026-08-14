import type { ComplianceFinding, ComplianceResult, ComplianceRule, CoachPurpose, ManualSyncJob, PresenterPhrase, PresenterProfile, Product, RuleAuditEntry, RuleDocument, RulePackage, RuleUnit } from '../shared/types';
import { authenticatedHeaders, clearAuthToken, V2_AUTH_REQUIRED_EVENT } from './authHeaders';

export class CatalogClient {
  constructor(private readonly actorId = 'local-operator') {}
  async rules(roomId: string): Promise<{ rules: ComplianceRule[]; audits: RuleAuditEntry[] }> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/rules`); }
  async products(roomId: string): Promise<Product[]> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/products`); }
  async saveProduct(roomId: string, product: Product): Promise<Product> {
    const url = `/api/v2/rooms/${encodeURIComponent(roomId)}/products/${encodeURIComponent(product.id)}`;
    try {
      return await this.request(url, { method: 'PUT', body: JSON.stringify(product) });
    } catch (error) {
      // Keep live sessions usable while an older local process is finishing.
      if (product.description.trim() || !(error instanceof Error) || !/商品描述不能为空/u.test(error.message)) throw error;
      return this.request(url, { method: 'PUT', body: JSON.stringify({ ...product, description: `${product.name}，商品资料待补充。` }) });
    }
  }
  async generateProductComplianceProfile(roomId: string, productId: string): Promise<Product> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/products/${encodeURIComponent(productId)}/compliance-profile/generate`, { method: 'POST' }); }
  async removeProduct(roomId: string, productId: string): Promise<Product[]> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/products/${encodeURIComponent(productId)}`, { method: 'DELETE' }); }
  async createRule(roomId: string, input: { name: string; pattern: string; risk: 'warning' | 'blocked'; title: string; reason: string; alternative: string; policyRef: string; scope?: 'room' | 'category' | 'product'; productId?: string; category?: string }): Promise<ComplianceRule> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/rules`, { method: 'POST', body: JSON.stringify(input) }); }
  async confirmRule(roomId: string, result: ComplianceResult): Promise<ComplianceRule> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/rules/confirm`, { method: 'POST', body: JSON.stringify({ result }) }); }
  async complianceFindings(roomId: string, disposition: 'pending' | 'confirmed' | 'dismissed' | 'all' = 'pending'): Promise<ComplianceFinding[]> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/compliance-findings?disposition=${disposition}`); }
  async confirmComplianceFinding(finding: ComplianceFinding, note?: string): Promise<{ finding: ComplianceFinding; rule: ComplianceRule }> { return this.request(`/api/v2/sessions/${encodeURIComponent(finding.sessionId)}/compliance-findings/${encodeURIComponent(finding.segmentId)}/confirm`, { method: 'POST', body: JSON.stringify({ note: note ?? '' }) }); }
  async dismissComplianceFinding(finding: ComplianceFinding, note = '中控标记为误判'): Promise<ComplianceFinding> { return this.request(`/api/v2/sessions/${encodeURIComponent(finding.sessionId)}/compliance-findings/${encodeURIComponent(finding.segmentId)}/dismiss`, { method: 'POST', body: JSON.stringify({ note }) }); }
  async setRuleEnabled(rule: ComplianceRule, enabled: boolean): Promise<ComplianceRule> { return this.request(`/api/v2/rules/${encodeURIComponent(rule.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }); }
  async reviewRule(rule: ComplianceRule, decision: 'approved' | 'rejected'): Promise<ComplianceRule> { return this.request(`/api/v2/rules/${encodeURIComponent(rule.id)}/review`, { method: 'POST', body: JSON.stringify({ decision }) }); }
  async rollbackRule(rule: ComplianceRule, version: number): Promise<ComplianceRule> { return this.request(`/api/v2/rules/${encodeURIComponent(rule.id)}/rollback`, { method: 'POST', body: JSON.stringify({ version }) }); }
  async submitRuleToPublic(rule: ComplianceRule): Promise<ComplianceRule> { return this.request(`/api/v2/rules/${encodeURIComponent(rule.id)}/public-submit`, { method: 'POST' }); }
  async reviewPublicRule(rule: ComplianceRule, decision: 'adopted' | 'deferred' | 'discarded'): Promise<ComplianceRule> { return this.request(`/api/v2/rules/${encodeURIComponent(rule.id)}/public-review`, { method: 'POST', body: JSON.stringify({ decision }) }); }
  async publicRuleCandidates(): Promise<ComplianceRule[]> { return this.request('/api/v2/operations/rules'); }
  async ruleDocuments(): Promise<RuleDocument[]> { return this.request('/api/v2/rule-documents'); }
  async reviewRuleDocument(document: RuleDocument, decision: 'approved' | 'rejected'): Promise<RuleDocument> { return this.request(`/api/v2/rule-documents/${encodeURIComponent(document.id)}/review`, { method: 'POST', body: JSON.stringify({ decision }) }); }
  async rulePackages(): Promise<{ packages: RulePackage[]; units: RuleUnit[] }> { return this.request('/api/v2/rule-packages'); }
  async roomRuleUnits(roomId: string, status?: RuleUnit['status']): Promise<RuleUnit[]> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/rule-units${status ? `?status=${encodeURIComponent(status)}` : ''}`); }
  async reviewRuleUnit(unit: RuleUnit, decision: 'approved' | 'rejected' | 'deferred' | 'discarded'): Promise<RuleUnit> { return this.request(`/api/v2/rule-units/${encodeURIComponent(unit.id)}/review`, { method: 'POST', body: JSON.stringify({ decision }) }); }
  async syncRule(rule: ComplianceRule, targets: Array<'merchant_database' | 'private_knowledge_base'>): Promise<ManualSyncJob[]> { return this.request(`/api/v2/rules/${encodeURIComponent(rule.id)}/sync`, { method: 'POST', body: JSON.stringify({ targets }) }); }
  async presenters(roomId: string): Promise<PresenterProfile[]> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/presenters`); }
  async createPresenter(roomId: string, name: string): Promise<PresenterProfile> { return this.request(`/api/v2/rooms/${encodeURIComponent(roomId)}/presenters`, { method: 'POST', body: JSON.stringify({ name }) }); }
  async phrases(presenterId: string, productId?: string): Promise<PresenterPhrase[]> { return this.request(`/api/v2/presenters/${encodeURIComponent(presenterId)}/phrases${productId ? `?productId=${encodeURIComponent(productId)}` : ''}`); }
  async createPhrase(presenterId: string, input: { text: string; productId?: string; purpose?: CoachPurpose; status?: 'draft' | 'reference' }): Promise<PresenterPhrase> { return this.request(`/api/v2/presenters/${encodeURIComponent(presenterId)}/phrases`, { method: 'POST', body: JSON.stringify(input) }); }
  async updatePhrase(phraseId: string, input: Partial<Pick<PresenterPhrase, 'text' | 'purpose' | 'status'>>): Promise<PresenterPhrase> { return this.request(`/api/v2/phrases/${encodeURIComponent(phraseId)}`, { method: 'PATCH', body: JSON.stringify(input) }); }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = authenticatedHeaders(init.headers, this.actorId); if (init.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { ...init, headers }); const body = await response.json().catch(() => ({})) as T & { message?: string };
    if (response.status === 401 && typeof window !== 'undefined') { clearAuthToken(); window.dispatchEvent(new Event(V2_AUTH_REQUIRED_EVENT)); }
    if (!response.ok) throw new Error(body.message ?? '请求失败'); return body as T;
  }
}
