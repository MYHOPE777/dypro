import type { ResourceDeliveryJob, SessionReview } from '../../src/shared/v2';
import { BoundedScheduler } from './scheduler';
import { SqliteFactStore } from './store';

export type DeliveryGateway = {
  readonly configured: boolean;
  deliver(review: SessionReview): Promise<void>;
  deliverResource?(job: ResourceDeliveryJob): Promise<void>;
};

export class DurableDelivery {
  private running = false;

  constructor(private readonly store: SqliteFactStore, private readonly scheduler: BoundedScheduler, private readonly gateways: DeliveryGateway[]) {}

  async flushOnce(): Promise<number> {
    if (this.running || this.scheduler.snapshot().background.paused || !this.gateways.some((gateway) => gateway.configured)) return 0;
    const sessionGateways = this.gateways.filter((gateway) => gateway.configured);
    const job = sessionGateways.length ? this.store.listDeliveryJobs('queued')[0] : undefined;
    if (job) {
      const review = this.store.getSessionReview(job.sessionId);
      if (!review || review.approval !== 'approved' || review.approvedRevision !== job.contentRevision || review.summary.contentRevision !== job.contentRevision) {
        this.store.updateDeliveryJob(job.idempotencyKey, 'superseded');
        return 0;
      }
      return this.runSessionJob(job.idempotencyKey, review, sessionGateways);
    }
    const resourceGateways = this.gateways.filter((gateway) => gateway.configured && gateway.deliverResource);
    const resourceJob = resourceGateways.length ? this.store.listResourceDeliveryJobs('queued')[0] : undefined;
    if (!resourceJob) return 0;
    return this.runResourceJob(resourceJob, resourceGateways);
  }

  private async runSessionJob(idempotencyKey: string, review: SessionReview, gateways: DeliveryGateway[]): Promise<number> {
    this.running = true;
    try {
      await this.scheduler.run('background', review.summary.sessionId, async () => {
        this.store.updateDeliveryJob(idempotencyKey, 'uploading');
        try {
          for (const gateway of gateways) await gateway.deliver(review);
          this.store.updateDeliveryJob(idempotencyKey, 'synced');
        } catch (error) {
          this.store.updateDeliveryJob(idempotencyKey, 'failed', error instanceof Error ? error.message : String(error));
        }
      });
      return 1;
    } finally {
      this.running = false;
    }
  }

  private async runResourceJob(job: ResourceDeliveryJob, gateways: DeliveryGateway[]): Promise<number> {
    this.running = true;
    try {
      await this.scheduler.run('background', `resource:${job.resourceId}`, async () => {
        this.store.updateResourceDeliveryJob(job.idempotencyKey, 'uploading');
        try {
          for (const gateway of gateways) await gateway.deliverResource!(job);
          const latest = this.store.listResourceDeliveryJobs().find((candidate) => candidate.idempotencyKey === job.idempotencyKey);
          this.store.updateResourceDeliveryJob(job.idempotencyKey, latest?.status === 'superseded' ? 'superseded' : 'synced');
        } catch (error) {
          this.store.updateResourceDeliveryJob(job.idempotencyKey, 'failed', error instanceof Error ? error.message : String(error));
        }
      });
      return 1;
    } finally {
      this.running = false;
    }
  }
}

export function deliveryGatewaysFromEnv(env: NodeJS.ProcessEnv = process.env): DeliveryGateway[] {
  const endpoints = [env.DATABASE_DELIVERY_URL, env.KNOWLEDGE_DELIVERY_URL].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return endpoints.map((endpoint) => ({
    configured: true,
    async deliver(review) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: review.summary.sessionId, contentRevision: review.summary.contentRevision, summary: review.summary, transcripts: review.transcripts, audio: review.audioPath ? { localPath: review.audioPath } : null }) });
      if (!response.ok) throw new Error(`上传网关返回 ${response.status}`);
    },
    async deliverResource(job) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deliveryType: 'resource', resourceType: job.resourceType, resourceId: job.resourceId, resourceVersion: job.resourceVersion, payload: job.payload }) });
      if (!response.ok) throw new Error(`资源同步网关返回 ${response.status}`);
    },
  }));
}
