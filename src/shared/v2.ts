import type {
  ComplianceResult,
  CoachSuggestion,
  Product,
  RiskProfile,
  SessionStats,
  SpeakerLabel,
  TranscriptSegment,
  SyncTarget,
} from './types';
import type { AudioTrack } from './v2Audio';

/** The only lifecycle states a v2 live session can expose. */
export type LiveLifecycle = 'idle' | 'live' | 'paused' | 'ending' | 'ended';

export type ReviewApproval = 'approval_required' | 'approved';
export type DeliveryStatus = 'not_queued' | 'queued' | 'uploading' | 'synced' | 'failed' | 'superseded';

export type LiveSessionSnapshot = {
  sessionId: string;
  tenantId: string;
  roomId: string;
  presenterId: string;
  presenterName: string;
  lifecycle: LiveLifecycle;
  product: Product;
  lineup: Product[];
  partialTranscript: string;
  transcriptHistory: TranscriptSegment[];
  latestCompliance: ComplianceResult | null;
  alerts: ComplianceResult[];
  coachSuggestions: CoachSuggestion[];
  coachPending: boolean;
  riskProfile: RiskProfile;
  stats: SessionStats;
  contentRevision: number;
  latestSequence: number;
  createdAt: number;
  updatedAt: number;
};

export type LiveCommand =
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'end' }
  | { type: 'stop' }
  | { type: 'select_product'; productId: string; source?: 'operator' | 'speech' }
  | { type: 'set_lineup'; productIds: string[] }
  /** Server-internal room catalog notification; external transports must reject it. */
  | { type: 'catalog_sync'; products: Product[] }
  | { type: 'set_risk_profile'; profile: RiskProfile }
  | { type: 'select_presenter'; presenterId: string }
  | { type: 'demo_transcript'; text: string; isFinal?: boolean }
  | { type: 'transcript_correct'; segmentId: string; text: string }
  | { type: 'assign_speaker'; segmentId: string; speaker: SpeakerLabel; speakerId?: string }
  | { type: 'audio'; pcm: Uint8Array; sampleRate: number; channels?: number; track?: AudioTrack };

export type LiveEventType =
  | 'session.created'
  | 'lifecycle.changed'
  | 'product.selected'
  | 'lineup.updated'
  | 'catalog.updated'
  | 'risk_profile.changed'
  | 'presenter.selected'
  | 'transcript.partial'
  | 'transcript.final'
  | 'transcript.corrected'
  | 'speaker.assigned'
  | 'compliance.updated'
  | 'coach.updated'
  | 'capture.error'
  | 'session.ended';

export type LiveEvent = {
  sessionId: string;
  sequence: number;
  type: LiveEventType;
  occurredAt: number;
  payload: Record<string, unknown>;
};

export type LiveSessionListener = (event: LiveEvent, snapshot: LiveSessionSnapshot) => void;

export type SessionSummary = {
  sessionId: string;
  tenantId: string;
  roomId: string;
  presenterId: string;
  presenterName: string;
  lifecycle: LiveLifecycle;
  createdAt: number;
  endedAt: number | null;
  contentRevision: number;
  approval: ReviewApproval;
  delivery: DeliveryStatus;
  transcriptCount: number;
  audioDurationMs: number;
  audioBytes: number;
  note: string;
};

export type ReviewTranscript = TranscriptSegment & {
  revision: number;
  originalText: string;
  note: string;
};

export type SessionReview = {
  summary: SessionSummary;
  transcripts: ReviewTranscript[];
  audioPath: string | null;
  approval: ReviewApproval;
  delivery: DeliveryStatus;
  approvedRevision: number | null;
  approvedBy: string | null;
  approvedAt: number | null;
};

export type DeliveryJob = {
  id: string;
  sessionId: string;
  contentRevision: number;
  status: DeliveryStatus;
  idempotencyKey: string;
  attemptCount: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ResourceDeliveryType = 'rule' | 'rule_unit' | 'presenter_phrase';

export type ResourceDeliveryJob = {
  id: string;
  resourceType: ResourceDeliveryType;
  resourceId: string;
  resourceVersion: number;
  target?: SyncTarget;
  approvalStatus?: 'awaiting_approval' | 'approved';
  status: DeliveryStatus;
  idempotencyKey: string;
  payload: unknown;
  attemptCount: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};
