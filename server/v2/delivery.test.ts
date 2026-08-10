import { describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT } from '../../src/shared/products';
import { BoundedScheduler } from './scheduler';
import { SessionReviewModule } from './sessionReview';
import { SqliteFactStore } from './store';
import { DurableDelivery, type DeliveryGateway } from './delivery';
import { PresenterModule } from './presenters';
import { RuleModule } from './rules';

describe('DurableDelivery', () => {
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

  it('automatically delivers versioned rules and presenter phrases without session approval', async () => {
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

    expect(store.listResourceDeliveryJobs('queued')).toHaveLength(2);
    scheduler.pauseBackground();
    expect(await worker.flushOnce()).toBe(0);
    scheduler.resumeBackground();
    expect(await worker.flushOnce()).toBe(1);
    expect(await worker.flushOnce()).toBe(1);

    expect(delivered).toEqual([`rule:${rule.id}:1`, `presenter_phrase:${phrase.id}:1`]);
    expect(store.listResourceDeliveryJobs('synced')).toHaveLength(2);
    store.close();
  });
});
