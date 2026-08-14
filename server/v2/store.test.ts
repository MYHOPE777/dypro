import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT } from '../../src/shared/products';
import type { LiveEventType } from '../../src/shared/v2';
import { SqliteFactStore } from './store';

describe('SqliteFactStore', () => {
  const stores: SqliteFactStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((store) => store.close());
  });

  it('commits an event and its session projection together', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    stores.push(store);
    const sessionId = 'session-test-1';
    store.createSession({
      sessionId,
      tenantId: 'tenant-local',
      roomId: 'room-default',
      presenterId: 'presenter-default',
      presenterName: '测试主播',
      product: DEFAULT_PRODUCT,
      lineup: [DEFAULT_PRODUCT],
    });

    const event = store.appendSessionEvent(sessionId, {
      type: 'lifecycle.changed' satisfies LiveEventType,
      occurredAt: 100,
      payload: { lifecycle: 'live' },
    });

    expect(event.sequence).toBe(2);
    expect(store.listSessionEvents(sessionId)).toHaveLength(2);
    expect(store.getSessionSnapshot(sessionId)?.lifecycle).toBe('live');
    expect(store.getSessionSnapshot(sessionId)?.latestSequence).toBe(2);
  });

  it('rebuilds resolved transcript annotations from the append-only event stream', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    stores.push(store);
    const sessionId = 'session-annotation-rebuild';
    store.createSession({ sessionId, tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '测试主播', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT] });
    store.appendSessionEvent(sessionId, { type: 'transcript.final', occurredAt: 2, payload: { segment: JSON.stringify({ id: 'segment-annotation', text: '一定能治好', isFinal: true, timestamp: 2, speaker: 'host', productId: DEFAULT_PRODUCT.id }) } });
    const annotation = { id: 'annotation-rebuild', sessionId, segmentId: 'segment-annotation', selectedText: '一定能治好', start: 0, end: 5, kind: 'sentence', risk: 'blocked', title: '违规句', reason: '测试', alternative: '安全表达', policyRef: '测试规则', confidence: 1, status: 'pending', actorId: 'operator-a', createdAt: 3, updatedAt: 3 };
    const result = { id: 'finding-rebuild', segmentId: 'segment-annotation:annotation:annotation-rebuild', transcriptSegmentId: 'segment-annotation', annotationId: annotation.id, productId: DEFAULT_PRODUCT.id, risk: 'blocked', title: '违规句', reason: '测试', alternative: '安全表达', policyRef: '测试规则', confidence: 1, source: 'manual', transcript: '一定能治好', matchedTerms: ['一定能治好'], ruleKind: 'sentence', createdAt: 3 };
    store.appendSessionEvent(sessionId, { type: 'compliance.updated', occurredAt: 3, payload: { result: JSON.stringify(result), annotation: JSON.stringify(annotation), product: JSON.stringify(DEFAULT_PRODUCT), latest: false } });
    store.resolveComplianceFinding(sessionId, result.segmentId, 'confirmed', 'operator-a', 'rule-local', '已确认', 4);

    expect(store.getSessionSnapshot(sessionId)?.transcriptAnnotations).toMatchObject([{ id: annotation.id, status: 'confirmed', ruleId: 'rule-local' }]);
    store.rebuildSessionProjections(sessionId);
    expect(store.getSessionSnapshot(sessionId)?.transcriptAnnotations).toMatchObject([{ id: annotation.id, status: 'confirmed', ruleId: 'rule-local' }]);
  });

  it('keeps a manually assigned speaker id in the live snapshot projection', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    stores.push(store);
    const sessionId = 'session-speaker-projection';
    store.createSession({ sessionId, tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '测试主播', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT] });
    store.appendSessionEvent(sessionId, { type: 'transcript.final', occurredAt: 2, payload: { segment: JSON.stringify({ id: 'segment-speaker', text: '助理介绍', isFinal: true, timestamp: 2, speaker: 'host' }) } });
    store.appendSessionEvent(sessionId, { type: 'speaker.assigned', occurredAt: 3, payload: { segmentId: 'segment-speaker', segmentIds: ['segment-speaker'], speaker: 'other', speakerId: 'speaker-assistant', speakerName: '助理小王' } });
    expect(store.getSessionSnapshot(sessionId)?.transcriptHistory[0]).toMatchObject({ speaker: 'other', speakerId: 'speaker-assistant', speakerName: '助理小王' });
  });

  it('uses strict risk for new sessions while preserving ended-session audit history', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    stores.push(store);
    const sessionId = 'session-strict-risk';
    store.createSession({
      sessionId,
      tenantId: 'tenant-local',
      roomId: 'room-default',
      presenterId: 'presenter-default',
      presenterName: '测试主播',
      product: DEFAULT_PRODUCT,
      lineup: [DEFAULT_PRODUCT],
    });

    expect(store.getSessionSnapshot(sessionId)?.riskProfile).toBe('strict');
    store.appendSessionEvent(sessionId, { type: 'risk_profile.changed', occurredAt: 2, payload: { profile: 'strict' } });
    expect(store.getSessionSnapshot(sessionId)?.riskProfile).toBe('strict');

    store.appendSessionEvent(sessionId, { type: 'risk_profile.changed', occurredAt: 3, payload: { profile: 'optimized' } });
    store.appendSessionEvent(sessionId, { type: 'lifecycle.changed', occurredAt: 4, payload: { lifecycle: 'ended' } });
    expect(store.getSessionSnapshot(sessionId)?.riskProfile).toBe('optimized');
  });

  it('reopens a file database with the same ordered event stream', () => {
    const filename = `${process.env.TMPDIR ?? '/tmp'}/dypro-v2-store-${Date.now()}.sqlite`;
    const first = new SqliteFactStore({ filename });
    first.createSession({
      sessionId: 'session-reopen',
      tenantId: 'tenant-local',
      roomId: 'room-default',
      presenterId: 'presenter-default',
      presenterName: '测试主播',
      product: DEFAULT_PRODUCT,
      lineup: [DEFAULT_PRODUCT],
    });
    first.appendSessionEvent('session-reopen', { type: 'lifecycle.changed', occurredAt: 100, payload: { lifecycle: 'live' } });
    first.close();

    const second = new SqliteFactStore({ filename });
    stores.push(second);
    expect(second.listSessionEvents('session-reopen').map((event) => event.sequence)).toEqual([1, 2]);
    expect(second.getSessionSnapshot('session-reopen')?.lifecycle).toBe('live');
  });

  it('moves pre-manual-sync resource jobs into approval-required state during migration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-delivery-migration-'));
    const filename = join(directory, 'app.sqlite');
    const legacy = new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE resource_delivery_jobs (
      id TEXT PRIMARY KEY, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
      resource_version INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    legacy.prepare('INSERT INTO resource_delivery_jobs (id, resource_type, resource_id, resource_version, idempotency_key, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-job', 'rule', 'legacy-rule', 1, 'rule:legacy-rule:1:merchant_database', '{}', 'queued', 1, 1);
    legacy.close();
    const store = new SqliteFactStore({ filename });
    stores.push(store);
    expect(store.listResourceDeliveryJobs('queued')).toMatchObject([{ approvalStatus: 'awaiting_approval', target: 'merchant_database' }]);
    const reproved = store.createManualSyncJobs({ resourceType: 'rule', resourceId: 'legacy-rule', resourceVersion: 1, payload: { roomId: 'room-default' }, targets: ['merchant_database'], actorId: 'operator', now: 2 });
    expect(reproved[0]).toMatchObject({ approvalStatus: 'approved', approvedBy: 'operator', approvedAt: 2, status: 'queued' });
    rmSync(directory, { recursive: true, force: true });
  });

  it('demotes jobs from the short-lived approved-default migration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-delivery-approval-default-'));
    const filename = join(directory, 'app.sqlite');
    const legacy = new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE resource_delivery_jobs (
      id TEXT PRIMARY KEY, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
      resource_version INTEGER NOT NULL, target TEXT NOT NULL DEFAULT 'merchant_database',
      approval_status TEXT NOT NULL DEFAULT 'approved', idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    legacy.prepare('INSERT INTO resource_delivery_jobs (id, resource_type, resource_id, resource_version, idempotency_key, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('approved-default-job', 'rule', 'legacy-rule', 1, 'rule:legacy-rule:1:merchant_database', '{}', 'queued', 1, 1);
    legacy.close();
    const store = new SqliteFactStore({ filename });
    stores.push(store);
    expect(store.listResourceDeliveryJobs('queued')[0]?.approvalStatus).toBe('awaiting_approval');
    rmSync(directory, { recursive: true, force: true });
  });

  it('reuses an active presenter link and resolves it to the original session', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    stores.push(store);
    store.createSession({
      sessionId: 'session-display-link',
      tenantId: 'tenant-local',
      roomId: 'room-default',
      presenterId: 'presenter-default',
      presenterName: '测试主播',
      product: DEFAULT_PRODUCT,
      lineup: [DEFAULT_PRODUCT],
    });

    const first = store.getOrCreateDisplayLink('session-display-link', 1_000, 10_000);
    const second = store.getOrCreateDisplayLink('session-display-link', 2_000, 10_000);

    expect(second).toEqual(first);
    expect(store.resolveDisplayLink(first.alias.toLowerCase(), 5_000)).toBe('session-display-link');
  });

  it('rejects an expired presenter link and replaces it with a fresh alias', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    stores.push(store);
    store.createSession({
      sessionId: 'session-expired-link',
      tenantId: 'tenant-local',
      roomId: 'room-default',
      presenterId: 'presenter-default',
      presenterName: '测试主播',
      product: DEFAULT_PRODUCT,
      lineup: [DEFAULT_PRODUCT],
    });

    const expired = store.getOrCreateDisplayLink('session-expired-link', 1_000, 1_000);
    expect(store.resolveDisplayLink(expired.alias, 2_001)).toBeNull();

    const replacement = store.getOrCreateDisplayLink('session-expired-link', 2_001, 1_000);
    expect(replacement.alias).not.toBe(expired.alias);
    expect(store.resolveDisplayLink(expired.alias, 2_001)).toBeNull();
    expect(store.resolveDisplayLink(replacement.alias, 2_001)).toBe('session-expired-link');
  });

  it('rebuilds damaged session and transcript projections from the event stream', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dypro-projection-rebuild-'));
    const filename = join(directory, 'app.sqlite');
    const first = new SqliteFactStore({ filename });
    first.createSession({
      sessionId: 'session-rebuild',
      tenantId: 'tenant-local',
      roomId: 'room-default',
      presenterId: 'presenter-default',
      presenterName: '测试主播',
      product: DEFAULT_PRODUCT,
      lineup: [DEFAULT_PRODUCT],
      createdAt: 1,
    });
    first.appendSessionEvent('session-rebuild', { type: 'lifecycle.changed', occurredAt: 2, payload: { lifecycle: 'live' } });
    first.appendSessionEvent('session-rebuild', {
      type: 'transcript.final',
      occurredAt: 3,
      payload: { segment: JSON.stringify({ id: 'segment-rebuild', text: '需要恢复的主播话术', isFinal: true, timestamp: 3, offsetMs: 2_000, startOffsetMs: 1_000, endOffsetMs: 2_000, speaker: 'host' }) },
    });
    first.close();

    const damage = new DatabaseSync(filename);
    damage.exec("UPDATE live_sessions SET lifecycle = 'idle', transcript_json = '[]', stats_json = '{}', latest_sequence = 0; DELETE FROM transcript_projections;");
    damage.close();

    const second = new SqliteFactStore({ filename });
    stores.push(second);
    const rebuilt = second.rebuildSessionProjections('session-rebuild');

    expect(rebuilt.lifecycle).toBe('live');
    expect(rebuilt.latestSequence).toBe(3);
    expect(rebuilt.transcriptHistory.map((segment) => segment.text)).toEqual(['需要恢复的主播话术']);
    expect(second.getSessionReview('session-rebuild')?.transcripts.map((segment) => segment.text)).toEqual(['需要恢复的主播话术']);
    rmSync(directory, { recursive: true, force: true });
  });

  it('preserves manual review edits and approval while rebuilding projections', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    stores.push(store);
    store.createSession({ sessionId: 'session-reviewed-rebuild', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '测试主播', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT], createdAt: 1 });
    store.appendSessionEvent('session-reviewed-rebuild', {
      type: 'transcript.final',
      occurredAt: 2,
      payload: { segment: JSON.stringify({ id: 'reviewed-segment', text: '原始话术', isFinal: true, timestamp: 2, offsetMs: 1_000, startOffsetMs: 0, endOffsetMs: 1_000, speaker: 'host' }) },
    });
    store.appendSessionEvent('session-reviewed-rebuild', { type: 'lifecycle.changed', occurredAt: 3, payload: { lifecycle: 'ended' } });
    const original = store.getSessionReview('session-reviewed-rebuild')!.transcripts[0];
    store.editReviewTranscript('session-reviewed-rebuild', original.id, { ...original, text: '人工纠正后的话术' }, 'reviewer', 'transcript.corrected', 4);
    store.editReviewNote('session-reviewed-rebuild', '保留这条复盘备注', 'reviewer', 5);
    store.approveCurrentDelivery('session-reviewed-rebuild', 'reviewer', 6);

    store.rebuildSessionProjections('session-reviewed-rebuild');
    const review = store.getSessionReview('session-reviewed-rebuild')!;

    expect(review.transcripts[0].text).toBe('人工纠正后的话术');
    expect(review.summary.contentRevision).toBe(2);
    expect(review.summary.note).toBe('保留这条复盘备注');
    expect(review.approval).toBe('approved');
    expect(review.delivery).toBe('queued');
  });

  it('keeps unresolved compliance findings after newer results and records their disposition', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    stores.push(store);
    store.createSession({ sessionId: 'session-risk-inbox', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '测试主播', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT], createdAt: 1 });
    const blocked = { id: 'finding-old', segmentId: 'segment-old', productId: DEFAULT_PRODUCT.id, risk: 'blocked' as const, title: '医疗功效', reason: '包含治疗承诺', alternative: '只描述实际体验', policyRef: '广告合规', confidence: 0.98, source: 'doubao' as const, transcript: '这个可以治疗耳聋', matchedTerms: ['治疗耳聋'], ruleKind: 'term' as const, createdAt: 2 };
    store.appendSessionEvent('session-risk-inbox', { type: 'compliance.updated', occurredAt: 2, payload: { result: JSON.stringify(blocked), product: JSON.stringify(DEFAULT_PRODUCT), segmentId: blocked.segmentId, latest: true } });
    store.appendSessionEvent('session-risk-inbox', { type: 'compliance.updated', occurredAt: 3, payload: { result: JSON.stringify({ ...blocked, id: 'finding-new-safe', segmentId: 'segment-new', risk: 'safe', title: '当前安全', transcript: '正常介绍商品', matchedTerms: [] }), segmentId: 'segment-new', latest: true } });

    expect(store.listComplianceFindings('room-default', 'pending')).toContainEqual(expect.objectContaining({ sessionId: 'session-risk-inbox', segmentId: 'segment-old', productId: DEFAULT_PRODUCT.id, product: DEFAULT_PRODUCT, disposition: 'pending', result: expect.objectContaining({ transcript: blocked.transcript }) }));
    const resolved = store.resolveComplianceFinding('session-risk-inbox', 'segment-old', 'dismissed', 'operator-1', undefined, '确认属于误判', 4);
    expect(resolved).toMatchObject({ disposition: 'dismissed', disposedBy: 'operator-1', resolutionNote: '确认属于误判' });
    store.appendSessionEvent('session-risk-inbox', { type: 'compliance.updated', occurredAt: 5, payload: { result: JSON.stringify({ ...blocked, reason: '模型补充证据' }), segmentId: blocked.segmentId, latest: false } });
    store.rebuildSessionProjections('session-risk-inbox');
    expect(store.getComplianceFinding('session-risk-inbox', 'segment-old')).toMatchObject({ disposition: 'dismissed', resolutionNote: '确认属于误判', result: expect.objectContaining({ reason: '模型补充证据' }) });
    expect(store.listComplianceFindings('room-default', 'pending')).toEqual([]);
  });

  it('rebuilds manual transcript annotations and updates their review status', () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    stores.push(store);
    store.createSession({ sessionId: 'session-annotation', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '主播', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT], createdAt: 1 });
    const annotation = { id: 'annotation-1', sessionId: 'session-annotation', segmentId: 'segment-1', selectedText: '一定能治', start: 0, end: 4, kind: 'term' as const, risk: 'blocked' as const, title: '医疗功效', reason: '治疗承诺', alternative: '客观描述', policyRef: '直播规则', confidence: 1, status: 'pending' as const, actorId: 'reviewer', createdAt: 2, updatedAt: 2 };
    store.appendSessionEvent('session-annotation', { type: 'transcript.final', occurredAt: 2, payload: { segment: JSON.stringify({ id: 'segment-1', text: '一定能治喉咙痛', isFinal: true, timestamp: 2, offsetMs: null, startOffsetMs: null, endOffsetMs: null, speaker: 'host' }) } });
    const result = { id: annotation.id, segmentId: 'segment-1:annotation:annotation-1', transcriptSegmentId: 'segment-1', annotationId: annotation.id, productId: DEFAULT_PRODUCT.id, risk: 'blocked' as const, title: annotation.title, reason: annotation.reason, alternative: annotation.alternative, policyRef: annotation.policyRef, confidence: 1, source: 'manual' as const, transcript: '一定能治喉咙痛', matchedTerms: [annotation.selectedText], ruleKind: 'term' as const, createdAt: 3 };
    store.appendSessionEvent('session-annotation', { type: 'compliance.updated', occurredAt: 4, payload: { result: JSON.stringify(result), annotation: JSON.stringify(annotation), product: JSON.stringify(DEFAULT_PRODUCT), latest: false } });

    expect(store.getSessionSnapshot('session-annotation')?.transcriptAnnotations[0]).toMatchObject({ id: 'annotation-1', status: 'pending' });
    const resolved = store.resolveComplianceFinding('session-annotation', result.segmentId, 'dismissed', 'reviewer', undefined, '需要进一步确认', 5);
    expect(resolved.disposition).toBe('dismissed');
    expect(store.getSessionSnapshot('session-annotation')?.transcriptAnnotations[0]).toMatchObject({ status: 'dismissed' });
  });
});
