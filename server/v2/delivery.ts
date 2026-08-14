import type { ResourceDeliveryJob, SessionReview } from '../../src/shared/v2';
import type { SyncTarget } from '../../src/shared/types';
import { BoundedScheduler } from './scheduler';
import { SqliteFactStore } from './store';

export type DeliveryGateway = {
  readonly configured: boolean;
  readonly targets?: SyncTarget[];
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
          this.store.settleDeliveryJob(idempotencyKey, 'synced');
        } catch (error) {
          this.store.settleDeliveryJob(idempotencyKey, 'failed', error instanceof Error ? error.message : String(error));
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
          const target = job.target ?? 'merchant_database';
          const targetGateways = gateways.filter((gateway) => !gateway.targets || gateway.targets.includes(target));
          if (targetGateways.length === 0) throw new Error(`没有配置 ${target} 交付适配器`);
          for (const gateway of targetGateways) await gateway.deliverResource!(job);
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
  // Cloud adapters are intentionally not wired in v0.3. Sending a Mac-local
  // path to a remote HTTP endpoint would create a false successful delivery.
  void env;
  return [];
}
