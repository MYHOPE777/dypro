import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { ComplianceFinding, ComplianceFindingDisposition, ComplianceResult, ComplianceRule, CoachSuggestion, LiveRoom, ManualSyncJob, PhraseMetric, PresenterPhrase, PresenterProfile, Product, RiskProfile, RuleAuditEntry, RuleDocument, RuleDocumentSource, RuleDocumentVersion, RulePackage, RuleReview, RuleUnit, SessionStats, SpeechCorrectionEntry, SyncTarget, TranscriptSegment } from '../../src/shared/types';
import type { DeliveryJob, DeliveryStatus, LiveEvent, LiveEventType, LiveSessionSnapshot, LiveLifecycle, ResourceDeliveryJob, ResourceDeliveryType, ReviewApproval, ReviewTranscript, SessionReview, SessionSummary } from '../../src/shared/v2';

export type SessionCreation = {
  sessionId: string;
  tenantId: string;
  roomId: string;
  presenterId: string;
  presenterName: string;
  product: Product;
  lineup: Product[];
  createdAt?: number;
};

export type SessionEventDraft = {
  type: LiveEventType;
  occurredAt: number;
  payload: Record<string, unknown>;
};

type SqlRow = Record<string, unknown>;

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 2500;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_products (
  room_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  product_json TEXT,
  PRIMARY KEY (room_id, product_id)
);
CREATE TABLE IF NOT EXISTS presenters (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS presenter_phrases (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  presenter_id TEXT NOT NULL,
  phrase_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS phrase_metrics (
  id TEXT PRIMARY KEY,
  phrase_id TEXT NOT NULL,
  session_id TEXT,
  metric_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  document_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  version_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(document_id, version)
);
CREATE TABLE IF NOT EXISTS rule_packages (
  id TEXT PRIMARY KEY,
  package_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_units (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  unit_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_reviews (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  review_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS compliance_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  room_id TEXT,
  rule_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_versions (
  rule_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  rule_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, version)
);
CREATE TABLE IF NOT EXISTS rule_audits (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS speech_corrections (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  correction_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS live_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  presenter_id TEXT NOT NULL,
  presenter_name TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  product_json TEXT NOT NULL,
  lineup_json TEXT NOT NULL,
  partial_transcript TEXT NOT NULL DEFAULT '',
  transcript_json TEXT NOT NULL DEFAULT '[]',
  latest_compliance_json TEXT,
  alerts_json TEXT NOT NULL DEFAULT '[]',
  coach_json TEXT NOT NULL DEFAULT '[]',
  coach_pending INTEGER NOT NULL DEFAULT 0,
  risk_profile TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  content_revision INTEGER NOT NULL DEFAULT 0,
  latest_sequence INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (session_id, sequence)
);
CREATE INDEX IF NOT EXISTS session_events_order ON session_events(session_id, sequence);
CREATE TABLE IF NOT EXISTS transcript_projections (
  session_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  segment_json TEXT NOT NULL,
  original_text TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, segment_id)
);
CREATE TABLE IF NOT EXISTS compliance_projections (
  session_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, segment_id)
);
CREATE TABLE IF NOT EXISTS compliance_findings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  product_json TEXT,
  result_json TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'pending',
  rule_id TEXT,
  disposed_by TEXT,
  disposed_at INTEGER,
  resolution_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, segment_id)
);
CREATE INDEX IF NOT EXISTS compliance_findings_room_status ON compliance_findings(room_id, disposition, updated_at DESC);
CREATE TABLE IF NOT EXISTS coach_projections (
  session_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  suggestions_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, segment_id)
);
CREATE TABLE IF NOT EXISTS session_reviews (
  session_id TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  approval TEXT NOT NULL DEFAULT 'approval_required',
  approved_revision INTEGER,
  approved_by TEXT,
  approved_at INTEGER,
  delivery TEXT NOT NULL DEFAULT 'not_queued',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS review_edits (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  segment_id TEXT,
  kind TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  content_revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audio_assets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  encoding TEXT NOT NULL,
  sample_rate INTEGER NOT NULL,
  channels INTEGER NOT NULL,
  byte_length INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  content_revision INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resource_delivery_jobs (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_version INTEGER NOT NULL,
  target TEXT NOT NULL DEFAULT 'merchant_database',
  approval_status TEXT NOT NULL DEFAULT 'awaiting_approval',
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS resource_delivery_queue ON resource_delivery_jobs(status, created_at);
CREATE TABLE IF NOT EXISTS display_links (
  alias TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boolValue(value: unknown): boolean {
  return value === 1 || value === true;
}

function safeFilename(filename: string): string {
  return filename === ':memory:' || isAbsolute(filename) ? filename : resolve(filename);
}

function emptyStats(): SessionStats {
  return { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export class SqliteFactStore {
  readonly filename: string;
  readonly audioRoot: string;
  private readonly db: DatabaseSync;
  private readonly getSessionStatement: StatementSync;

  constructor(options: { filename: string; audioRoot?: string }) {
    this.filename = safeFilename(options.filename);
    if (this.filename !== ':memory:') mkdirSync(dirname(this.filename), { recursive: true });
    this.audioRoot = options.audioRoot ?? resolve(dirname(this.filename), 'audio');
    mkdirSync(this.audioRoot, { recursive: true });
    this.db = new DatabaseSync(this.filename);
    this.db.exec(SCHEMA);
    const roomProductColumns = this.db.prepare('PRAGMA table_info(room_products)').all().map((row) => stringValue(row.name));
    if (!roomProductColumns.includes('product_json')) this.db.exec('ALTER TABLE room_products ADD COLUMN product_json TEXT');
    this.db.exec('UPDATE room_products SET product_json = (SELECT products.product_json FROM products WHERE products.id = room_products.product_id) WHERE product_json IS NULL');
    // Current sessions use one safety policy. Ended sessions retain their
    // original risk profile as part of the historical audit record.
    this.db.exec("UPDATE live_sessions SET risk_profile = 'strict' WHERE lifecycle <> 'ended' AND risk_profile <> 'strict'");
    const findingColumns = this.db.prepare('PRAGMA table_info(compliance_findings)').all().map((row) => stringValue(row.name));
    if (!findingColumns.includes('product_json')) this.db.exec('ALTER TABLE compliance_findings ADD COLUMN product_json TEXT');
    const deliveryColumns = this.db.prepare('PRAGMA table_info(resource_delivery_jobs)').all().map((row) => stringValue(row.name));
    if (!deliveryColumns.includes('target')) this.db.exec("ALTER TABLE resource_delivery_jobs ADD COLUMN target TEXT NOT NULL DEFAULT 'merchant_database'");
    if (!deliveryColumns.includes('approval_status')) this.db.exec("ALTER TABLE resource_delivery_jobs ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'");
    this.getSessionStatement = this.db.prepare('SELECT * FROM live_sessions WHERE id = ?');
  }

  close(): void {
    this.db.close();
  }

  createSession(input: SessionCreation): LiveSessionSnapshot {
    const existing = this.getSessionSnapshot(input.sessionId);
    if (existing) return existing;
    const now = input.createdAt ?? Date.now();
    const stats = emptyStats();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)').run(input.tenantId, input.tenantId, now);
      this.db.prepare('INSERT OR IGNORE INTO rooms (id, tenant_id, name, account_name, owner_actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(input.roomId, input.tenantId, input.roomId, input.roomId, 'owner', now, now);
      this.db.prepare('INSERT OR REPLACE INTO live_sessions (id, tenant_id, room_id, presenter_id, presenter_name, lifecycle, product_json, lineup_json, partial_transcript, transcript_json, latest_compliance_json, alerts_json, coach_json, coach_pending, risk_profile, stats_json, content_revision, latest_sequence, created_at, updated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        input.sessionId, input.tenantId, input.roomId, input.presenterId, input.presenterName, 'idle', json(input.product), json(input.lineup), '', '[]', null, '[]', '[]', 0, 'strict', json(stats), 0, 0, now, now, null,
      );
      this.db.prepare('INSERT OR REPLACE INTO session_reviews (session_id, note, approval, delivery, updated_at) VALUES (?, ?, ?, ?, ?)').run(input.sessionId, '', 'approval_required', 'not_queued', now);
      this.appendInsideTransaction(input.sessionId, { type: 'session.created', occurredAt: now, payload: { roomId: input.roomId, tenantId: input.tenantId, presenterId: input.presenterId, presenterName: input.presenterName, productId: input.product.id, product: json(input.product), lineup: json(input.lineup), riskProfile: 'strict' } });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getSessionSnapshot(input.sessionId)!;
  }

  ensureRoom(input: { id: string; tenantId: string; name?: string; accountName?: string; ownerActorId?: string; createdAt?: number }): void {
    const now = input.createdAt ?? Date.now();
    this.db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(input.tenantId, input.tenantId, now);
    this.db.prepare('INSERT INTO rooms (id, tenant_id, name, account_name, owner_actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, account_name=excluded.account_name, updated_at=excluded.updated_at').run(input.id, input.tenantId, input.name ?? input.id, input.accountName ?? input.id, input.ownerActorId ?? 'owner', now, now);
  }

  upsertProduct(tenantId: string, product: Product, roomId?: string): void {
    const now = product.updatedAt || Date.now();
    this.db.prepare('INSERT INTO products (id, tenant_id, product_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET product_json=excluded.product_json, updated_at=excluded.updated_at').run(product.id, tenantId, json(product), now);
    if (roomId) this.db.prepare(`
      INSERT INTO room_products (room_id, product_id, position, product_json)
      VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM room_products WHERE room_id = ?), 0), ?)
      ON CONFLICT(room_id, product_id) DO UPDATE SET product_json=excluded.product_json
    `).run(roomId, product.id, roomId, json(product));
  }

  removeRoomProduct(roomId: string, productId: string): void {
    this.db.prepare('DELETE FROM room_products WHERE room_id = ? AND product_id = ?').run(roomId, productId);
  }

  listRooms(): LiveRoom[] {
    const rows = this.db.prepare('SELECT * FROM rooms ORDER BY created_at').all();
    return rows.map((row) => ({ id: stringValue(row.id), tenantId: stringValue(row.tenant_id), name: stringValue(row.name), accountName: stringValue(row.account_name), platform: 'douyin', ownerActorId: stringValue(row.owner_actor_id, 'owner'), createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at) }));
  }

  listProducts(tenantId = 'tenant-local', roomId?: string): Product[] {
    const rows = roomId
      ? this.db.prepare('SELECT COALESCE(rp.product_json, p.product_json) AS product_json FROM products p JOIN room_products rp ON rp.product_id = p.id WHERE p.tenant_id = ? AND rp.room_id = ? ORDER BY rp.position, p.id').all(tenantId, roomId)
      : this.db.prepare('SELECT product_json FROM products WHERE tenant_id = ? ORDER BY id').all(tenantId);
    return rows.map((row) => parseJson<Product>(row.product_json, {} as Product));
  }

  ensurePresenter(input: { id: string; roomId: string; name: string; accountName: string; now?: number }): PresenterProfile {
    const now = input.now ?? Date.now();
    this.db.prepare('INSERT INTO presenters (id, room_id, name, account_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, account_name=excluded.account_name, updated_at=excluded.updated_at').run(input.id, input.roomId, input.name, input.accountName, now, now);
    return this.getPresenter(input.id)!;
  }

  getPresenter(presenterId: string): PresenterProfile | null {
    const row = this.db.prepare('SELECT * FROM presenters WHERE id = ?').get(presenterId);
    return row ? { id: stringValue(row.id), roomId: stringValue(row.room_id), name: stringValue(row.name), accountName: stringValue(row.account_name), createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at) } : null;
  }

  listPresenters(roomId: string): PresenterProfile[] {
    return this.db.prepare('SELECT * FROM presenters WHERE room_id = ? ORDER BY created_at').all(roomId).map((row) => ({ id: stringValue(row.id), roomId: stringValue(row.room_id), name: stringValue(row.name), accountName: stringValue(row.account_name), createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at) }));
  }

  savePhrase(phrase: PresenterPhrase): PresenterPhrase {
    this.db.prepare('INSERT INTO presenter_phrases (id, room_id, presenter_id, phrase_json, version, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET phrase_json=excluded.phrase_json, version=excluded.version, status=excluded.status, updated_at=excluded.updated_at').run(phrase.id, phrase.roomId, phrase.presenterId, json(phrase), phrase.version, phrase.status, phrase.updatedAt);
    return phrase;
  }

  getPhrase(phraseId: string): PresenterPhrase | null {
    const row = this.db.prepare('SELECT phrase_json FROM presenter_phrases WHERE id = ?').get(phraseId);
    return row ? parseJson<PresenterPhrase>(row.phrase_json, {} as PresenterPhrase) : null;
  }

  listPhrases(presenterId: string, productId?: string): PresenterPhrase[] {
    const rows = this.db.prepare('SELECT phrase_json FROM presenter_phrases WHERE presenter_id = ? ORDER BY updated_at DESC').all(presenterId);
    return rows.map((row) => parseJson<PresenterPhrase>(row.phrase_json, {} as PresenterPhrase)).filter((phrase) => !productId || phrase.productId === null || phrase.productId === productId);
  }

  savePhraseMetric(metric: PhraseMetric): PhraseMetric {
    this.db.prepare('INSERT INTO phrase_metrics (id, phrase_id, session_id, metric_json, created_at) VALUES (?, ?, ?, ?, ?)').run(metric.id, metric.phraseId, metric.sessionId ?? null, json(metric), metric.createdAt);
    return metric;
  }

  listPhraseMetrics(phraseId: string): PhraseMetric[] {
    return this.db.prepare('SELECT metric_json FROM phrase_metrics WHERE phrase_id = ? ORDER BY created_at DESC').all(phraseId).map((row) => parseJson<PhraseMetric>(row.metric_json, {} as PhraseMetric));
  }

  saveRuleDocument(document: RuleDocument, version: RuleDocumentVersion): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO rule_documents (id, tenant_id, document_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json, updated_at=excluded.updated_at').run(document.id, document.tenantId ?? null, json(document), document.updatedAt);
      this.db.prepare('INSERT INTO rule_document_versions (id, document_id, version, version_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(document_id, version) DO UPDATE SET version_json=excluded.version_json').run(version.id, document.id, version.version, json(version), version.createdAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getRuleDocument(documentId: string): RuleDocument | null {
    const row = this.db.prepare('SELECT document_json FROM rule_documents WHERE id = ?').get(documentId);
    return row ? parseJson<RuleDocument>(row.document_json, {} as RuleDocument) : null;
  }

  listRuleDocuments(status?: RuleDocument['status']): RuleDocument[] {
    const rows = status ? this.db.prepare('SELECT document_json FROM rule_documents WHERE json_extract(document_json, \'$.status\') = ? ORDER BY updated_at DESC').all(status) : this.db.prepare('SELECT document_json FROM rule_documents ORDER BY updated_at DESC').all();
    return rows.map((row) => parseJson<RuleDocument>(row.document_json, {} as RuleDocument));
  }

  listRuleDocumentVersions(documentId: string): RuleDocumentVersion[] {
    return this.db.prepare('SELECT version_json FROM rule_document_versions WHERE document_id = ? ORDER BY version DESC').all(documentId).map((row) => parseJson<RuleDocumentVersion>(row.version_json, {} as RuleDocumentVersion));
  }

  saveRulePackage(pkg: RulePackage): RulePackage {
    this.db.prepare('INSERT INTO rule_packages (id, package_json, version, enabled, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET package_json=excluded.package_json, version=excluded.version, enabled=excluded.enabled, updated_at=excluded.updated_at').run(pkg.id, json(pkg), pkg.version, pkg.enabled ? 1 : 0, pkg.updatedAt);
    return pkg;
  }

  getRulePackage(packageId: string): RulePackage | null {
    const row = this.db.prepare('SELECT package_json FROM rule_packages WHERE id = ?').get(packageId);
    return row ? parseJson<RulePackage>(row.package_json, {} as RulePackage) : null;
  }

  listRulePackages(status?: RulePackage['status']): RulePackage[] {
    const rows = status ? this.db.prepare('SELECT package_json FROM rule_packages WHERE json_extract(package_json, \'$.status\') = ? ORDER BY updated_at DESC').all(status) : this.db.prepare('SELECT package_json FROM rule_packages ORDER BY updated_at DESC').all();
    return rows.map((row) => parseJson<RulePackage>(row.package_json, {} as RulePackage));
  }

  createRuleDocumentVersion(input: Omit<RuleDocument, 'latestVersion' | 'status' | 'createdAt' | 'updatedAt' | 'source'> & { content: string; source?: RuleDocumentSource; now?: number }): { document: RuleDocument; version: RuleDocumentVersion } {
    const now = input.now ?? Date.now();
    const current = this.getRuleDocument(input.id);
    const previous = current ? this.listRuleDocumentVersions(input.id)[0] : undefined;
    const versionNumber = (current?.latestVersion ?? 0) + 1;
    const contentHash = createHash('sha256').update(input.content).digest('hex');
    const lines = input.content.split(/\r?\n/u);
    const previousLines = previous?.content.split(/\r?\n/u) ?? [];
    const added = Math.max(0, lines.length - previousLines.length);
    const removed = Math.max(0, previousLines.length - lines.length);
    const changed = previous ? lines.slice(0, Math.min(lines.length, previousLines.length)).filter((line, index) => line !== previousLines[index]).length : 0;
    const document: RuleDocument = { id: input.id, tenantId: input.tenantId, platform: input.platform, industry: input.industry, title: input.title, publisher: input.publisher, source: input.source ?? 'upload', sourceUrl: input.sourceUrl, status: 'pending_review', latestVersion: versionNumber, createdAt: current?.createdAt ?? now, updatedAt: now };
    const version: RuleDocumentVersion = { id: `rule-doc-version-${randomUUID()}`, documentId: input.id, version: versionNumber, content: input.content, contentHash, fetchedAt: now, diffSummary: { added, removed, changed }, changedSections: lines.filter((line, index) => previous && line !== previousLines[index]).slice(0, 20), createdAt: now };
    this.saveRuleDocument(document, version);
    return { document, version };
  }

  saveRuleUnit(unit: RuleUnit): RuleUnit {
    this.db.prepare('INSERT INTO rule_units (id, package_id, unit_json, version, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET unit_json=excluded.unit_json, version=excluded.version, enabled=excluded.enabled, updated_at=excluded.updated_at').run(unit.id, unit.packageId, json(unit), unit.version, unit.enabled ? 1 : 0, unit.updatedAt);
    return unit;
  }

  getRuleUnit(unitId: string): RuleUnit | null {
    const row = this.db.prepare('SELECT unit_json FROM rule_units WHERE id = ?').get(unitId);
    return row ? parseJson<RuleUnit>(row.unit_json, {} as RuleUnit) : null;
  }

  listRuleUnits(status?: RuleUnit['status']): RuleUnit[] {
    const rows = status ? this.db.prepare('SELECT unit_json FROM rule_units WHERE json_extract(unit_json, \'$.status\') = ? ORDER BY updated_at DESC').all(status) : this.db.prepare('SELECT unit_json FROM rule_units ORDER BY updated_at DESC').all();
    return rows.map((row) => parseJson<RuleUnit>(row.unit_json, {} as RuleUnit));
  }

  saveRuleReview(review: RuleReview): RuleReview {
    this.db.prepare('INSERT INTO rule_reviews (id, resource_type, resource_id, review_json, created_at) VALUES (?, ?, ?, ?, ?)').run(review.id, review.resourceType, review.resourceId, json(review), review.createdAt);
    return review;
  }

  listRuleReviews(resourceId?: string): RuleReview[] {
    const rows = resourceId ? this.db.prepare('SELECT review_json FROM rule_reviews WHERE resource_id = ? ORDER BY created_at DESC').all(resourceId) : this.db.prepare('SELECT review_json FROM rule_reviews ORDER BY created_at DESC').all();
    return rows.map((row) => parseJson<RuleReview>(row.review_json, {} as RuleReview));
  }

  saveRule(rule: ComplianceRule, audit: { actorId: string; action: RuleAuditEntry['action']; details: Record<string, unknown>; occurredAt?: number }): ComplianceRule {
    const occurredAt = audit.occurredAt ?? Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO compliance_rules (id, tenant_id, room_id, rule_json, version, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET rule_json=excluded.rule_json, version=excluded.version, enabled=excluded.enabled, updated_at=excluded.updated_at').run(rule.id, 'tenant-local', rule.roomId, json(rule), rule.version, rule.enabled ? 1 : 0, rule.updatedAt);
      this.db.prepare('INSERT INTO rule_versions (rule_id, version, rule_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(rule_id, version) DO UPDATE SET rule_json=excluded.rule_json').run(rule.id, rule.version, json(rule), occurredAt);
      this.db.prepare('INSERT INTO rule_audits (id, rule_id, actor_id, action, details_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)').run(`audit-${randomUUID()}`, rule.id, audit.actorId, audit.action, json(audit.details), occurredAt);
      this.db.exec('COMMIT');
      return rule;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getRule(ruleId: string): ComplianceRule | null {
    const row = this.db.prepare('SELECT rule_json FROM compliance_rules WHERE id = ?').get(ruleId);
    return row ? parseJson<ComplianceRule>(row.rule_json, {} as ComplianceRule) : null;
  }

  getRuleVersion(ruleId: string, version: number): ComplianceRule | null {
    const row = this.db.prepare('SELECT rule_json FROM rule_versions WHERE rule_id = ? AND version = ?').get(ruleId, version);
    return row ? parseJson<ComplianceRule>(row.rule_json, {} as ComplianceRule) : null;
  }

  listRuleVersions(ruleId: string): ComplianceRule[] {
    return this.db.prepare('SELECT rule_json FROM rule_versions WHERE rule_id = ? ORDER BY version DESC').all(ruleId).map((row) => parseJson<ComplianceRule>(row.rule_json, {} as ComplianceRule));
  }

  listRules(roomId: string, activeOnly = false): ComplianceRule[] {
    const rows = this.db.prepare('SELECT rule_json FROM compliance_rules WHERE room_id = ? ORDER BY updated_at DESC').all(roomId);
    const rules = rows.map((row) => parseJson<ComplianceRule>(row.rule_json, {} as ComplianceRule));
    return activeOnly ? rules.filter((rule) => rule.enabled && rule.status === 'published') : rules;
  }

  listPublicRuleCandidates(): ComplianceRule[] {
    return this.db.prepare('SELECT rule_json FROM compliance_rules ORDER BY updated_at DESC').all()
      .map((row) => parseJson<ComplianceRule>(row.rule_json, {} as ComplianceRule))
      .filter((rule) => rule.roomId !== 'public-library' && rule.publicStatus && rule.publicStatus !== 'not_submitted');
  }

  listRuleAudits(roomId: string): RuleAuditEntry[] {
    return this.db.prepare('SELECT a.* FROM rule_audits a JOIN compliance_rules r ON r.id = a.rule_id WHERE r.room_id = ? ORDER BY a.occurred_at DESC').all(roomId).map((row) => ({ id: stringValue(row.id), ruleId: stringValue(row.rule_id), roomId, action: stringValue(row.action) as RuleAuditEntry['action'], actorId: stringValue(row.actor_id), occurredAt: numberValue(row.occurred_at), details: parseJson<Record<string, unknown>>(row.details_json, {}) }));
  }

  listComplianceFindings(roomId: string, disposition?: ComplianceFindingDisposition | 'all'): ComplianceFinding[] {
    const rows = !disposition || disposition === 'all'
      ? this.db.prepare('SELECT * FROM compliance_findings WHERE room_id = ? ORDER BY updated_at DESC').all(roomId)
      : this.db.prepare('SELECT * FROM compliance_findings WHERE room_id = ? AND disposition = ? ORDER BY updated_at DESC').all(roomId, disposition);
    return rows.map((row) => this.complianceFindingFromRow(row));
  }

  getComplianceFinding(sessionId: string, segmentId: string): ComplianceFinding | null {
    const row = this.db.prepare('SELECT * FROM compliance_findings WHERE session_id = ? AND segment_id = ?').get(sessionId, segmentId);
    return row ? this.complianceFindingFromRow(row) : null;
  }

  resolveComplianceFinding(sessionId: string, segmentId: string, disposition: Exclude<ComplianceFindingDisposition, 'pending'>, actorId: string, ruleId?: string, note?: string, now = Date.now()): ComplianceFinding {
    const existing = this.getComplianceFinding(sessionId, segmentId);
    if (!existing) throw new Error('待处置风险不存在');
    if (existing.disposition === disposition && (!ruleId || existing.ruleId === ruleId)) return existing;
    if (existing.disposition !== 'pending') throw new Error('该风险已完成处置');
    this.db.prepare('UPDATE compliance_findings SET disposition = ?, rule_id = ?, disposed_by = ?, disposed_at = ?, resolution_note = ?, updated_at = ? WHERE session_id = ? AND segment_id = ?').run(disposition, ruleId ?? null, actorId, now, note?.trim() || null, now, sessionId, segmentId);
    return this.getComplianceFinding(sessionId, segmentId)!;
  }

  registerAudioAsset(input: { sessionId: string; id?: string; path: string; encoding?: string; sampleRate?: number; channels?: number; byteLength: number; durationMs: number; now?: number }): void {
    const now = input.now ?? Date.now();
    this.db.prepare('INSERT INTO audio_assets (id, session_id, path, encoding, sample_rate, channels, byte_length, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET byte_length=excluded.byte_length, duration_ms=excluded.duration_ms').run(input.id ?? `audio-${randomUUID()}`, input.sessionId, input.path, input.encoding ?? 'pcm_s16le', input.sampleRate ?? 16_000, input.channels ?? 1, input.byteLength, input.durationMs, now);
  }

  listAudioAssets(sessionId: string): Array<{ id: string; path: string; encoding: string; sampleRate: number; channels: number; byteLength: number; durationMs: number }> {
    return this.db.prepare("SELECT * FROM audio_assets WHERE session_id = ? ORDER BY CASE WHEN encoding = 'pcm_s16le_source' THEN 0 ELSE 1 END, created_at DESC").all(sessionId).map((row) => ({
      id: stringValue(row.id), path: stringValue(row.path), encoding: stringValue(row.encoding), sampleRate: numberValue(row.sample_rate), channels: numberValue(row.channels), byteLength: numberValue(row.byte_length), durationMs: numberValue(row.duration_ms),
    }));
  }

  listSpeechCorrections(roomId: string): SpeechCorrectionEntry[] {
    return this.db.prepare('SELECT correction_json FROM speech_corrections WHERE room_id = ? ORDER BY updated_at DESC').all(roomId).map((row) => parseJson<SpeechCorrectionEntry>(row.correction_json, {} as SpeechCorrectionEntry));
  }

  applySpeechCorrections(roomId: string, text: string): { text: string; applied: SpeechCorrectionEntry[] } {
    const applied = this.listSpeechCorrections(roomId).filter((entry) => entry.enabled && text.includes(entry.wrongText)).sort((left, right) => right.wrongText.length - left.wrongText.length || right.updatedAt - left.updatedAt);
    if (applied.length === 0) return { text, applied: [] };
    const replacements = new Map(applied.map((entry) => [entry.wrongText, entry.correctText]));
    const pattern = new RegExp(applied.map((entry) => escapeRegExp(entry.wrongText)).join('|'), 'gu');
    return { text: text.replace(pattern, (match) => replacements.get(match) ?? match), applied };
  }

  speechCorrectionHotwords(roomId: string): string[] {
    return [...new Set(this.listSpeechCorrections(roomId).filter((entry) => entry.enabled).map((entry) => entry.correctText))].slice(0, 20);
  }

  getOrCreateDisplayLink(sessionId: string, now = Date.now(), ttlMs = 12 * 60 * 60 * 1_000): { alias: string; sessionId: string; expiresAt: number } {
    const existing = this.db.prepare('SELECT * FROM display_links WHERE session_id = ? AND expires_at > ?').get(sessionId, now);
    if (existing) return { alias: stringValue(existing.alias), sessionId, expiresAt: numberValue(existing.expires_at) };
    this.db.prepare('DELETE FROM display_links WHERE session_id = ? OR expires_at <= ?').run(sessionId, now);
    let alias = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      alias = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
      try { this.db.prepare('INSERT INTO display_links (alias, session_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(alias, sessionId, now + ttlMs, now); break; } catch { alias = ''; }
    }
    if (!alias) throw new Error('主播屏短地址生成失败');
    return { alias, sessionId, expiresAt: now + ttlMs };
  }

  resolveDisplayLink(alias: string, now = Date.now()): string | null {
    const row = this.db.prepare('SELECT session_id FROM display_links WHERE alias = ? AND expires_at > ?').get(alias.toUpperCase(), now);
    return row ? stringValue(row.session_id) : null;
  }

  appendSessionEvent(sessionId: string, draft: SessionEventDraft): LiveEvent {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const event = this.appendInsideTransaction(sessionId, draft);
      this.db.exec('COMMIT');
      return event;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listSessionEvents(sessionId: string): LiveEvent[] {
    const rows = this.db.prepare('SELECT sequence, type, occurred_at, payload_json FROM session_events WHERE session_id = ? ORDER BY sequence').all(sessionId);
    return rows.map((row) => ({ sessionId, sequence: numberValue(row.sequence), type: stringValue(row.type) as LiveEventType, occurredAt: numberValue(row.occurred_at), payload: parseJson<Record<string, unknown>>(row.payload_json, {}) }));
  }

  getSessionSnapshot(sessionId: string): LiveSessionSnapshot | null {
    const row = this.getSessionStatement.get(sessionId);
    if (!row) return null;
    return this.snapshotFromRow(row);
  }

  rebuildSessionProjections(sessionId: string): LiveSessionSnapshot {
    const currentRow = this.getSessionStatement.get(sessionId);
    if (!currentRow) throw new Error('直播场次不存在');
    const current = this.snapshotFromRow(currentRow);
    const events = this.listSessionEvents(sessionId);
    if (events.length === 0) throw new Error('直播场次没有可重建的事件');
    events.forEach((event, index) => {
      if (event.sequence !== index + 1) throw new Error(`直播场次事件序列不连续：期望 ${index + 1}，实际 ${event.sequence}`);
    });
    const created = events.find((event) => event.type === 'session.created') ?? events[0];
    const initialProduct = parseJson<Product>(created.payload.product, current.product);
    const initialLineup = parseJson<Product[]>(created.payload.lineup, current.lineup);
    const reviewEdits = this.db.prepare('SELECT * FROM review_edits WHERE session_id = ? ORDER BY content_revision, created_at, id').all(sessionId);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM transcript_projections WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM compliance_projections WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM coach_projections WHERE session_id = ?').run(sessionId);
      this.db.prepare('UPDATE live_sessions SET presenter_id = ?, presenter_name = ?, lifecycle = ?, product_json = ?, lineup_json = ?, partial_transcript = ?, transcript_json = ?, latest_compliance_json = NULL, alerts_json = ?, coach_json = ?, coach_pending = 0, risk_profile = ?, stats_json = ?, content_revision = 0, latest_sequence = 0, created_at = ?, updated_at = ?, ended_at = NULL WHERE id = ?').run(
        stringValue(created.payload.presenterId, current.presenterId), stringValue(created.payload.presenterName, current.presenterName), 'idle', json(initialProduct), json(initialLineup), '', '[]', '[]', '[]', stringValue(created.payload.riskProfile, current.riskProfile), json(emptyStats()), created.occurredAt, created.occurredAt, sessionId,
      );

      for (const event of events) {
        const row = this.getSessionStatement.get(sessionId)!;
        const next = this.project(row, event);
        this.persistSessionProjection(sessionId, next, event, row.ended_at);
        this.projectNormalizedTables(sessionId, event, false);
      }

      let contentRevision = this.getContentRevision(sessionId);
      let updatedAt = events.at(-1)?.occurredAt ?? created.occurredAt;
      for (const edit of reviewEdits) {
        const kind = stringValue(edit.kind);
        if (kind === 'transcript.corrected' || kind === 'speaker.assigned') {
          const segmentId = stringValue(edit.segment_id);
          const segment = parseJson<TranscriptSegment | null>(edit.after_json, null);
          if (segment && segmentId) this.db.prepare('UPDATE transcript_projections SET revision = revision + 1, segment_json = ? WHERE session_id = ? AND segment_id = ?').run(json(segment), sessionId, segmentId);
        }
        contentRevision = Math.max(contentRevision, numberValue(edit.content_revision));
        updatedAt = Math.max(updatedAt, numberValue(edit.created_at));
      }
      this.db.prepare('UPDATE live_sessions SET transcript_json = ?, content_revision = ?, updated_at = ? WHERE id = ?').run(json(this.transcriptsForSession(sessionId)), contentRevision, updatedAt, sessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getSessionSnapshot(sessionId)!;
  }

  listSessionSummaries(roomId?: string): SessionSummary[] {
    const rows = roomId
      ? this.db.prepare('SELECT * FROM live_sessions WHERE room_id = ? ORDER BY created_at DESC').all(roomId)
      : this.db.prepare('SELECT * FROM live_sessions ORDER BY created_at DESC').all();
    return rows.map((row) => this.summaryFromRow(row));
  }

  getSessionReview(sessionId: string): SessionReview | null {
    const summary = this.listSessionSummaries().find((candidate) => candidate.sessionId === sessionId);
    if (!summary) return null;
    const rows = this.db.prepare('SELECT segment_json, revision, original_text, note FROM transcript_projections WHERE session_id = ? ORDER BY json_extract(segment_json, \'$.timestamp\')').all(sessionId);
    const review = this.db.prepare('SELECT * FROM session_reviews WHERE session_id = ?').get(sessionId);
    const audio = this.listAudioAssets(sessionId)[0];
    return {
      summary,
      transcripts: rows.map((row) => ({ ...parseJson<TranscriptSegment>(row.segment_json, {} as TranscriptSegment), revision: numberValue(row.revision), originalText: stringValue(row.original_text), note: stringValue(row.note) })),
      audioPath: audio?.path ?? null,
      approval: (stringValue(review?.approval, 'approval_required') as ReviewApproval),
      delivery: (stringValue(review?.delivery, 'not_queued') as DeliveryStatus),
      approvedRevision: review?.approved_revision === null || review?.approved_revision === undefined ? null : numberValue(review.approved_revision),
      approvedBy: review?.approved_by === null || review?.approved_by === undefined ? null : stringValue(review.approved_by),
      approvedAt: review?.approved_at === null || review?.approved_at === undefined ? null : numberValue(review.approved_at),
    };
  }

  updateReview(sessionId: string, update: { note?: string; approval?: ReviewApproval; approvedRevision?: number | null; approvedBy?: string | null; approvedAt?: number | null; delivery?: DeliveryStatus }, now = Date.now()): void {
    const current = this.db.prepare('SELECT * FROM session_reviews WHERE session_id = ?').get(sessionId);
    if (!current) throw new Error('直播场次不存在');
    this.db.prepare('UPDATE session_reviews SET note = ?, approval = ?, approved_revision = ?, approved_by = ?, approved_at = ?, delivery = ?, updated_at = ? WHERE session_id = ?').run(
      update.note ?? stringValue(current.note),
      update.approval ?? stringValue(current.approval, 'approval_required'),
      update.approvedRevision === undefined ? current.approved_revision ?? null : update.approvedRevision,
      update.approvedBy === undefined ? current.approved_by ?? null : update.approvedBy,
      update.approvedAt === undefined ? current.approved_at ?? null : update.approvedAt,
      update.delivery ?? stringValue(current.delivery, 'not_queued'), now, sessionId,
    );
  }

  incrementContentRevision(sessionId: string, now = Date.now()): number {
    this.db.prepare('UPDATE live_sessions SET content_revision = content_revision + 1, updated_at = ? WHERE id = ?').run(now, sessionId);
    const row = this.getSessionStatement.get(sessionId);
    if (!row) throw new Error('直播场次不存在');
    return numberValue(row.content_revision);
  }

  addReviewEdit(input: { sessionId: string; segmentId?: string; kind: string; before: unknown; after: unknown; contentRevision: number; actorId: string; createdAt?: number }): void {
    this.db.prepare('INSERT INTO review_edits (id, session_id, segment_id, kind, before_json, after_json, content_revision, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      `edit-${randomUUID()}`, input.sessionId, input.segmentId ?? null, input.kind, json(input.before), json(input.after), input.contentRevision, input.actorId, input.createdAt ?? Date.now(),
    );
  }

  updateTranscript(sessionId: string, segmentId: string, update: { segment: TranscriptSegment; originalText?: string; note?: string; revision: number }, now = Date.now()): void {
    this.db.prepare('INSERT INTO transcript_projections (session_id, segment_id, revision, segment_json, original_text, note) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, segment_id) DO UPDATE SET revision=excluded.revision, segment_json=excluded.segment_json, original_text=excluded.original_text, note=excluded.note').run(
      sessionId, segmentId, update.revision, json(update.segment), update.originalText ?? update.segment.text, update.note ?? '',
    );
    this.db.prepare('UPDATE live_sessions SET transcript_json = ?, content_revision = content_revision + 1, updated_at = ? WHERE id = ?').run(json(this.transcriptsForSession(sessionId)), now, sessionId);
  }

  setSpeaker(sessionId: string, segmentId: string, segment: TranscriptSegment, revision: number, now = Date.now()): void {
    this.updateTranscript(sessionId, segmentId, { segment, revision }, now);
  }

  getContentRevision(sessionId: string): number {
    const row = this.db.prepare('SELECT content_revision FROM live_sessions WHERE id = ?').get(sessionId);
    if (!row) throw new Error('直播场次不存在');
    return numberValue(row.content_revision);
  }

  editReviewTranscript(sessionId: string, segmentId: string, segment: TranscriptSegment, actorId: string, kind = 'transcript.corrected', now = Date.now(), correction?: { roomId: string; wrongText: string; correctText: string }): { contentRevision: number; segment: TranscriptSegment } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.getSessionStatement.get(sessionId);
      const previousRow = this.db.prepare('SELECT * FROM transcript_projections WHERE session_id = ? AND segment_id = ?').get(sessionId, segmentId);
      if (!session || !previousRow) throw new Error('转录片段不存在');
      const previous = parseJson<TranscriptSegment>(previousRow.segment_json, segment);
      const contentRevision = numberValue(session.content_revision) + 1;
      const revision = numberValue(previousRow.revision) + 1;
      this.db.prepare('UPDATE transcript_projections SET revision = ?, segment_json = ?, original_text = ?, note = ? WHERE session_id = ? AND segment_id = ?').run(revision, json(segment), stringValue(previousRow.original_text, previous.text), stringValue(previousRow.note), sessionId, segmentId);
      this.db.prepare('UPDATE live_sessions SET transcript_json = ?, content_revision = ?, updated_at = ? WHERE id = ?').run(json(this.transcriptsForSession(sessionId)), contentRevision, now, sessionId);
      this.revokeReviewInside(sessionId, now);
      if (correction) this.recordSpeechCorrectionInside(correction.roomId, { ...correction, actorId, sessionId, segmentId }, now);
      this.db.prepare('INSERT INTO review_edits (id, session_id, segment_id, kind, before_json, after_json, content_revision, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`edit-${randomUUID()}`, sessionId, segmentId, kind, json(previous), json(segment), contentRevision, actorId, now);
      this.db.exec('COMMIT');
      return { contentRevision, segment };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private recordSpeechCorrectionInside(roomId: string, input: { wrongText: string; correctText: string; actorId: string; sessionId: string; segmentId: string }, now: number): void {
    const wrongText = input.wrongText.trim();
    const correctText = input.correctText.trim();
    if (!wrongText || !correctText || wrongText === correctText || wrongText.length > 80 || correctText.length > 80) return;
    const existing = this.listSpeechCorrections(roomId).find((entry) => entry.wrongText === wrongText);
    const entry: SpeechCorrectionEntry = existing ? {
      ...existing, correctText, enabled: true, confirmations: existing.confirmations + 1, updatedAt: now, lastSessionId: input.sessionId, lastSegmentId: input.segmentId,
    } : {
      id: `speech-correction-${randomUUID()}`, roomId, wrongText, correctText, enabled: true, confirmations: 1, createdBy: input.actorId, createdAt: now, updatedAt: now, lastSessionId: input.sessionId, lastSegmentId: input.segmentId,
    };
    this.db.prepare('INSERT INTO speech_corrections (id, room_id, correction_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET correction_json=excluded.correction_json, updated_at=excluded.updated_at').run(entry.id, roomId, json(entry), now);
  }

  editReviewNote(sessionId: string, note: string, actorId: string, now = Date.now()): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.getSessionStatement.get(sessionId);
      const review = this.db.prepare('SELECT note FROM session_reviews WHERE session_id = ?').get(sessionId);
      if (!session || !review) throw new Error('直播场次不存在');
      const contentRevision = numberValue(session.content_revision) + 1;
      this.db.prepare('UPDATE live_sessions SET content_revision = ?, updated_at = ? WHERE id = ?').run(contentRevision, now, sessionId);
      this.revokeReviewInside(sessionId, now, note);
      this.db.prepare('INSERT INTO review_edits (id, session_id, segment_id, kind, before_json, after_json, content_revision, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`edit-${randomUUID()}`, sessionId, null, 'note.updated', json({ note: stringValue(review.note) }), json({ note }), contentRevision, actorId, now);
      this.db.exec('COMMIT');
      return contentRevision;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  approveCurrentDelivery(sessionId: string, actorId: string, now = Date.now()): DeliveryJob {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.getSessionStatement.get(sessionId);
      const review = this.db.prepare('SELECT * FROM session_reviews WHERE session_id = ?').get(sessionId);
      if (!session || !review) throw new Error('直播场次不存在');
      if (session.lifecycle !== 'ended') throw new Error('直播场次尚未结束，不能上传');
      const contentRevision = numberValue(session.content_revision);
      const key = `${sessionId}:${contentRevision}`;
      const existing = this.db.prepare('SELECT * FROM delivery_jobs WHERE idempotency_key = ?').get(key);
      const existingStatus = stringValue(existing?.status, 'queued') as DeliveryStatus;
      const deliveryStatus: DeliveryStatus = !existing || existingStatus === 'failed' ? 'queued' : existingStatus;
      if (!existing || stringValue(existing.status) === 'failed') {
        this.db.prepare('INSERT INTO delivery_jobs (id, session_id, content_revision, idempotency_key, status, attempt_count, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO UPDATE SET status=\'queued\', last_error=NULL, updated_at=excluded.updated_at').run(`delivery-${randomUUID()}`, sessionId, contentRevision, key, 'queued', numberValue(existing?.attempt_count), null, now, now);
      }
      this.db.prepare('UPDATE session_reviews SET approval = ?, approved_revision = ?, approved_by = ?, approved_at = ?, delivery = ?, updated_at = ? WHERE session_id = ?').run('approved', contentRevision, actorId, now, deliveryStatus, now, sessionId);
      this.db.exec('COMMIT');
      return this.getDeliveryJob(key)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  retryDelivery(sessionId: string, actorId: string, now = Date.now()): DeliveryJob {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.getSessionStatement.get(sessionId);
      const review = this.db.prepare('SELECT * FROM session_reviews WHERE session_id = ?').get(sessionId);
      if (!session || !review) throw new Error('直播场次不存在');
      const revision = numberValue(session.content_revision);
      if (stringValue(review.approval) !== 'approved' || numberValue(review.approved_revision) !== revision) throw new Error('请先确认当前内容版本');
      const key = `${sessionId}:${revision}`;
      const job = this.db.prepare('SELECT * FROM delivery_jobs WHERE idempotency_key = ?').get(key);
      if (!job) throw new Error('上传任务不存在');
      if (stringValue(job.status) !== 'failed') return this.getDeliveryJob(key)!;
      this.db.prepare('UPDATE delivery_jobs SET status = ?, last_error = NULL, updated_at = ? WHERE idempotency_key = ?').run('queued', now, key);
      this.db.prepare('UPDATE session_reviews SET delivery = ?, updated_at = ? WHERE session_id = ?').run('queued', now, sessionId);
      this.db.exec('COMMIT');
      void actorId;
      return this.getDeliveryJob(key)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createDeliveryJob(input: { sessionId: string; contentRevision: number; now?: number }): DeliveryJob {
    const now = input.now ?? Date.now();
    const idempotencyKey = `${input.sessionId}:${input.contentRevision}`;
    this.db.prepare('INSERT INTO delivery_jobs (id, session_id, content_revision, idempotency_key, status, attempt_count, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING').run(
      `delivery-${randomUUID()}`, input.sessionId, input.contentRevision, idempotencyKey, 'queued', 0, null, now, now,
    );
    this.updateReview(input.sessionId, { delivery: 'queued' }, now);
    return this.getDeliveryJob(idempotencyKey)!;
  }

  getDeliveryJob(idempotencyKey: string): DeliveryJob | null {
    const row = this.db.prepare('SELECT * FROM delivery_jobs WHERE idempotency_key = ?').get(idempotencyKey);
    if (!row) return null;
    return {
      id: stringValue(row.id), sessionId: stringValue(row.session_id), contentRevision: numberValue(row.content_revision),
      status: stringValue(row.status, 'queued') as DeliveryStatus, idempotencyKey: stringValue(row.idempotency_key),
      attemptCount: numberValue(row.attempt_count), lastError: row.last_error === null ? null : stringValue(row.last_error),
      createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at),
    };
  }

  listDeliveryJobs(status?: DeliveryStatus): DeliveryJob[] {
    const rows = status ? this.db.prepare('SELECT * FROM delivery_jobs WHERE status = ? ORDER BY created_at').all(status) : this.db.prepare('SELECT * FROM delivery_jobs ORDER BY created_at').all();
    return rows.map((row) => this.getDeliveryJob(stringValue(row.idempotency_key))!).filter(Boolean);
  }

  listResourceDeliveryJobs(status?: DeliveryStatus): ResourceDeliveryJob[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM resource_delivery_jobs WHERE status = ? ORDER BY created_at, id').all(status)
      : this.db.prepare('SELECT * FROM resource_delivery_jobs ORDER BY created_at, id').all();
    return rows.map((row) => ({
      id: stringValue(row.id), resourceType: stringValue(row.resource_type) as ResourceDeliveryType, resourceId: stringValue(row.resource_id), resourceVersion: numberValue(row.resource_version),
      target: stringValue(row.target, 'merchant_database') as SyncTarget,
      approvalStatus: stringValue(row.approval_status, 'approved') as 'awaiting_approval' | 'approved',
      status: stringValue(row.status, 'queued') as DeliveryStatus, idempotencyKey: stringValue(row.idempotency_key), payload: parseJson<unknown>(row.payload_json, null),
      attemptCount: numberValue(row.attempt_count), lastError: row.last_error === null || row.last_error === undefined ? null : stringValue(row.last_error), createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at),
    }));
  }

  createManualSyncJobs(input: { resourceType: ResourceDeliveryType; resourceId: string; resourceVersion: number; payload: unknown; targets: Exclude<SyncTarget, 'local'>[]; actorId: string; now?: number }): ResourceDeliveryJob[] {
    if (!input.targets.length) return [];
    const now = input.now ?? Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const jobs: ResourceDeliveryJob[] = [];
      for (const target of [...new Set(input.targets)]) {
        const idempotencyKey = `${input.resourceType}:${input.resourceId}:${input.resourceVersion}:${target}`;
        this.db.prepare("UPDATE resource_delivery_jobs SET status = 'superseded', updated_at = ? WHERE resource_type = ? AND resource_id = ? AND resource_version < ? AND target = ? AND status IN ('queued', 'uploading', 'failed')").run(now, input.resourceType, input.resourceId, input.resourceVersion, target);
        this.db.prepare('INSERT INTO resource_delivery_jobs (id, resource_type, resource_id, resource_version, target, approval_status, idempotency_key, payload_json, status, attempt_count, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING').run(`resource-delivery-${randomUUID()}`, input.resourceType, input.resourceId, input.resourceVersion, target, 'approved', idempotencyKey, json(input.payload), 'queued', now, now);
        jobs.push(this.listResourceDeliveryJobs().find((job) => job.idempotencyKey === idempotencyKey)!);
      }
      this.db.exec('COMMIT');
      void input.actorId;
      return jobs;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  listPendingResourceApprovals(): ResourceDeliveryJob[] {
    return this.listResourceDeliveryJobs().filter((job) => job.approvalStatus === 'awaiting_approval');
  }

  updateResourceDeliveryJob(idempotencyKey: string, status: DeliveryStatus, error?: string | null, now = Date.now()): ResourceDeliveryJob {
    this.db.prepare('UPDATE resource_delivery_jobs SET status = ?, attempt_count = attempt_count + CASE WHEN ? IN (\'uploading\', \'failed\') THEN 1 ELSE 0 END, last_error = ?, updated_at = ? WHERE idempotency_key = ?').run(status, status, error ?? null, now, idempotencyKey);
    const job = this.listResourceDeliveryJobs().find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (!job) throw new Error('资源同步任务不存在');
    return job;
  }

  updateDeliveryJob(idempotencyKey: string, status: DeliveryStatus, error?: string | null, now = Date.now()): DeliveryJob {
    this.db.prepare('UPDATE delivery_jobs SET status = ?, attempt_count = attempt_count + CASE WHEN ? IN (\'uploading\', \'failed\') THEN 1 ELSE 0 END, last_error = ?, updated_at = ? WHERE idempotency_key = ?').run(status, status, error ?? null, now, idempotencyKey);
    const job = this.getDeliveryJob(idempotencyKey);
    if (!job) throw new Error('上传任务不存在');
    this.updateReview(job.sessionId, { delivery: status }, now);
    return job;
  }

  settleDeliveryJob(idempotencyKey: string, outcome: 'synced' | 'failed', error?: string | null, now = Date.now()): DeliveryJob {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM delivery_jobs WHERE idempotency_key = ?').get(idempotencyKey);
      if (!row) throw new Error('上传任务不存在');
      const sessionId = stringValue(row.session_id);
      const revision = numberValue(row.content_revision);
      const session = this.getSessionStatement.get(sessionId);
      const review = this.db.prepare('SELECT * FROM session_reviews WHERE session_id = ?').get(sessionId);
      const remainsCurrent = stringValue(row.status) === 'uploading'
        && session
        && review
        && numberValue(session.content_revision) === revision
        && stringValue(review.approval) === 'approved'
        && numberValue(review.approved_revision, -1) === revision;
      if (remainsCurrent) {
        this.db.prepare('UPDATE delivery_jobs SET status = ?, attempt_count = attempt_count + CASE WHEN ? = \'failed\' THEN 1 ELSE 0 END, last_error = ?, updated_at = ? WHERE idempotency_key = ?').run(outcome, outcome, error ?? null, now, idempotencyKey);
        this.db.prepare('UPDATE session_reviews SET delivery = ?, updated_at = ? WHERE session_id = ?').run(outcome, now, sessionId);
      } else if (stringValue(row.status) === 'uploading') {
        this.db.prepare("UPDATE delivery_jobs SET status = 'superseded', last_error = NULL, updated_at = ? WHERE idempotency_key = ?").run(now, idempotencyKey);
      }
      this.db.exec('COMMIT');
      return this.getDeliveryJob(idempotencyKey)!;
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw cause;
    }
  }

  private appendInsideTransaction(sessionId: string, draft: SessionEventDraft): LiveEvent {
    const row = this.getSessionStatement.get(sessionId);
    if (!row) throw new Error('直播场次不存在');
    const sequence = numberValue(row.latest_sequence) + 1;
    const event: LiveEvent = { sessionId, sequence, type: draft.type, occurredAt: draft.occurredAt, payload: draft.payload };
    this.db.prepare('INSERT INTO session_events (id, session_id, sequence, type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)').run(`event-${randomUUID()}`, sessionId, sequence, draft.type, draft.occurredAt, json(draft.payload));
    const next = this.project(row, event);
    this.persistSessionProjection(sessionId, next, event, row.ended_at);
    this.projectNormalizedTables(sessionId, event);
    return event;
  }

  private enqueueResourceDeliveryInside(resourceType: ResourceDeliveryType, resourceId: string, resourceVersion: number, payload: unknown, now: number): void {
    const idempotencyKey = `${resourceType}:${resourceId}:${resourceVersion}`;
    this.db.prepare("UPDATE resource_delivery_jobs SET status = 'superseded', updated_at = ? WHERE resource_type = ? AND resource_id = ? AND resource_version < ? AND status IN ('queued', 'uploading', 'failed')").run(now, resourceType, resourceId, resourceVersion);
    this.db.prepare('INSERT INTO resource_delivery_jobs (id, resource_type, resource_id, resource_version, target, approval_status, idempotency_key, payload_json, status, attempt_count, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING').run(`resource-delivery-${randomUUID()}`, resourceType, resourceId, resourceVersion, 'merchant_database', 'awaiting_approval', idempotencyKey, json(payload), 'queued', now, now);
  }

  private persistSessionProjection(sessionId: string, next: LiveSessionSnapshot, event: LiveEvent, previousEndedAt: unknown): void {
    const endedAt = next.lifecycle === 'ended'
      ? event.occurredAt
      : previousEndedAt === null || previousEndedAt === undefined ? null : numberValue(previousEndedAt);
    this.db.prepare('UPDATE live_sessions SET presenter_id = ?, presenter_name = ? WHERE id = ?').run(next.presenterId, next.presenterName, sessionId);
    this.db.prepare('UPDATE live_sessions SET lifecycle = ?, product_json = ?, lineup_json = ?, partial_transcript = ?, transcript_json = ?, latest_compliance_json = ?, alerts_json = ?, coach_json = ?, coach_pending = ?, risk_profile = ?, stats_json = ?, content_revision = ?, latest_sequence = ?, updated_at = ?, ended_at = ? WHERE id = ?').run(
      next.lifecycle, json(next.product), json(next.lineup), next.partialTranscript, json(next.transcriptHistory), next.latestCompliance ? json(next.latestCompliance) : null, json(next.alerts), json(next.coachSuggestions), next.coachPending ? 1 : 0, next.riskProfile, json(next.stats), next.contentRevision, event.sequence, event.occurredAt, endedAt, sessionId,
    );
  }

  private revokeReviewInside(sessionId: string, now: number, note?: string): void {
    const current = this.db.prepare('SELECT * FROM session_reviews WHERE session_id = ?').get(sessionId);
    if (!current) throw new Error('复核记录不存在');
    const delivery = stringValue(current.delivery, 'not_queued');
    const nextDelivery = delivery === 'queued' || delivery === 'uploading' ? 'superseded' : delivery;
    this.db.prepare('UPDATE session_reviews SET note = ?, approval = ?, approved_revision = NULL, approved_by = NULL, approved_at = NULL, delivery = ?, updated_at = ? WHERE session_id = ?').run(note ?? stringValue(current.note), 'approval_required', nextDelivery, now, sessionId);
  }

  private project(row: SqlRow, event: LiveEvent): LiveSessionSnapshot {
    const snapshot = this.snapshotFromRow(row);
    const payload = event.payload;
    switch (event.type) {
      case 'lifecycle.changed': {
        snapshot.lifecycle = (payload.lifecycle as LiveLifecycle) ?? snapshot.lifecycle;
        if (snapshot.lifecycle === 'ended') snapshot.partialTranscript = '';
        break;
      }
      case 'product.selected': {
        const product = parseJson<Product | null>(payload.product, null);
        if (product) {
          snapshot.product = product;
          // Results and prompts are scoped to the active product. Clearing them
          // here prevents a delayed model response from appearing under a new SKU.
          snapshot.latestCompliance = null;
          snapshot.coachSuggestions = [];
          snapshot.coachPending = false;
        }
        break;
      }
      case 'lineup.updated': {
        const lineup = parseJson<Product[]>(payload.lineup, []);
        if (lineup.length) {
          snapshot.lineup = lineup;
          snapshot.product = lineup.find((product) => product.id === snapshot.product.id) ?? snapshot.product;
          snapshot.latestCompliance = null;
          snapshot.coachSuggestions = [];
          snapshot.coachPending = false;
        }
        break;
      }
      case 'risk_profile.changed':
        if (payload.profile === 'strict' || payload.profile === 'balanced' || payload.profile === 'optimized') snapshot.riskProfile = payload.profile;
        break;
      case 'presenter.selected':
        snapshot.presenterId = stringValue(payload.presenterId, snapshot.presenterId);
        snapshot.presenterName = stringValue(payload.presenterName, snapshot.presenterName);
        break;
      case 'transcript.partial':
        snapshot.partialTranscript = stringValue(payload.text);
        break;
      case 'transcript.final': {
        const segment = parseJson<TranscriptSegment | null>(payload.segment, null);
        if (segment) {
          snapshot.partialTranscript = '';
          snapshot.transcriptHistory = [...snapshot.transcriptHistory.filter((candidate) => candidate.id !== segment.id), segment].slice(-80);
          snapshot.stats.words += segment.text.replace(/\s/g, '').length;
          const offset = segment.endOffsetMs ?? segment.offsetMs;
          if (offset !== null && offset !== undefined) snapshot.stats.speakingSeconds = Math.max(snapshot.stats.speakingSeconds, Math.round(offset / 1_000));
          this.db.prepare('INSERT INTO transcript_projections (session_id, segment_id, revision, segment_json, original_text, note) VALUES (?, ?, 0, ?, ?, \'\') ON CONFLICT(session_id, segment_id) DO UPDATE SET segment_json=excluded.segment_json').run(event.sessionId, segment.id, json(segment), segment.text);
        }
        break;
      }
      case 'transcript.corrected': {
        const segmentId = stringValue(payload.segmentId);
        const text = stringValue(payload.text);
        snapshot.transcriptHistory = snapshot.transcriptHistory.map((segment) => segment.id === segmentId ? { ...segment, text } : segment);
        snapshot.contentRevision += 1;
        break;
      }
      case 'speaker.assigned': {
        const segmentId = stringValue(payload.segmentId);
        const segmentIds = Array.isArray(payload.segmentIds) ? payload.segmentIds.filter((value): value is string => typeof value === 'string') : [segmentId];
        const speaker = payload.speaker === 'other' ? 'other' : 'host';
        snapshot.transcriptHistory = snapshot.transcriptHistory.map((segment) => segmentIds.includes(segment.id) ? { ...segment, speaker, speakerSource: 'manual', speakerConfidence: 1 } : segment);
        snapshot.contentRevision += 1;
        break;
      }
      case 'compliance.updated': {
        const result = parseJson<ComplianceResult | null>(payload.result, null);
        if (result) {
          const previousRow = result.segmentId ? this.db.prepare('SELECT result_json FROM compliance_projections WHERE session_id = ? AND segment_id = ?').get(event.sessionId, result.segmentId) : undefined;
          const previous = parseJson<ComplianceResult | null>(previousRow?.result_json, null);
          if (previous) snapshot.stats[`${previous.risk}Count` as 'safeCount' | 'warningCount' | 'blockedCount'] = Math.max(0, snapshot.stats[`${previous.risk}Count` as 'safeCount' | 'warningCount' | 'blockedCount'] - 1);
          if (payload.latest !== false) snapshot.latestCompliance = result;
          snapshot.alerts = snapshot.alerts.filter((alert) => alert.segmentId !== result.segmentId);
          if (result.risk !== 'safe') snapshot.alerts = [result, ...snapshot.alerts].slice(0, 20);
          snapshot.stats[`${result.risk}Count` as 'safeCount' | 'warningCount' | 'blockedCount'] += 1;
        }
        break;
      }
      case 'coach.updated': {
        snapshot.coachSuggestions = parseJson<CoachSuggestion[]>(payload.suggestions, []);
        snapshot.coachPending = boolValue(payload.pending);
        break;
      }
      case 'capture.error':
        snapshot.lifecycle = 'paused';
        snapshot.partialTranscript = '';
        break;
      case 'session.created':
      case 'session.ended':
        break;
    }
    snapshot.latestSequence = event.sequence;
    snapshot.updatedAt = event.occurredAt;
    return snapshot;
  }

  private projectNormalizedTables(sessionId: string, event: LiveEvent, revokeReview = true): void {
    if (event.type === 'transcript.corrected' || event.type === 'speaker.assigned') {
      const targetId = stringValue(event.payload.segmentId);
      const segmentIds = event.type === 'speaker.assigned' && Array.isArray(event.payload.segmentIds)
        ? event.payload.segmentIds.filter((value): value is string => typeof value === 'string')
        : [targetId];
      for (const segmentId of segmentIds) {
        const row = this.db.prepare('SELECT * FROM transcript_projections WHERE session_id = ? AND segment_id = ?').get(sessionId, segmentId);
        if (!row) continue;
        const segment = parseJson<TranscriptSegment>(row.segment_json, {} as TranscriptSegment);
        const updated: TranscriptSegment = event.type === 'transcript.corrected'
          ? { ...segment, text: stringValue(event.payload.text, segment.text) }
          : { ...segment, speaker: event.payload.speaker === 'other' ? 'other' : 'host', speakerSource: 'manual', speakerConfidence: 1, ...(typeof event.payload.speakerId === 'string' ? { speakerId: event.payload.speakerId } : {}) };
        this.db.prepare('UPDATE transcript_projections SET revision = revision + 1, segment_json = ? WHERE session_id = ? AND segment_id = ?').run(json(updated), sessionId, segmentId);
      }
      if (revokeReview) this.revokeReviewInside(sessionId, event.occurredAt);
    }
    if (event.type === 'compliance.updated') {
      const result = parseJson<ComplianceResult | null>(event.payload.result, null);
      if (result?.segmentId) {
        this.db.prepare('INSERT INTO compliance_projections (session_id, segment_id, result_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, segment_id) DO UPDATE SET result_json=excluded.result_json, updated_at=excluded.updated_at').run(sessionId, result.segmentId, json(result), event.occurredAt);
        if (result.risk !== 'safe') {
          const session = this.getSessionStatement.get(sessionId);
          const lineup = parseJson<Product[]>(session?.lineup_json, []);
          const active = parseJson<Product | null>(session?.product_json, null);
          const eventProduct = parseJson<Product | null>(event.payload.product, null);
          const product = (eventProduct?.id === result.productId ? eventProduct : null) ?? lineup.find((candidate) => candidate.id === result.productId) ?? (active?.id === result.productId ? active : null);
          this.db.prepare(`
            INSERT INTO compliance_findings (id, session_id, room_id, segment_id, product_id, product_name, product_json, result_json, disposition, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            ON CONFLICT(session_id, segment_id) DO UPDATE SET
              product_json = COALESCE(compliance_findings.product_json, excluded.product_json),
              result_json = excluded.result_json,
              updated_at = excluded.updated_at
          `).run(`finding-${sessionId}-${result.segmentId}`, sessionId, stringValue(session?.room_id), result.segmentId, result.productId, product?.name ?? result.productId, product ? json(product) : null, json(result), event.occurredAt, event.occurredAt);
        }
      }
    }
    if (event.type === 'coach.updated') {
      const segmentId = stringValue(event.payload.segmentId, 'latest');
      this.db.prepare('INSERT INTO coach_projections (session_id, segment_id, suggestions_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, segment_id) DO UPDATE SET suggestions_json=excluded.suggestions_json, updated_at=excluded.updated_at').run(sessionId, segmentId, json(parseJson<CoachSuggestion[]>(event.payload.suggestions, [])), event.occurredAt);
    }
  }

  private snapshotFromRow(row: SqlRow): LiveSessionSnapshot {
    return {
      sessionId: stringValue(row.id), tenantId: stringValue(row.tenant_id), roomId: stringValue(row.room_id),
      presenterId: stringValue(row.presenter_id), presenterName: stringValue(row.presenter_name), lifecycle: stringValue(row.lifecycle, 'idle') as LiveLifecycle,
      product: parseJson<Product>(row.product_json, {} as Product), lineup: parseJson<Product[]>(row.lineup_json, []), partialTranscript: stringValue(row.partial_transcript),
      transcriptHistory: parseJson<TranscriptSegment[]>(row.transcript_json, []), latestCompliance: parseJson<ComplianceResult | null>(row.latest_compliance_json, null), alerts: parseJson<ComplianceResult[]>(row.alerts_json, []),
      coachSuggestions: parseJson<CoachSuggestion[]>(row.coach_json, []), coachPending: boolValue(row.coach_pending), riskProfile: stringValue(row.risk_profile, 'strict') as RiskProfile,
      stats: parseJson<SessionStats>(row.stats_json, emptyStats()), contentRevision: numberValue(row.content_revision), latestSequence: numberValue(row.latest_sequence), createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at),
    };
  }

  private complianceFindingFromRow(row: SqlRow): ComplianceFinding {
    return {
      id: stringValue(row.id), sessionId: stringValue(row.session_id), roomId: stringValue(row.room_id), segmentId: stringValue(row.segment_id), productId: stringValue(row.product_id), productName: stringValue(row.product_name),
      ...(row.product_json ? { product: parseJson<Product>(row.product_json, {} as Product) } : {}),
      result: parseJson<ComplianceResult>(row.result_json, {} as ComplianceResult), disposition: stringValue(row.disposition, 'pending') as ComplianceFindingDisposition,
      ...(row.rule_id ? { ruleId: stringValue(row.rule_id) } : {}), ...(row.disposed_by ? { disposedBy: stringValue(row.disposed_by) } : {}), ...(row.disposed_at ? { disposedAt: numberValue(row.disposed_at) } : {}), ...(row.resolution_note ? { resolutionNote: stringValue(row.resolution_note) } : {}),
      createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at),
    };
  }

  private summaryFromRow(row: SqlRow): SessionSummary {
    const snapshot = this.snapshotFromRow(row);
    const review = this.db.prepare('SELECT * FROM session_reviews WHERE session_id = ?').get(snapshot.sessionId);
    const audio = this.listAudioAssets(snapshot.sessionId)[0];
    return {
      sessionId: snapshot.sessionId, tenantId: snapshot.tenantId, roomId: snapshot.roomId, presenterId: snapshot.presenterId, presenterName: snapshot.presenterName,
      lifecycle: snapshot.lifecycle, createdAt: snapshot.createdAt, endedAt: row.ended_at === null || row.ended_at === undefined ? null : numberValue(row.ended_at), contentRevision: snapshot.contentRevision,
      approval: stringValue(review?.approval, 'approval_required') as ReviewApproval, delivery: stringValue(review?.delivery, 'not_queued') as DeliveryStatus,
      transcriptCount: snapshot.transcriptHistory.length, audioDurationMs: audio?.durationMs ?? 0, audioBytes: audio?.byteLength ?? 0, note: stringValue(review?.note),
    };
  }

  private transcriptsForSession(sessionId: string): TranscriptSegment[] {
    const rows = this.db.prepare('SELECT segment_json FROM transcript_projections WHERE session_id = ? ORDER BY json_extract(segment_json, \'$.timestamp\')').all(sessionId);
    return rows.map((row) => parseJson<TranscriptSegment>(row.segment_json, {} as TranscriptSegment));
  }
}
