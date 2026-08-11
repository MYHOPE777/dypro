import type { AnalysisInput } from '../../src/compliance/engine';
import type { TranscriptSegment } from '../../src/shared/types';

const MAX_SEGMENTS = 12;
const MAX_WINDOW_MS = 30_000;

/** Builds a compact current-product context without mixing other speakers into the host narrative. */
export function buildRiskContext(segments: TranscriptSegment[], productStartedAt: number, now: number): AnalysisInput['context'] {
  const hostSegments = segments
    .filter((segment) => segment.timestamp >= productStartedAt && segment.speaker === 'host' && segment.text.trim())
    .slice(-MAX_SEGMENTS);
  const recent = hostSegments.filter((segment) => now - segment.timestamp <= MAX_WINDOW_MS);
  const selected = recent;
  return {
    text: selected.map((segment) => segment.text.trim()).join('\n'),
    segmentCount: selected.length,
    windowStartMs: selected[0]?.timestamp ?? productStartedAt,
    windowEndMs: selected.at(-1)?.timestamp ?? now,
  };
}
