import { createLocalAnalyzer, type AnalysisInput, type ComplianceAnalyzer } from '../../src/compliance/engine';
import type { CoachPurpose, ComplianceResult, ComplianceRule, CoachSuggestion, Product, RiskProfile, SessionStats, TranscriptSegment } from '../../src/shared/types';
import { localSuggestions, type CoachInput, type CoachProvider } from '../providers/doubaoCoach';
import { BoundedScheduler } from './scheduler';

export type ReviewToken = { requestSequence: number; productRevision: number; segmentRevision: number; segmentId: string };

export type RealtimeReviewTiming = {
  event: 'realtime_review_timing';
  stage: 'local_rule' | 'semantic_review' | 'coach';
  sessionId: string;
  segmentId: string;
  productId: string;
  requestSequence: number;
  totalMs: number;
  stageMs: number;
  queueMs?: number;
  timedOut?: boolean;
  analysisPath?: ComplianceResult['analysisTiming'];
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<{ value: T; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ value: fallback, timedOut: true }); } }, timeoutMs);
    timer.unref();
    promise.then((value) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ value, timedOut: false }); } }, () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ value: fallback, timedOut: false }); } });
  });
}

const MODEL_BUDGET_MS = 2_000;

function normalized(result: ComplianceResult, segment: TranscriptSegment, product: Product, now: number): ComplianceResult {
  return { ...result, id: result.id || `compliance-${now}`, segmentId: segment.id, productId: product.id, transcript: segment.text, createdAt: now };
}

export class RealtimeReviewPipeline {
  private readonly localAnalyzer = createLocalAnalyzer();

  constructor(private readonly options: {
    sessionId: string;
    scheduler: BoundedScheduler;
    analyzer: Pick<ComplianceAnalyzer, 'analyze'>;
    coach?: CoachProvider | null;
    now?: () => number;
    isProductSegmentCurrent: (token: ReviewToken) => boolean;
    isLatest: (token: ReviewToken) => boolean;
    onCompliance: (result: ComplianceResult, latest: boolean) => void;
    onCoach: (segmentId: string, suggestions: CoachSuggestion[], pending: boolean) => void;
    onTiming?: (timing: RealtimeReviewTiming) => void;
    monotonicNow?: () => number;
  }) {}

  async process(input: { token: ReviewToken; segment: TranscriptSegment; product: Product; riskProfile: RiskProfile; context: AnalysisInput['context']; stats: SessionStats; customRules?: ComplianceRule[]; referencePhrases?: Array<{ text: string; purpose?: CoachPurpose }> }): Promise<void> {
    const { token, segment, product } = input;
    const processStartedAt = this.monotonicNow();
    const analysisInput: AnalysisInput = { productId: product.id, transcript: segment.text, product, riskProfile: input.riskProfile, context: input.context, customRules: input.customRules };
    const localStartedAt = this.monotonicNow();
    const localResult = await this.options.scheduler.run('realtime', this.options.sessionId, () => this.localAnalyzer.analyze(analysisInput));
    const localCompletedAt = this.monotonicNow();
    const local = { ...normalized(localResult, segment, product, this.now()), analysisMs: this.elapsed(processStartedAt, localCompletedAt) };
    this.logTiming(input, 'local_rule', processStartedAt, localStartedAt, localCompletedAt);
    if (!this.options.isProductSegmentCurrent(token) || !this.options.isLatest(token)) return;
    this.options.onCompliance(local, true);
    const fallback = localSuggestions({ product, transcript: segment.text, compliance: local, stats: input.stats, referencePhrases: input.referencePhrases } as CoachInput).slice(0, 3);
    if (this.options.isLatest(token)) this.options.onCoach(segment.id, fallback, true);

    const semanticQueuedAt = this.monotonicNow();
    let semanticStartedAt: number | undefined;
    const semanticTask = this.options.scheduler.run('model', this.options.sessionId, async () => {
      semanticStartedAt = this.monotonicNow();
      const remainingMs = MODEL_BUDGET_MS - this.elapsed(semanticQueuedAt, semanticStartedAt);
      if (remainingMs <= 0) return { value: local, expired: true };
      const result = await withTimeout(this.options.analyzer.analyze(analysisInput), remainingMs, local);
      return { value: result.value, expired: result.timedOut };
    });
    void withTimeout(semanticTask, MODEL_BUDGET_MS, { value: local, expired: true }).then((remote) => {
      const semanticCompletedAt = this.monotonicNow();
      const resolved = { ...normalized(remote.value.value, segment, product, this.now()), analysisMs: this.elapsed(processStartedAt, semanticCompletedAt) };
      this.logTiming(input, 'semantic_review', processStartedAt, semanticStartedAt ?? semanticCompletedAt, semanticCompletedAt, semanticQueuedAt, remote.timedOut || remote.value.expired, resolved.analysisTiming);
      if (!this.options.isProductSegmentCurrent(token) || !this.options.isLatest(token)) return;
      this.options.onCompliance(resolved, true);
    }).catch(() => undefined);

    if (!this.options.coach?.suggestMany) {
      if (this.options.isLatest(token)) this.options.onCoach(segment.id, fallback, false);
      this.logTiming(input, 'coach', processStartedAt, localCompletedAt, localCompletedAt, undefined, false);
      return;
    }
    const coachQueuedAt = this.monotonicNow();
    let coachStartedAt: number | undefined;
    const coachTask = this.options.scheduler.run('model', this.options.sessionId, async () => {
      coachStartedAt = this.monotonicNow();
      const remainingMs = MODEL_BUDGET_MS - this.elapsed(coachQueuedAt, coachStartedAt);
      if (remainingMs <= 0) return { value: fallback, expired: true };
      const result = await withTimeout(this.options.coach!.suggestMany!({ product, transcript: segment.text, compliance: local, stats: input.stats, referencePhrases: input.referencePhrases }), remainingMs, fallback);
      return { value: result.value, expired: result.timedOut };
    });
    void withTimeout(coachTask, MODEL_BUDGET_MS, { value: fallback, expired: true }).then((remoteCoach) => {
      const coachCompletedAt = this.monotonicNow();
      this.logTiming(input, 'coach', processStartedAt, coachStartedAt ?? coachCompletedAt, coachCompletedAt, coachQueuedAt, remoteCoach.timedOut || remoteCoach.value.expired);
      if (this.options.isLatest(token)) this.options.onCoach(segment.id, remoteCoach.value.value.slice(0, 3), false);
    }).catch(() => {
      if (this.options.isLatest(token)) this.options.onCoach(segment.id, fallback, false);
    });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private monotonicNow(): number {
    return (this.options.monotonicNow ?? (() => performance.now()))();
  }

  private elapsed(startedAt: number, completedAt: number): number {
    return Math.max(0, Math.round(completedAt - startedAt));
  }

  private logTiming(input: { token: ReviewToken; segment: TranscriptSegment; product: Product }, stage: RealtimeReviewTiming['stage'], processStartedAt: number, stageStartedAt: number, completedAt: number, queuedAt?: number, timedOut?: boolean, analysisPath?: ComplianceResult['analysisTiming']): void {
    this.options.onTiming?.({
      event: 'realtime_review_timing', stage, sessionId: this.options.sessionId, segmentId: input.segment.id, productId: input.product.id, requestSequence: input.token.requestSequence,
      totalMs: this.elapsed(processStartedAt, completedAt), stageMs: this.elapsed(stageStartedAt, completedAt),
      ...(queuedAt === undefined ? {} : { queueMs: this.elapsed(queuedAt, stageStartedAt) }),
      ...(timedOut === undefined ? {} : { timedOut }),
      ...(analysisPath ? { analysisPath } : {}),
    });
  }
}
