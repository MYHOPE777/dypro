import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilePresenterPhraseLibrary } from '../../server/presenterPhraseLibrary';
import type { SessionTimelineExport, TimelineEvent } from '../shared/types';

function event(index: number, type: TimelineEvent['type'], payload: Record<string, unknown>, productId = 'serum'): TimelineEvent {
  return { schemaVersion: 1, id: `event-${index}`, sessionId: 'live-phrase-archive', type, occurredAt: index * 1_000, occurredAtIso: new Date(index * 1_000).toISOString(), timezone: 'Asia/Shanghai', offsetMs: index * 1_000, productId, payload };
}

describe('presenter phrase library', () => {
  it('archives corrected host speech while excluding other people', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'presenter-phrases-'));
    try {
      const library = new FilePresenterPhraseLibrary(path.join(directory, 'catalog.json'));
      const presenter = library.createPresenter({ roomId: 'room-default', accountName: '护肤账号', name: '主播小唐' });
      const timeline: SessionTimelineExport = {
        schemaVersion: 1, sessionId: 'live-phrase-archive', timezone: 'Asia/Shanghai', createdAt: 0, recordingStartedAt: null, audio: null, sourceAudio: [],
        events: [
          event(1, 'transcript.final', { segmentId: 'segment-1', text: '这款精华特别厚重', speaker: 'host' }),
          event(2, 'transcript.corrected', { segmentId: 'segment-1', originalText: '这款精华特别厚重', correctedText: '这款精华质地清爽' }),
          event(3, 'transcript.final', { segmentId: 'segment-2', text: '场控提醒还有十分钟', speaker: 'host' }),
          event(4, 'transcript.annotated', { segmentId: 'segment-2', speaker: 'other' }),
        ],
      };

      const archived = library.archiveSession(presenter.id, timeline);

      expect(archived).toEqual([
        expect.objectContaining({ presenterId: presenter.id, roomId: 'room-default', productId: 'serum', text: '这款精华质地清爽', source: 'session', status: 'draft' }),
      ]);
      expect(library.listPhrases(presenter.id)).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('versions imported or rewritten phrases and only serves selected references', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'presenter-phrase-versions-'));
    try {
      const library = new FilePresenterPhraseLibrary(path.join(directory, 'catalog.json'));
      const presenter = library.createPresenter({ roomId: 'room-default', accountName: '护肤账号', name: '主播小唐' });
      const imported = library.createPhrase(presenter.id, { productId: 'serum', purpose: '塑品', text: '头部直播间原始塑品话术', source: 'imported' });
      const rewritten = library.revise(imported.id, { text: '更符合小唐表达习惯的塑品话术', source: 'doubao' });
      const reference = library.setReference(rewritten.id, true);

      expect(reference).toMatchObject({ version: 3, status: 'reference', source: 'doubao' });
      expect(library.references(presenter.id, 'serum').map((phrase) => phrase.text)).toEqual(['更符合小唐表达习惯的塑品话术']);

      const rolledBack = library.rollback(imported.id, 1);
      expect(rolledBack).toMatchObject({ version: 4, text: '头部直播间原始塑品话术', status: 'draft' });
      expect(library.references(presenter.id, 'serum')).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
