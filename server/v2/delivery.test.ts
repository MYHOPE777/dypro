import { describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT } from '../../src/shared/products';
import type { TranscriptSegment } from '../../src/shared/types';
import { BoundedScheduler } from './scheduler';
import { SessionReviewModule } from './sessionReview';
import { SqliteFactStore } from './store';
import { deliveryGatewaysFromEnv, DurableDelivery, type DeliveryGateway } from './delivery';
import { PresenterModule } from './presenters';
import { RuleModule } from './rules';

describe('DurableDelivery', () => {
  it('keeps cloud delivery as an explicit adapter port in v0.3', () => {
    expect(deliveryGatewaysFromEnv({ DATABASE_DELIVERY_URL: 'https://example.invalid/upload' })).toEqual([]);
  });
  it('delivers only an approved current revision and pauses during live capture', async () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    store.createSession({ sessionId: 'delivery-session', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '主播', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT] });
    store.appendSessionEvent('delivery-session', { type: 'lifecycle.changed', occurredAt: 2, payload: { lifecycle: 'ended' } });
    const review = new SessionReviewModule(store);
    review.approveDelivery('delivery-session', 'operator');
    const scheduler = new BoundedScheduler({ modelGlobal: 1, modelPerSession: 1, background: 1 });
    const delivered: string[] = [];
    const gateway: DeliveryGateway = { configured: true, deliver: async (payload) => { delivered.push(`${payload.summary.sessionId}:${payload.summary.contentRevision}`); } };
    const worker = new DurableDelivery(store, scheduler, [gateway]);
    scheduler.pauseBackground();
    expect(await worker.flushOnce()).toBe(0);
    expect(delivered).toEqual([]);
    scheduler.resumeBackground();
    expect(await worker.flushOnce()).toBe(1);
    expect(delivered).toEqual(['delivery-session:0']);
    expect(review.getReview('delivery-session')?.delivery).toBe('synced');
    store.close();
  });

  it('keeps jobs queued when no external gateway is configured', async () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    store.createSession({ sessionId: 'delivery-local', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '主播', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT] });
    store.appendSessionEvent('delivery-local', { type: 'lifecycle.changed', occurredAt: 2, payload: { lifecycle: 'ended' } });
    new SessionReviewModule(store).approveDelivery('delivery-local', 'operator');
    const worker = new DurableDelivery(store, new BoundedScheduler({ modelGlobal: 1, modelPerSession: 1, background: 1 }), []);
    expect(await worker.flushOnce()).toBe(0);
    expect(store.listDeliveryJobs('queued')).toHaveLength(1);
    store.close();
  });

  it('does not mark an obsolete revision synced when it is edited during upload', async () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    store.createSession({ sessionId: 'delivery-race', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '主播', product: DEFAULT_PRODUCT, lineup: [DEFAULT_PRODUCT] });
    const segment: TranscriptSegment = { id: 'segment-1', text: '原始文本', isFinal: true, timestamp: 10, offsetMs: 10, startOffsetMs: 0, endOffsetMs: 10, speaker: 'host' };
    store.appendSessionEvent('delivery-race', { type: 'transcript.final', occurredAt: 10, payload: { segment: JSON.stringify(segment) } });
    store.appendSessionEvent('delivery-race', { type: 'lifecycle.changed', occurredAt: 20, payload: { lifecycle: 'ended' } });
    const review = new SessionReviewModule(store);
    review.approveDelivery('delivery-race', 'reviewer');
    let finishUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => { finishUpload = resolve; });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gateway: DeliveryGateway = { configured: true, deliver: async () => { signalStarted(); await uploadStarted; } };
    const worker = new DurableDelivery(store, new BoundedScheduler({ modelGlobal: 1, modelPerSession: 1, background: 1 }), [gateway]);

    const flushing = worker.flushOnce();
    await started;
    review.correctTranscript('delivery-race', 'segment-1', '人工纠正文本', 'reviewer');
    finishUpload();
    await flushing;

    expect(store.getDeliveryJob('delivery-race:0')?.status).toBe('superseded');
    expect(review.getReview('delivery-race')).toMatchObject({ approval: 'approval_required', delivery: 'superseded', approvedRevision: null });
    store.close();
  });

  it('delivers versioned rules and presenter phrases only after manual target approval', async () => {
    const store = new SqliteFactStore({ filename: ':memory:' });
    store.ensureRoom({ id: 'room-default', tenantId: 'tenant-local' });
    const presenter = new PresenterModule(store, () => 10).ensureDefault('room-default');
    const rule = new RuleModule(store, () => 10).create('room-default', 'operator', { name: '明确禁词', pattern: '百分百有效', risk: 'blocked', title: '绝对承诺', reason: '不可证明的效果保证', alternative: '实际体验因人而异', policyRef: '广告合规' });
    const phrase = new PresenterModule(store, () => 11).savePhrase({ presenterId: presenter.id, productId: DEFAULT_PRODUCT.id, purpose: '塑品', text: '先介绍商品使用场景' });
    const scheduler = new BoundedScheduler({ modelGlobal: 1, modelPerSession: 1, background: 1 });
    const delivered: string[] = [];
    const gateway: DeliveryGateway = {
      configured: true,
      deliver: async () => undefined,
      deliverResource: async (job) => { delivered.push(`${job.resourceType}:${job.resourceId}:${job.resourceVersion}`); },
    };
    const worker = new DurableDelivery(store, scheduler, [gateway]);

    expect(store.listResourceDeliveryJobs('queued')).toHaveLength(0);
    store.createManualSyncJobs({ resourceType: 'rule', resourceId: rule.id, resourceVersion: rule.version, payload: rule, targets: ['merchant_database'], actorId: 'operator' });
    store.createManualSyncJobs({ resourceType: 'presenter_phrase', resourceId: phrase.id, resourceVersion: phrase.version, payload: phrase, targets: ['private_knowledge_base'], actorId: 'operator' });
    expect(store.listResourceDeliveryJobs('queued')).toHaveLength(2);
    scheduler.pauseBackground();
    expect(await worker.flushOnce()).toBe(0);
    scheduler.resumeBackground();
    expect(await worker.flushOnce()).toBe(1);
    expect(await worker.flushOnce()).toBe(1);

    expect(delivered.sort()).toEqual([`presenter_phrase:${phrase.id}:1`, `rule:${rule.id}:1`].sort());
    expect(store.listResourceDeliveryJobs('synced')).toHaveLength(2);
    store.close();
  });
});
