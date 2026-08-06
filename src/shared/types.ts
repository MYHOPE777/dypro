export type RiskLevel = 'safe' | 'warning' | 'blocked';

export type Product = {
  id: string;
  name: string;
  category: string;
  price: string;
  image: string;
  accent: string;
  compliantPhrases: string[];
};

export type TranscriptSegment = {
  id: string;
  text: string;
  isFinal: boolean;
  timestamp: number;
  offsetMs: number | null;
  startOffsetMs: number | null;
  endOffsetMs: number | null;
};

export type TimelineEventType =
  | 'session.created'
  | 'capture.started'
  | 'capture.stopped'
  | 'capture.failed'
  | 'product.selected'
  | 'transcript.final'
  | 'compliance.result';

export type TimelineEvent = {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  type: TimelineEventType;
  occurredAt: number;
  occurredAtIso: string;
  timezone: 'Asia/Shanghai';
  offsetMs: number | null;
  productId: string | null;
  payload: Record<string, unknown>;
};

export type TimelineAudioAsset = {
  assetId: string;
  encoding: 'pcm_s16le';
  sampleRate: number;
  channels: 1;
  bitsPerSample: 16;
  byteLength: number;
  sampleCount: number;
  durationMs: number;
  pcmUrl: string;
  wavUrl: string;
};

export type SessionTimelineExport = {
  schemaVersion: 1;
  sessionId: string;
  timezone: 'Asia/Shanghai';
  createdAt: number;
  recordingStartedAt: number | null;
  audio: TimelineAudioAsset | null;
  sourceAudio: TimelineAudioAsset[];
  events: TimelineEvent[];
};

export type ComplianceResult = {
  id: string;
  productId: string;
  risk: RiskLevel;
  title: string;
  reason: string;
  alternative: string;
  policyRef: string;
  confidence: number;
  source: 'doubao' | 'local-fallback';
  transcript: string;
  createdAt: number;
};

export type SessionStats = {
  speakingSeconds: number;
  words: number;
  blockedCount: number;
  warningCount: number;
  safeCount: number;
};

export type SessionState = {
  sessionId: string;
  product: Product;
  isListening: boolean;
  partialTranscript: string;
  transcriptHistory: TranscriptSegment[];
  latestCompliance: ComplianceResult | null;
  alerts: ComplianceResult[];
  stats: SessionStats;
  lastEventAt: number;
};

export type ClientMessage =
  | { type: 'session.join'; sessionId?: string; role: 'operator' | 'display' }
  | { type: 'control.start' }
  | { type: 'control.stop' }
  | { type: 'product.select'; productId: string }
  | { type: 'audio'; data: string }
  | { type: 'audio.raw'; data: string; sampleRate: number }
  | { type: 'demo.transcript'; text: string };

export type ServerMessage =
  | { type: 'connection.ready'; sessionId: string; products: Product[] }
  | { type: 'state.snapshot'; state: SessionState }
  | { type: 'transcript.partial'; segment: TranscriptSegment }
  | { type: 'transcript.final'; segment: TranscriptSegment }
  | { type: 'compliance.result'; result: ComplianceResult }
  | { type: 'system.status'; message: string; tone: 'neutral' | 'success' | 'warning' | 'error' }
  | { type: 'system.error'; message: string };
