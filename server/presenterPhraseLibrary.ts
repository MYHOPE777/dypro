import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CoachPurpose, PresenterPhrase, PresenterProfile, SessionTimelineExport, SpeakerLabel } from '../src/shared/types';

export type PhraseMutationAction = 'created' | 'archived' | 'revised' | 'referenced' | 'rolled_back';
export type PhraseMutationListener = (event: { action: PhraseMutationAction; phrase: PresenterPhrase; occurredAt: number }) => void;

type PresenterInput = { roomId: string; accountName: string; name: string };
type CreatePhraseInput = { productId?: string | null; purpose?: CoachPurpose; text: string; source?: PresenterPhrase['source'] };
type RevisePhraseInput = { text: string; purpose?: CoachPurpose; source: 'manual' | 'doubao' };
type PhraseFile = {
  schemaVersion: 1;
  presenters: PresenterProfile[];
  phrases: PresenterPhrase[];
  versions: Record<string, PresenterPhrase[]>;
};

type ArchivedSegment = {
  id: string;
  text: string;
  speaker: SpeakerLabel;
  productId: string | null;
  occurredAt: number;
};

export interface PresenterPhraseLibrary {
  archiveSession(presenterId: string, timeline: SessionTimelineExport): PresenterPhrase[];
  references(presenterId: string, productId?: string): PresenterPhrase[];
  getPresenter(presenterId: string): PresenterProfile | null;
}

function clone<T>(value: T): T { return structuredClone(value); }
function emptyFile(): PhraseFile { return { schemaVersion: 1, presenters: [], phrases: [], versions: {} }; }
function stablePresenterId(input: PresenterInput): string {
  return `presenter-${createHash('sha1').update(`${input.roomId}:${input.accountName}:${input.name}`).digest('hex').slice(0, 14)}`;
}

export class FilePresenterPhraseLibrary {
  private data: PhraseFile;
  constructor(private readonly filePath = path.resolve(process.cwd(), '.data/phrases/catalog.json'), private readonly onMutation?: PhraseMutationListener) {
    this.data = this.readFile();
  }

  createPresenter(input: PresenterInput): PresenterProfile {
    const name = input.name.trim();
    const accountName = input.accountName.trim();
    if (!name || !accountName || !input.roomId.trim()) throw new Error('直播间、账号和主播名称不能为空');
    const id = stablePresenterId({ ...input, name, accountName });
    const existing = this.data.presenters.find((presenter) => presenter.id === id);
    if (existing) return clone(existing);
    const now = Date.now();
    const presenter: PresenterProfile = { id, roomId: input.roomId, accountName, name, createdAt: now, updatedAt: now };
    this.data.presenters.push(presenter);
    this.writeFile();
    return clone(presenter);
  }

  listPresenters(roomId: string): PresenterProfile[] {
    return clone(this.data.presenters.filter((presenter) => presenter.roomId === roomId));
  }

  getPresenter(presenterId: string): PresenterProfile | null {
    return clone(this.data.presenters.find((presenter) => presenter.id === presenterId) ?? null);
  }

  listPhrases(presenterId: string): PresenterPhrase[] {
    return clone(this.data.phrases.filter((phrase) => phrase.presenterId === presenterId).sort((first, second) => second.updatedAt - first.updatedAt));
  }

  getPhrase(phraseId: string): PresenterPhrase | null {
    return clone(this.data.phrases.find((phrase) => phrase.id === phraseId) ?? null);
  }

  references(presenterId: string, productId?: string): PresenterPhrase[] {
    return clone(this.data.phrases
      .filter((phrase) => phrase.presenterId === presenterId && phrase.status === 'reference' && (!productId || phrase.productId === null || phrase.productId === productId))
      .sort((first, second) => second.updatedAt - first.updatedAt));
  }

  createPhrase(presenterId: string, input: CreatePhraseInput): PresenterPhrase {
    const presenter = this.requirePresenter(presenterId);
    const text = this.validateText(input.text);
    const now = Date.now();
    const phrase: PresenterPhrase = {
      id: `phrase-${randomUUID()}`,
      roomId: presenter.roomId,
      presenterId,
      productId: input.productId ?? null,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      text,
      source: input.source ?? 'manual',
      status: 'draft',
      version: 1,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.data.phrases.push(phrase);
    this.data.versions[phrase.id] = [clone(phrase)];
    this.writeFile();
    this.notify('created', phrase);
    return clone(phrase);
  }

  revise(phraseId: string, input: RevisePhraseInput): PresenterPhrase {
    const current = this.requirePhrase(phraseId);
    const next: PresenterPhrase = {
      ...current,
      text: this.validateText(input.text),
      ...(input.purpose ? { purpose: input.purpose } : {}),
      source: input.source,
      status: 'draft',
      version: current.version + 1,
      updatedAt: Date.now(),
    };
    return this.saveVersion(next, 'revised');
  }

  setReference(phraseId: string, selected: boolean): PresenterPhrase {
    const current = this.requirePhrase(phraseId);
    const next: PresenterPhrase = { ...current, status: selected ? 'reference' : 'draft', version: current.version + 1, updatedAt: Date.now() };
    return this.saveVersion(next, 'referenced');
  }

  rollback(phraseId: string, targetVersion: number): PresenterPhrase {
    const current = this.requirePhrase(phraseId);
    const target = (this.data.versions[phraseId] ?? []).find((version) => version.version === targetVersion);
    if (!target) throw new Error('目标话术版本不存在');
    const next: PresenterPhrase = { ...target, version: current.version + 1, updatedAt: Date.now() };
    return this.saveVersion(next, 'rolled_back');
  }

  versions(phraseId: string): PresenterPhrase[] {
    return clone(this.data.versions[phraseId] ?? []);
  }

  archiveSession(presenterId: string, timeline: SessionTimelineExport): PresenterPhrase[] {
    const presenter = this.requirePresenter(presenterId);
    const segments = new Map<string, ArchivedSegment>();
    for (const event of timeline.events) {
      if (event.type === 'transcript.final') {
        const id = typeof event.payload.segmentId === 'string' ? event.payload.segmentId : '';
        const text = typeof event.payload.text === 'string' ? event.payload.text.trim() : '';
        if (id && text) segments.set(id, { id, text, speaker: event.payload.speaker === 'other' ? 'other' : 'host', productId: event.productId, occurredAt: event.occurredAt });
      }
      if (event.type === 'transcript.corrected') {
        const id = typeof event.payload.segmentId === 'string' ? event.payload.segmentId : '';
        const text = typeof event.payload.correctedText === 'string' ? event.payload.correctedText.trim() : '';
        const segment = segments.get(id);
        if (segment && text) segments.set(id, { ...segment, text });
      }
      if (event.type === 'transcript.annotated') {
        const id = typeof event.payload.segmentId === 'string' ? event.payload.segmentId : '';
        const segment = segments.get(id);
        if (segment) segments.set(id, { ...segment, speaker: event.payload.speaker === 'other' ? 'other' : 'host' });
      }
    }
    const archived: PresenterPhrase[] = [];
    const newlyArchived: PresenterPhrase[] = [];
    for (const segment of segments.values()) {
      if (segment.speaker !== 'host') continue;
      const duplicate = this.data.phrases.find((phrase) => phrase.sourceSessionId === timeline.sessionId && phrase.sourceSegmentId === segment.id);
      if (duplicate) {
        archived.push(duplicate);
        continue;
      }
      const phrase: PresenterPhrase = {
        id: `phrase-${randomUUID()}`,
        roomId: presenter.roomId,
        presenterId,
        productId: segment.productId,
        text: segment.text,
        source: 'session',
        status: 'draft',
        version: 1,
        sourceSessionId: timeline.sessionId,
        sourceSegmentId: segment.id,
        usageCount: 0,
        createdAt: segment.occurredAt,
        updatedAt: segment.occurredAt,
      };
      this.data.phrases.push(phrase);
      this.data.versions[phrase.id] = [clone(phrase)];
      archived.push(phrase);
      newlyArchived.push(phrase);
    }
    if (archived.length > 0) this.writeFile();
    for (const phrase of newlyArchived) this.notify('archived', phrase);
    return clone(archived);
  }

  private requirePresenter(presenterId: string): PresenterProfile {
    const presenter = this.data.presenters.find((candidate) => candidate.id === presenterId);
    if (!presenter) throw new Error('主播档案不存在');
    return presenter;
  }

  private requirePhrase(phraseId: string): PresenterPhrase {
    const phrase = this.data.phrases.find((candidate) => candidate.id === phraseId);
    if (!phrase) throw new Error('话术不存在');
    return phrase;
  }

  private validateText(value: string): string {
    const text = value.trim();
    if (!text) throw new Error('话术内容不能为空');
    if (text.length > 2_000) throw new Error('单条话术不能超过 2000 个字符');
    return text;
  }

  private saveVersion(next: PresenterPhrase, action: PhraseMutationAction): PresenterPhrase {
    const index = this.data.phrases.findIndex((candidate) => candidate.id === next.id);
    if (index < 0) throw new Error('话术不存在');
    this.data.phrases[index] = next;
    this.data.versions[next.id] = [...(this.data.versions[next.id] ?? []), clone(next)];
    this.writeFile();
    this.notify(action, next);
    return clone(next);
  }

  private notify(action: PhraseMutationAction, phrase: PresenterPhrase): void {
    try { this.onMutation?.({ action, phrase: clone(phrase), occurredAt: Date.now() }); } catch {
      // Phrase syncing is best effort and never blocks local archive or live coaching.
    }
  }

  private readFile(): PhraseFile {
    if (!existsSync(this.filePath)) return emptyFile();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PhraseFile;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.presenters) && Array.isArray(parsed.phrases) && parsed.versions) return parsed;
    } catch {
      // Keep the live workflow available when local phrase storage is unreadable.
    }
    return emptyFile();
  }

  private writeFile(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}
