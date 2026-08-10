/**
 * Lightweight, local speaker grouping for a mixed mono microphone stream.
 *
 * This is deliberately a candidate grouper rather than an identity detector:
 * without separate microphones or a provider diarization result it cannot
 * know which voice is the host. The UI must keep the result as "待确认" until
 * an operator binds a candidate to a role.
 */

export type SpeakerFeature = {
  rms: number;
  zeroCrossingRate: number;
  peak: number;
};

type FeatureWindow = SpeakerFeature & { startMs: number; endMs: number };

type Cluster = {
  id: string;
  centroid: SpeakerFeature;
  count: number;
  lastSeenMs: number;
};

export type SpeakerAssignment = {
  speakerId: string;
  confidence: number;
  source: 'automatic';
};

const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
const MAX_FEATURE_AGE_MS = 45_000;
const MAX_CLUSTERS = 4;
// Typical speech voices differ by only a few hundredths in this normalized
// feature space, so keep the split threshold conservative and let the
// operator confirm the candidate identity.
const NEW_CLUSTER_DISTANCE = 0.045;

function featureDistance(left: SpeakerFeature, right: SpeakerFeature): number {
  // Zero-crossing rate is the most useful cheap proxy for voice timbre here.
  // Energy and peak add separation while remaining insensitive to text content.
  return Math.abs(left.rms - right.rms) * 0.3
    + Math.abs(left.zeroCrossingRate - right.zeroCrossingRate) * 0.5
    + Math.abs(left.peak - right.peak) * 0.2;
}

function averageFeature(features: SpeakerFeature[]): SpeakerFeature {
  if (features.length === 0) return { rms: 0, zeroCrossingRate: 0, peak: 0 };
  return features.reduce((sum, feature) => ({
    rms: sum.rms + feature.rms / features.length,
    zeroCrossingRate: sum.zeroCrossingRate + feature.zeroCrossingRate / features.length,
    peak: sum.peak + feature.peak / features.length,
  }), { rms: 0, zeroCrossingRate: 0, peak: 0 });
}

export function extractSpeakerFeature(pcm: Buffer): SpeakerFeature | null {
  if (pcm.length < 4) return null;
  const sampleCount = Math.floor(pcm.length / 2);
  let energy = 0;
  let peak = 0;
  let crossings = 0;
  let previous = pcm.readInt16LE(0);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = pcm.readInt16LE(index * 2) / 0x7fff;
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if (index > 0 && ((sample >= 0) !== (previous >= 0))) crossings += 1;
    previous = sample;
  }
  return {
    rms: Math.sqrt(energy / sampleCount),
    zeroCrossingRate: crossings / Math.max(1, sampleCount - 1),
    peak,
  };
}

export class SpeakerDiarizer {
  private windows: FeatureWindow[] = [];
  private clusters: Cluster[] = [];

  reset(): void {
    this.windows = [];
    this.clusters = [];
  }

  pushAudio(pcm: Buffer, startMs: number | null): void {
    if (startMs === null || pcm.length < 4) return;
    const sampleCount = Math.floor(pcm.length / 2);
    for (let cursor = 0; cursor < sampleCount; cursor += FRAME_SAMPLES) {
      const frameSamples = Math.min(FRAME_SAMPLES, sampleCount - cursor);
      if (frameSamples < FRAME_SAMPLES / 2) break;
      const frame = pcm.subarray(cursor * 2, (cursor + frameSamples) * 2);
      const feature = extractSpeakerFeature(frame);
      if (!feature) continue;
      const frameStartMs = startMs + (cursor / 16_000) * 1_000;
      this.windows.push({ ...feature, startMs: frameStartMs, endMs: frameStartMs + (frameSamples / 16_000) * 1_000 });
    }
    const cutoff = startMs + (sampleCount / 16_000) * 1_000 - MAX_FEATURE_AGE_MS;
    this.windows = this.windows.filter((window) => window.endMs >= cutoff);
  }

  assign(startMs: number | null, endMs: number | null, fallbackAtMs: number): SpeakerAssignment | null {
    const latestEndMs = this.windows.at(-1)?.endMs;
    const requestedTo = endMs ?? fallbackAtMs;
    // A reconnecting ASR stream can restart its utterance clock at zero. In
    // that case use the newest audio window rather than an old absolute range.
    const staleTiming = latestEndMs !== undefined && latestEndMs - requestedTo > 1_500;
    const from = staleTiming ? Math.max(0, fallbackAtMs - 800) : startMs ?? Math.max(0, fallbackAtMs - 800);
    const to = staleTiming ? fallbackAtMs : requestedTo;
    let windows = this.windows.filter((window) => window.endMs >= from && window.startMs <= to && window.rms >= 0.008);
    if (windows.length === 0) windows = this.windows.filter((window) => window.endMs >= Math.max(0, to - 800) && window.rms >= 0.008).slice(-40);
    if (windows.length === 0) return null;
    const feature = averageFeature(windows);
    let closest: Cluster | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const cluster of this.clusters) {
      const distance = featureDistance(feature, cluster.centroid);
      if (distance < closestDistance) {
        closest = cluster;
        closestDistance = distance;
      }
    }
    if (!closest || (closestDistance > NEW_CLUSTER_DISTANCE && this.clusters.length < MAX_CLUSTERS)) {
      const cluster: Cluster = {
        id: `speaker-${this.clusters.length + 1}`,
        centroid: feature,
        count: 1,
        lastSeenMs: to,
      };
      this.clusters.push(cluster);
      return { speakerId: cluster.id, confidence: 0.58, source: 'automatic' };
    }
    closest.centroid = averageFeature([closest.centroid, feature]);
    closest.count += 1;
    closest.lastSeenMs = to;
    return {
      speakerId: closest.id,
      confidence: Math.max(0.4, Math.min(0.98, 1 - closestDistance / NEW_CLUSTER_DISTANCE)),
      source: 'automatic',
    };
  }
}
