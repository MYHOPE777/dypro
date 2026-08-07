import { describe, expect, it } from 'vitest';
import { complianceForLatestSegment } from './currentCompliance';
import type { ComplianceResult, TranscriptSegment } from '../shared/types';

const segment = (id: string): TranscriptSegment => ({ id, text: id, isFinal: true, timestamp: 1, offsetMs: 1, startOffsetMs: 0, endOffsetMs: 1 });
const result = (segmentId: string): ComplianceResult => ({ id: `result-${segmentId}`, segmentId, productId: 'product', risk: 'warning', title: '提醒', reason: '原因', alternative: '替代表达', policyRef: '规则', confidence: 0.9, source: 'local-fallback', transcript: segmentId, createdAt: 1 });

describe('complianceForLatestSegment', () => {
  it('does not show the previous sentence result beside a newer transcript', () => {
    expect(complianceForLatestSegment({ transcriptHistory: [segment('first'), segment('second')], latestCompliance: result('first') })).toBeNull();
    expect(complianceForLatestSegment({ transcriptHistory: [segment('first')], latestCompliance: result('first'), partialTranscript: '正在说第二句' })).toBeNull();
  });

  it('returns the result once it belongs to the latest transcript', () => {
    const current = result('second');
    expect(complianceForLatestSegment({ transcriptHistory: [segment('first'), segment('second')], latestCompliance: current })).toBe(current);
  });

  it('ignores the last transcript from the previous product after a product switch', () => {
    expect(complianceForLatestSegment({
      transcriptHistory: [{ ...segment('previous-product'), timestamp: 100 }],
      latestCompliance: result('previous-product'),
      productContextStartedAt: 200,
    })).toBeNull();
  });
});
