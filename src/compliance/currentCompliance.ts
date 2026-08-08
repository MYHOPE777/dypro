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

/**
 * Keeps an actionable replacement phrase visible while the host is reading it
 * and while the next transcript segment is waiting for compliance analysis.
 */
export function complianceForPrompt(state: {
  productId: string;
  transcriptHistory: TranscriptSegment[];
  latestCompliance: ComplianceResult | null;
  partialTranscript?: string;
  productContextStartedAt?: number;
}): ComplianceResult | null {
  if (state.latestCompliance && state.latestCompliance.productId !== state.productId) return null;
  const current = complianceForLatestSegment(state);
  if (current) return current;

  const retained = state.latestCompliance;
  if (!retained || retained.risk === 'safe' || retained.productId !== state.productId) return null;
  if (state.productContextStartedAt !== undefined && retained.createdAt < state.productContextStartedAt) return null;
  return retained;
}
