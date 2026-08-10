export type RiskLevel = 'safe' | 'warning' | 'blocked';
export type RiskProfile = 'strict' | 'balanced' | 'optimized';
export type CaptureState = 'idle' | 'live' | 'paused' | 'ended';
export type SpeakerLabel = 'host' | 'other';
export type SpeakerSource = 'default' | 'automatic' | 'manual';
export type CoachPurpose = '塑品' | '憋单' | '逼单' | '转化' | '互动' | '留人' | '答疑';

export type LiveRoom = {
  id: string;
  /** Optional for backward-compatible local catalogs; production rooms always carry a tenant. */
  tenantId?: string;
  name: string;
  accountName: string;
  platform: 'douyin';
  ownerActorId: string;
  createdAt: number;
  updatedAt: number;
};

export type Product = {
  id: string;
  name: string;
  category: string;
  price: string;
  stock: number | null;
  sku: string;
  description: string;
  sellingPoints: string[];
  image: string;
  accent: string;
  compliantPhrases: string[];
  source: 'seed' | 'manual' | 'doubao' | 'local-fallback';
  sourceText?: string;
  updatedAt: number;
};

export type TranscriptSegment = {
  id: string;
  text: string;
  isFinal: boolean;
  timestamp: number;
  offsetMs: number | null;
  startOffsetMs: number | null;
  endOffsetMs: number | null;
  speaker?: SpeakerLabel;
  /** Stable candidate id (speaker-1, speaker-2...) for mixed-room grouping. */
  speakerId?: string;
  /** Whether the label was inferred from audio or confirmed by the operator. */
  speakerSource?: SpeakerSource;
  speakerConfidence?: number;
};

export type TimelineEventType =
  | 'session.created'
  | 'session.note.updated'
  | 'capture.started'
  | 'capture.resumed'
  | 'capture.paused'
  | 'capture.ended'
  | 'capture.stopped'
  | 'capture.failed'
  | 'asr.error'
  | 'asr.recovery.started'
  | 'asr.recovery.succeeded'
  | 'lineup.updated'
  | 'product.selected'
  | 'transcript.final'
  | 'transcript.corrected'
  | 'transcript.annotated'
  | 'risk.profile.changed'
  | 'presenter.selected'
  | 'coach.suggestion'
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

export type SessionArchiveSyncState = 'local-only' | 'approval-required' | 'pending' | 'failed' | 'synced';

export type SessionArchiveSync = {
  state: SessionArchiveSyncState;
  updatedAt: number | null;
  lastError?: string;
};

export type SessionHistorySummary = {
  sessionId: string;
  roomId: string;
  presenterId: string;
  presenterName: string;
  createdAt: number;
  recordingStartedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
  captureState: CaptureState;
  note: string;
  transcriptCount: number;
  correctionCount: number;
  productNames: string[];
  hasAudio: boolean;
  audioDurationMs: number;
  audioByteLength: number;
  sync: SessionArchiveSync;
};

export type ComplianceResult = {
  id: string;
  segmentId?: string;
  productId: string;
  risk: RiskLevel;
  title: string;
  reason: string;
  alternative: string;
  policyRef: string;
  confidence: number;
  source: 'doubao' | 'local-fallback' | 'custom-rule';
  transcript: string;
  createdAt: number;
  /** Milliseconds from final transcript receipt to the completed compliance result. */
  analysisMs?: number;
  /** Detailed server-side stages retained for timeline diagnostics. */
  analysisTiming?: ComplianceAnalysisTiming;
  /** Terms or phrases identified as the reason for a non-safe result. */
  matchedTerms?: string[];
  /** Only stable term findings are eligible for automatic rule learning. */
  ruleKind?: 'term' | 'sentence' | 'context';
};

export type CoachSuggestion = {
  id: string;
  purpose: CoachPurpose;
  text: string;
  reason: string;
  source: 'doubao' | 'local-fallback';
  createdAt: number;
  latencyMs?: number;
};

export type ComplianceAnalysisTiming = {
  path: 'local' | 'cache' | 'ark' | 'fallback';
  analyzerMs: number;
  localGuardrailMs: number;
  cacheLookupMs?: number;
  arkRequestMs?: number;
  responseParseMs?: number;
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
  roomId: string;
  presenterId: string;
  presenterName: string;
  product: Product;
  lineup: Product[];
  isListening: boolean;
  captureState: CaptureState;
  partialTranscript: string;
  transcriptHistory: TranscriptSegment[];
  latestCompliance: ComplianceResult | null;
  coachSuggestion?: CoachSuggestion | null;
  coachSuggestions?: CoachSuggestion[];
  coachPending?: boolean;
  riskProfile: RiskProfile;
  /** Timestamp from which transcript belongs to the currently selected product. */
  productContextStartedAt: number;
  alerts: ComplianceResult[];
  stats: SessionStats;
  lastEventAt: number;
};

export type ClientMessage =
  | { type: 'session.join'; sessionId?: string; roomId?: string; displayAlias?: string; presenterId?: string; actorId?: string; token?: string; role: 'operator' | 'display' }
  | { type: 'control.start' }
  | { type: 'control.pause' }
  | { type: 'control.resume' }
  | { type: 'control.end' }
  | { type: 'control.stop' }
  | { type: 'product.select'; productId: string }
  | { type: 'lineup.set'; productIds: string[] }
  | { type: 'risk.profile'; profile: RiskProfile }
  | { type: 'presenter.select'; presenterId: string }
  | { type: 'transcript.correct'; segmentId: string; text: string; learn?: boolean; wrongText?: string; correctText?: string }
  | { type: 'transcript.speaker'; segmentId: string; speaker: SpeakerLabel; speakerId?: string }
  | { type: 'audio'; data: string }
  | { type: 'audio.raw'; data: string; sampleRate: number }
  | { type: 'demo.transcript'; text: string };

export type ServerMessage =
  | { type: 'connection.ready'; sessionId: string; products: Product[] }
  | { type: 'state.snapshot'; state: SessionState }
  | { type: 'transcript.partial'; segment: TranscriptSegment }
  | { type: 'transcript.final'; segment: TranscriptSegment }
  | { type: 'compliance.result'; result: ComplianceResult }
  | { type: 'capture.denied'; message: string }
  | { type: 'system.status'; message: string; tone: 'neutral' | 'success' | 'warning' | 'error' }
  | { type: 'system.error'; message: string };

export type ProductImportResponse = {
  product: Product;
  source: 'doubao' | 'local-fallback';
  confidence: number;
  warnings: string[];
};

export type ComplianceRuleScope = 'room' | 'shared';
export type ComplianceRuleStatus = 'draft' | 'pending_review' | 'published' | 'rejected' | 'rolled_back';

export type ComplianceRule = {
  id: string;
  roomId: string;
  scope: ComplianceRuleScope;
  name: string;
  matchType: 'contains' | 'regex';
  pattern: string;
  risk: RiskLevel;
  title: string;
  reason: string;
  alternative: string;
  policyRef: string;
  enabled: boolean;
  status: ComplianceRuleStatus;
  version: number;
  origin?: 'manual' | 'learned' | 'synced';
  confidence?: number;
  evidenceCount?: number;
  evidenceRoomIds?: string[];
  lastSeenAt?: number;
  lastSessionId?: string;
  createdBy: string;
  approvedBy?: string;
  createdAt: number;
  updatedAt: number;
};

export type RuleAuditEntry = {
  id: string;
  ruleId: string;
  roomId: string;
  action: 'created' | 'learned' | 'observed' | 'submitted' | 'approved' | 'rejected' | 'edited' | 'rolled_back' | 'disabled' | 'enabled';
  actorId: string;
  occurredAt: number;
  details: Record<string, unknown>;
};

export type TranscriptCorrection = {
  id: string;
  sessionId: string;
  segmentId: string;
  originalText: string;
  correctedText: string;
  actorId: string;
  occurredAt: number;
};

export type SpeechCorrectionEntry = {
  id: string;
  roomId: string;
  wrongText: string;
  correctText: string;
  enabled: boolean;
  confirmations: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastSessionId: string;
  lastSegmentId: string;
};

export type PresenterProfile = {
  id: string;
  roomId: string;
  accountName: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type PresenterPhraseStatus = 'draft' | 'reference' | 'retired';

export type PresenterPhrase = {
  id: string;
  roomId: string;
  presenterId: string;
  productId: string | null;
  purpose?: CoachPurpose;
  text: string;
  source: 'session' | 'manual' | 'doubao' | 'imported';
  status: PresenterPhraseStatus;
  version: number;
  sourceSessionId?: string;
  sourceSegmentId?: string;
  parentPhraseId?: string;
  usageCount: number;
  createdAt: number;
  updatedAt: number;
};
