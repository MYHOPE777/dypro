import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '../../src/shared/types';
import { buildRiskContext } from './contextWindow';

function segment(id: string, timestamp: number, text: string, speaker: 'host' | 'other' = 'host'): TranscriptSegment {
  return { id, text, isFinal: true, timestamp, offsetMs: timestamp, startOffsetMs: timestamp - 100, endOffsetMs: timestamp, speaker };
}

describe('buildRiskContext', () => {
  it('keeps only the current product, host-owned, 30-second window', () => {
    const context = buildRiskContext([
      segment('before-product', 50_000, '上一件商品的暗示'),
      segment('old-host', 69_000, '主播三十五秒前的话术'),
      segment('other', 95_000, '场外人员提到发动机', 'other'),
      segment('host-1', 96_000, '主播当前的第一句'),
      segment('host-2', 97_000, '主播当前的第二句'),
    ], 60_000, 100_000);

    expect(context).toMatchObject({ segmentCount: 2, windowStartMs: 96_000, windowEndMs: 97_000 });
    expect(context!.text).toBe('主播当前的第一句\n主播当前的第二句');
  });

  it('does not fall back to stale context when the current window is empty', () => {
    const context = buildRiskContext([segment('stale', 60_000, '旧商品上下文')], 60_000, 100_000);

    expect(context!).toMatchObject({ text: '', segmentCount: 0, windowStartMs: 60_000, windowEndMs: 100_000 });
  });

  it('caps context at the most recent twelve host segments', () => {
    const segments = Array.from({ length: 14 }, (_, index) => segment(`host-${index}`, 90_000 + index, `第${index + 1}句`));
    const context = buildRiskContext(segments, 90_000, 90_100);

    expect(context!.segmentCount).toBe(12);
    expect(context!.text).toContain('第3句');
    expect(context!.text).not.toContain('第2句');
  });
});
