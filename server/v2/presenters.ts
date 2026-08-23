import { randomUUID } from 'node:crypto';
import type { CoachPurpose, PhraseMetric, PresenterPhrase, PresenterPhraseStatus, PresenterProfile, TranscriptSegment } from '../../src/shared/types';
import { SqliteFactStore } from './store';

export class PresenterModule {
  constructor(private readonly store: SqliteFactStore, private readonly now: () => number = Date.now) {}
  ensureDefault(roomId: string): PresenterProfile { return this.store.ensurePresenter({ id: `presenter-${roomId}`, roomId, name: '默认主播', accountName: '本地账号', now: this.now() }); }
  list(roomId: string): PresenterProfile[] { return this.store.listPresenters(roomId); }
  get(presenterId: string): PresenterProfile | null { return this.store.getPresenter(presenterId); }
  create(roomId: string, name: string, accountName: string): PresenterProfile { if (!name.trim()) throw new Error('主播名称不能为空'); return this.store.ensurePresenter({ id: `presenter-${randomUUID()}`, roomId, name: name.trim(), accountName: accountName.trim() || '本地账号', now: this.now() }); }
  phrases(presenterId: string, productId?: string): PresenterPhrase[] { return this.store.listPhrases(presenterId, productId); }
  phrase(phraseId: string): PresenterPhrase | null { return this.store.getPhrase(phraseId); }
  phraseMetrics(phraseId: string): PhraseMetric[] { return this.store.listPhraseMetrics(phraseId); }
  savePhraseMetric(metric: PhraseMetric): PhraseMetric { return this.store.savePhraseMetric(metric); }
  references(presenterId: string, productId?: string): PresenterPhrase[] { return this.phrases(presenterId, productId).filter((phrase) => phrase.status === 'reference'); }

  savePhrase(input: { presenterId: string; productId?: string | null; purpose?: CoachPurpose; text: string; source?: PresenterPhrase['source']; status?: PresenterPhraseStatus; sourceSessionId?: string; sourceSegmentId?: string }): PresenterPhrase {
    const presenter = this.get(input.presenterId);
    if (!presenter || !input.text.trim()) throw new Error('主播或话术内容无效');
    const now = this.now();
    return this.store.savePhrase({ id: `phrase-${randomUUID()}`, roomId: presenter.roomId, presenterId: presenter.id, productId: input.productId ?? null, purpose: input.purpose, text: input.text.trim(), source: input.source ?? 'manual', status: input.status ?? 'draft', version: 1, sourceSessionId: input.sourceSessionId, sourceSegmentId: input.sourceSegmentId, usageCount: 0, createdAt: now, updatedAt: now });
  }

  updatePhrase(phraseId: string, patch: { text?: string; purpose?: CoachPurpose; status?: PresenterPhraseStatus }): PresenterPhrase {
    const current = this.store.getPhrase(phraseId);
    if (!current) throw new Error('话术不存在');
    const updated: PresenterPhrase = { ...current, text: patch.text?.trim() || current.text, purpose: patch.purpose ?? current.purpose, status: patch.status ?? current.status, version: current.version + 1, updatedAt: this.now() };
    return this.store.savePhrase(updated);
  }

  archiveSession(presenterId: string, sessionId: string, productId: string, segments: TranscriptSegment[]): PresenterPhrase[] {
    const existing = this.phrases(presenterId);
    return segments.filter((segment) => segment.isFinal && segment.speaker !== 'other' && segment.text.trim() && !existing.some((phrase) => phrase.sourceSessionId === sessionId && phrase.sourceSegmentId === segment.id)).map((segment) => this.savePhrase({ presenterId, productId, text: segment.text, source: 'session', status: 'draft', sourceSessionId: sessionId, sourceSegmentId: segment.id }));
  }
}
