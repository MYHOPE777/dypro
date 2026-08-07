import type { ComplianceResult, TranscriptSegment } from '../shared/types';

export function complianceForLatestSegment(state: {
  transcriptHistory: TranscriptSegment[];
  latestCompliance: ComplianceResult | null;
  partialTranscript?: string;
  productContextStartedAt?: number;
}): ComplianceResult | null {
  if (state.partialTranscript?.trim()) return null;
  const latestSegment = state.transcriptHistory.at(-1);
  if (!latestSegment || state.latestCompliance?.segmentId !== latestSegment.id) return null;
  if (state.productContextStartedAt !== undefined && latestSegment.timestamp < state.productContextStartedAt) return null;
  return state.latestCompliance;
}
