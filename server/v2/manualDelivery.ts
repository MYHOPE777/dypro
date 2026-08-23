import type { ComplianceRule, PresenterPhrase, RuleUnit, SyncTarget } from '../../src/shared/types';
import type { ResourceDeliveryJob, ResourceDeliveryType } from '../../src/shared/v2';
import { SqliteFactStore } from './store';

type DeliveryTargets = Exclude<SyncTarget, 'local'>[];

export class ManualDeliveryModule {
  constructor(private readonly store: SqliteFactStore) {}

  getRule(ruleId: string): ComplianceRule | null { return this.store.getRule(ruleId); }
  getRuleUnit(unitId: string): { unit: RuleUnit; roomId?: string; package: NonNullable<ReturnType<SqliteFactStore['getRulePackage']>> } | null {
    const unit = this.store.getRuleUnit(unitId);
    if (!unit) return null;
    const packageValue = this.store.getRulePackage(unit.packageId);
    if (!packageValue) return null;
    return { unit, package: packageValue, ...(packageValue.roomId ? { roomId: packageValue.roomId } : {}) };
  }
  getPhrase(phraseId: string): PresenterPhrase | null { return this.store.getPhrase(phraseId); }

  syncRule(ruleId: string, targets: DeliveryTargets, actorId: string): ResourceDeliveryJob[] {
    const rule = this.getRule(ruleId);
    if (!rule) throw new Error('规则不存在');
    if (rule.status !== 'published' || !rule.enabled) throw new Error('只有已启用的本地规则才能同步');
    return this.create('rule', rule.id, rule.version, rule, targets, actorId);
  }

  syncRuleUnit(unitId: string, targets: DeliveryTargets, actorId: string): ResourceDeliveryJob[] {
    const resolved = this.getRuleUnit(unitId);
    if (!resolved) throw new Error('规则单元不存在');
    if (resolved.unit.status !== 'active' || !resolved.unit.enabled) throw new Error('只有已激活的规则单元才能同步');
    return this.create('rule_unit', resolved.unit.id, resolved.unit.version, { package: resolved.package, unit: resolved.unit }, targets, actorId);
  }

  syncPhrase(phraseId: string, targets: DeliveryTargets, actorId: string): ResourceDeliveryJob[] {
    const phrase = this.getPhrase(phraseId);
    if (!phrase) throw new Error('话术不存在');
    return this.create('presenter_phrase', phrase.id, phrase.version, phrase, targets, actorId);
  }

  listJobs(status: Parameters<SqliteFactStore['listResourceDeliveryJobs']>[0], allowedRooms?: Set<string>): ResourceDeliveryJob[] {
    const jobs = this.store.listResourceDeliveryJobs(status);
    if (!allowedRooms) return jobs;
    return jobs.filter((job) => {
      const roomId = this.resourceRoomId(job);
      return roomId !== undefined && allowedRooms.has(roomId);
    });
  }

  private create(resourceType: ResourceDeliveryType, resourceId: string, resourceVersion: number, payload: unknown, targets: DeliveryTargets, actorId: string): ResourceDeliveryJob[] {
    return this.store.createManualSyncJobs({ resourceType, resourceId, resourceVersion, payload, targets, actorId });
  }

  private resourceRoomId(job: ResourceDeliveryJob): string | undefined {
    if (!job.payload || typeof job.payload !== 'object') return undefined;
    const payload = job.payload as Record<string, unknown>;
    if (typeof payload.roomId === 'string') return payload.roomId;
    if (payload.package && typeof payload.package === 'object' && typeof (payload.package as Record<string, unknown>).roomId === 'string') return (payload.package as Record<string, unknown>).roomId as string;
    if (payload.phrase && typeof payload.phrase === 'object' && typeof (payload.phrase as Record<string, unknown>).roomId === 'string') return (payload.phrase as Record<string, unknown>).roomId as string;
    return undefined;
  }
}
