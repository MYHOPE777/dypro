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
const RISK_SEVERITY = { safe: 0, warning: 1, blocked: 2 } as const;

function normalized(result: ComplianceResult, segment: TranscriptSegment, product: Product, now: number): ComplianceResult {
  const sourceId = result.id || 'compliance';
  return { ...result, id: `${sourceId}:${segment.id}`, segmentId: segment.id, productId: product.id, transcript: segment.text, createdAt: now };
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

  async process(input: { token: ReviewToken; segment: TranscriptSegment; product: Product; roomId?: string; riskProfile: RiskProfile; context: AnalysisInput['context']; stats: SessionStats; customRules?: ComplianceRule[]; referencePhrases?: Array<{ text: string; purpose?: CoachPurpose }> }): Promise<void> {
    const { token, segment, product } = input;
    const processStartedAt = this.monotonicNow();
    const analysisInput: AnalysisInput = { roomId: input.roomId, productId: product.id, transcript: segment.text, product, speaker: segment.speaker, speakerId: segment.speakerId, riskProfile: input.riskProfile, context: input.context, customRules: input.customRules };
    const localStartedAt = this.monotonicNow();
    const localResult = await this.options.scheduler.run('realtime', this.options.sessionId, () => this.localAnalyzer.analyze(analysisInput));
    const localCompletedAt = this.monotonicNow();
    const local = { ...normalized(localResult, segment, product, this.now()), analysisMs: this.elapsed(processStartedAt, localCompletedAt) };
    this.logTiming(input, 'local_rule', processStartedAt, localStartedAt, localCompletedAt);
    if (!this.options.isProductSegmentCurrent(token) || !this.options.isLatest(token)) return;
    this.options.onCompliance(local, true);
    const references = input.referencePhrases?.filter((phrase) => phrase.text.trim()) ?? [];
    const coachInput = (compliance: ComplianceResult): CoachInput => ({
      product,
      transcript: segment.text,
      compliance,
      stats: input.stats,
      referencePhrases: references,
      templateMode: references.length ? 'reference' : 'generate',
      customRules: input.customRules,
    });
    const fallbackFor = (compliance: ComplianceResult) => localSuggestions(coachInput(compliance)).slice(0, 3);
    const fallback = fallbackFor(local);
    if (this.options.isLatest(token)) this.options.onCoach(segment.id, fallback, true);

    const requestCoach = async (compliance: ComplianceResult, safeFallback: CoachSuggestion[]) => {
      const queuedAt = this.monotonicNow();
      let startedAt: number | undefined;
      const task = this.options.scheduler.run('model', this.options.sessionId, async () => {
        startedAt = this.monotonicNow();
        const remainingMs = MODEL_BUDGET_MS - this.elapsed(queuedAt, startedAt);
        if (remainingMs <= 0) return { value: safeFallback, expired: true };
        const result = await withTimeout(this.options.coach!.suggestMany!(coachInput(compliance)), remainingMs, safeFallback);
        return { value: result.value, expired: result.timedOut };
      });
      const remote = await withTimeout(task, MODEL_BUDGET_MS, { value: safeFallback, expired: true });
      return {
        suggestions: remote.value.value.slice(0, 3),
        queuedAt,
        startedAt: startedAt ?? this.monotonicNow(),
        completedAt: this.monotonicNow(),
        timedOut: remote.timedOut || remote.value.expired,
      };
    };

    const semanticQueuedAt = this.monotonicNow();
    let semanticStartedAt: number | undefined;
    let semanticOverrideActive = false;
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
      if (!this.options.isProductSegmentCurrent(token)) return;
      const latest = this.options.isLatest(token);
      this.options.onCompliance(resolved, latest);
      if (RISK_SEVERITY[resolved.risk] <= RISK_SEVERITY[local.risk]) return;
      if (!latest) return;
      semanticOverrideActive = true;
      const safeFallback = fallbackFor(resolved);
      if (!this.options.coach?.suggestMany) {
        this.options.onCoach(segment.id, safeFallback, false);
        return;
      }
      this.options.onCoach(segment.id, safeFallback, true);
      void requestCoach(resolved, safeFallback).then((correctedCoach) => {
        this.logTiming(input, 'coach', processStartedAt, correctedCoach.startedAt, correctedCoach.completedAt, correctedCoach.queuedAt, correctedCoach.timedOut);
        if (this.options.isProductSegmentCurrent(token) && this.options.isLatest(token)) this.options.onCoach(segment.id, correctedCoach.suggestions, false);
      }).catch(() => {
        if (this.options.isProductSegmentCurrent(token) && this.options.isLatest(token)) this.options.onCoach(segment.id, safeFallback, false);
      });
    }).catch(() => undefined);

    if (!this.options.coach?.suggestMany) {
      if (this.options.isLatest(token)) this.options.onCoach(segment.id, fallback, false);
      this.logTiming(input, 'coach', processStartedAt, localCompletedAt, localCompletedAt, undefined, false);
      return;
    }
    void requestCoach(local, fallback).then((remoteCoach) => {
      this.logTiming(input, 'coach', processStartedAt, remoteCoach.startedAt, remoteCoach.completedAt, remoteCoach.queuedAt, remoteCoach.timedOut);
      if (!semanticOverrideActive && this.options.isProductSegmentCurrent(token) && this.options.isLatest(token)) this.options.onCoach(segment.id, remoteCoach.suggestions, false);
    }).catch(() => {
      if (!semanticOverrideActive && this.options.isProductSegmentCurrent(token) && this.options.isLatest(token)) this.options.onCoach(segment.id, fallback, false);
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
