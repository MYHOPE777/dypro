import { describe, expect, it, vi } from 'vitest';
import { analyzeTranscript } from '../../src/compliance/engine';
import { DEFAULT_PRODUCT } from '../../src/shared/products';
import type { ComplianceResult, CoachSuggestion, TranscriptSegment } from '../../src/shared/types';
import type { CoachInput } from '../providers/doubaoCoach';
import { BoundedScheduler } from './scheduler';
import { RealtimeReviewPipeline } from './realtimeReviewPipeline';

const segment: TranscriptSegment = { id: 'segment-latency', text: '这款商品适合日常使用', isFinal: true, timestamp: 1, offsetMs: 1, startOffsetMs: 0, endOffsetMs: 1, speaker: 'host' };

describe('realtime latency budgets', () => {
  it('keeps local rule P95 below 50ms and first three prompts below 800ms', async () => {
    const samples: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      await analyzeTranscript({ productId: DEFAULT_PRODUCT.id, product: DEFAULT_PRODUCT, transcript: index % 2 ? '保证立刻见效' : '适合日常使用' });
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThanOrEqual(50);

    let firstCoachAt = Number.POSITIVE_INFINITY;
    const started = performance.now();
    const pipeline = new RealtimeReviewPipeline({
      sessionId: 'latency-session', scheduler: new BoundedScheduler({ modelGlobal: 4, modelPerSession: 2, background: 1 }),
      analyzer: { analyze: () => new Promise<ComplianceResult>(() => undefined) },
      isProductSegmentCurrent: () => true, isLatest: () => true, onCompliance: () => undefined,
      onCoach: (_segmentId, suggestions) => { if (suggestions.length === 3 && !Number.isFinite(firstCoachAt)) firstCoachAt = performance.now(); },
    });
    await pipeline.process({ token: { requestSequence: 1, productRevision: 0, segmentRevision: 0, segmentId: segment.id }, segment, product: DEFAULT_PRODUCT, riskProfile: 'balanced', context: { text: segment.text, segmentCount: 1, windowStartMs: 0, windowEndMs: 1 }, stats: { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 } });
    expect(firstCoachAt - started).toBeLessThanOrEqual(800);
  });

  it('stops waiting for remote analysis at the two second budget', async () => {
    vi.useFakeTimers();
    const coachUpdates: Array<{ suggestions: CoachSuggestion[]; pending: boolean }> = [];
    let coachStarted = false;
    const pipeline = new RealtimeReviewPipeline({
      sessionId: 'timeout-session', scheduler: new BoundedScheduler({ modelGlobal: 1, modelPerSession: 1, background: 1 }),
      analyzer: { analyze: () => new Promise<ComplianceResult>(() => undefined) },
      coach: {
        suggest: () => new Promise<CoachSuggestion>(() => undefined),
        suggestMany: () => { coachStarted = true; return new Promise<CoachSuggestion[]>(() => undefined); },
      },
      isProductSegmentCurrent: () => true, isLatest: () => true, onCompliance: () => undefined,
      onCoach: (_segmentId, suggestions, pending) => coachUpdates.push({ suggestions, pending }),
    });
    await pipeline.process({ token: { requestSequence: 1, productRevision: 0, segmentRevision: 0, segmentId: segment.id }, segment, product: DEFAULT_PRODUCT, riskProfile: 'balanced', context: { text: '', segmentCount: 1, windowStartMs: 0, windowEndMs: 1 }, stats: { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 } });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(coachUpdates.at(-1)?.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(coachUpdates.at(-1)?.pending).toBe(false);
    expect(coachStarted).toBe(false);
    vi.useRealTimers();
  });

  it('starts semantic review and coaching in parallel', async () => {
    let finishAnalysis!: (result: ComplianceResult) => void;
    const analysis = new Promise<ComplianceResult>((resolve) => { finishAnalysis = resolve; });
    let analysisStarted = false;
    let coachStarted = false;
    const pipeline = new RealtimeReviewPipeline({
      sessionId: 'parallel-session', scheduler: new BoundedScheduler({ modelGlobal: 2, modelPerSession: 2, background: 1 }),
      analyzer: { analyze: async () => { analysisStarted = true; return analysis; } },
      coach: {
        suggest: async () => ({ id: 'unused', purpose: '塑品', text: 'unused', reason: 'unused', source: 'doubao', createdAt: 1 }),
        suggestMany: async () => { coachStarted = true; return []; },
      },
      isProductSegmentCurrent: () => true, isLatest: () => true, onCompliance: () => undefined, onCoach: () => undefined,
    });

    await pipeline.process({ token: { requestSequence: 1, productRevision: 0, segmentRevision: 0, segmentId: segment.id }, segment, product: DEFAULT_PRODUCT, riskProfile: 'balanced', context: { text: segment.text, segmentCount: 1, windowStartMs: 0, windowEndMs: 1 }, stats: { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 } });
    await vi.waitFor(() => expect(analysisStarted).toBe(true));
    expect(coachStarted).toBe(true);
    finishAnalysis({ id: 'remote', productId: DEFAULT_PRODUCT.id, risk: 'safe', title: '可继续', reason: '安全', alternative: '', policyRef: 'test', confidence: 0.9, source: 'doubao', transcript: segment.text, createdAt: 1 });
  });

  it('regenerates coaching after semantic review raises the risk level', async () => {
    const coachInputs: CoachInput[] = [];
    const coachUpdates: Array<{ suggestions: CoachSuggestion[]; pending: boolean }> = [];
    const suggestions = (prefix: string): CoachSuggestion[] => [0, 1, 2].map((index) => ({
      id: `${prefix}-${index}`,
      purpose: index === 0 ? '转化' : '互动',
      text: `${prefix}话术${index + 1}`,
      reason: '测试',
      source: 'doubao',
      createdAt: index,
    }));
    const pipeline = new RealtimeReviewPipeline({
      sessionId: 'semantic-escalation-session',
      scheduler: new BoundedScheduler({ modelGlobal: 4, modelPerSession: 2, background: 1 }),
      analyzer: { analyze: async () => ({ id: 'remote-risk', productId: DEFAULT_PRODUCT.id, risk: 'blocked', title: '语义风险', reason: '需要替换', alternative: '可以改为：只介绍商品页面信息。', policyRef: 'test', confidence: 0.95, source: 'doubao', transcript: segment.text, createdAt: 1 }) },
      coach: {
        suggest: async () => suggestions('unused')[0],
        suggestMany: async (coachInput) => {
          coachInputs.push(coachInput);
          return suggestions(coachInput.compliance?.risk === 'blocked' ? '纠正后' : '初次');
        },
      },
      isProductSegmentCurrent: () => true,
      isLatest: () => true,
      onCompliance: () => undefined,
      onCoach: (_segmentId, next, pending) => coachUpdates.push({ suggestions: next, pending }),
    });

    await pipeline.process({ token: { requestSequence: 1, productRevision: 0, segmentRevision: 0, segmentId: segment.id }, segment, product: DEFAULT_PRODUCT, riskProfile: 'strict', context: { text: segment.text, segmentCount: 1, windowStartMs: 0, windowEndMs: 1 }, stats: { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 } });
    await vi.waitFor(() => expect(coachInputs.map((entry) => entry.compliance?.risk)).toContain('blocked'));
    await vi.waitFor(() => expect(coachUpdates.at(-1)).toMatchObject({ pending: false }));

    expect(coachUpdates.at(-1)?.suggestions.every((suggestion) => suggestion.text.startsWith('纠正后'))).toBe(true);
  });

  it('keeps total latency on results and emits detailed stage timings for logs', async () => {
    const results: ComplianceResult[] = [];
    const timings: Array<{ stage: string; totalMs: number }> = [];
    const pipeline = new RealtimeReviewPipeline({
      sessionId: 'timing-session',
      scheduler: new BoundedScheduler({ modelGlobal: 1, modelPerSession: 1, background: 1 }),
      analyzer: { analyze: async () => ({ id: 'remote-result', productId: DEFAULT_PRODUCT.id, risk: 'safe', title: '可继续', reason: '表达清晰', alternative: '继续介绍商品页面信息', policyRef: '常规表达', confidence: 0.9, source: 'doubao', transcript: segment.text, createdAt: 1, analysisTiming: { path: 'ark', analyzerMs: 12, localGuardrailMs: 1, cacheLookupMs: 1, arkRequestMs: 9, responseParseMs: 1 } }) },
      coach: {
        suggest: async () => ({ id: 'remote-coach', purpose: '塑品', text: '继续说明商品适用场景', reason: '建立价值', source: 'doubao', createdAt: 1 }),
        suggestMany: async () => [{ id: 'remote-coach', purpose: '塑品', text: '继续说明商品适用场景', reason: '建立价值', source: 'doubao', createdAt: 1 }],
      },
      isProductSegmentCurrent: () => true,
      isLatest: () => true,
      onCompliance: (result) => results.push(result),
      onCoach: () => undefined,
      onTiming: (timing) => timings.push(timing),
    });

    await pipeline.process({ token: { requestSequence: 1, productRevision: 0, segmentRevision: 0, segmentId: segment.id }, segment, product: DEFAULT_PRODUCT, riskProfile: 'balanced', context: { text: segment.text, segmentCount: 1, windowStartMs: 0, windowEndMs: 1 }, stats: { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 } });
    await vi.waitFor(() => expect(results).toHaveLength(2));
    await vi.waitFor(() => expect(timings.map((timing) => timing.stage)).toEqual(['local_rule', 'semantic_review', 'coach']));

    expect(results.every((result) => typeof result.analysisMs === 'number' && result.analysisMs >= 0)).toBe(true);
    expect(timings.every((timing) => timing.totalMs >= 0)).toBe(true);
  });
});
