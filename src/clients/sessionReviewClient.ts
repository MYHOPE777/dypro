import type { DeliveryJob, SessionReview, SessionSummary } from '../shared/v2';
import type { TranscriptSegment } from '../shared/types';
import { authenticatedHeaders } from './authHeaders';

export class SessionReviewClient {
  constructor(private readonly actorId = 'local-operator') {}

  async listSessions(roomId?: string): Promise<SessionSummary[]> { return this.request<SessionSummary[]>(`/api/v2/sessions${roomId ? `?roomId=${encodeURIComponent(roomId)}` : ''}`); }
  async getReview(sessionId: string): Promise<SessionReview> { return this.request<SessionReview>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/review`); }
  async correctTranscript(sessionId: string, segmentId: string, text: string): Promise<{ contentRevision: number; segment: TranscriptSegment }> { return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/transcripts/${encodeURIComponent(segmentId)}/correct`, { method: 'POST', body: JSON.stringify({ text }) }); }
  async assignSpeaker(sessionId: string, segmentId: string, speaker: 'host' | 'other', speakerId?: string, speakerName?: string): Promise<{ contentRevision: number; segment: TranscriptSegment }> { return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/transcripts/${encodeURIComponent(segmentId)}/speaker`, { method: 'POST', body: JSON.stringify({ speaker, speakerId, speakerName }) }); }
  async annotateTranscript(sessionId: string, segmentId: string, input: { selectedText: string; start: number; end: number; kind: 'term' | 'sentence' | 'context'; title?: string; reason?: string; alternative?: string; policyRef?: string }): Promise<unknown> { return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/transcripts/${encodeURIComponent(segmentId)}/annotate`, { method: 'POST', body: JSON.stringify(input) }); }
  async saveNote(sessionId: string, note: string): Promise<{ contentRevision: number; note: string }> { return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/note`, { method: 'POST', body: JSON.stringify({ note }) }); }
  async approveDelivery(sessionId: string): Promise<DeliveryJob> { return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/delivery/approve`, { method: 'POST', body: '{}' }); }
  async retryDelivery(sessionId: string): Promise<DeliveryJob> { return this.request(`/api/v2/sessions/${encodeURIComponent(sessionId)}/delivery/retry`, { method: 'POST', body: '{}' }); }
  async loadAudioUrl(sessionId: string): Promise<string> {
    const response = await fetch(`/api/v2/sessions/${encodeURIComponent(sessionId)}/audio`, { headers: authenticatedHeaders(undefined, this.actorId) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(body.message ?? '音频加载失败');
    }
    return URL.createObjectURL(await response.blob());
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = authenticatedHeaders(init.headers, this.actorId);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { ...init, headers });
    const body = await response.json().catch(() => ({})) as T & { message?: string };
    if (!response.ok) throw new Error(body.message ?? '请求失败');
    return body as T;
  }
}
