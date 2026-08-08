import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSpeechCorrectionCatalog } from '../../server/speechCorrectionCatalog';
import { LiveSession } from '../../server/session';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('room speech correction catalog', () => {
  it('persists learned word replacements and applies the longest match first', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'speech-corrections-'));
    directories.push(directory);
    const filePath = path.join(directory, 'catalog.json');
    const catalog = new FileSpeechCorrectionCatalog(filePath, () => 1_000);

    catalog.record('room-default', {
      wrongText: '火山', correctText: '火山引擎', actorId: 'operator-a', sessionId: 'live-test-a', segmentId: 'segment-1',
    });
    const updated = catalog.record('room-default', {
      wrongText: '火山方舟', correctText: '火山引擎方舟', actorId: 'operator-a', sessionId: 'live-test-a', segmentId: 'segment-2',
    });
    catalog.record('room-default', {
      wrongText: '火山方舟', correctText: '火山引擎方舟', actorId: 'operator-b', sessionId: 'live-test-b', segmentId: 'segment-3',
    });

    expect(catalog.apply('room-default', '使用火山方舟进行识别').text).toBe('使用火山引擎方舟进行识别');
    expect(catalog.list('room-default').find((entry) => entry.id === updated.id)?.confirmations).toBe(2);

    const restored = new FileSpeechCorrectionCatalog(filePath);
    expect(restored.list('room-default')).toHaveLength(2);
    expect(restored.hotwords('room-default')).toEqual(expect.arrayContaining(['火山引擎', '火山引擎方舟']));
  });

  it('can disable a learned replacement without deleting its history', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'speech-corrections-'));
    directories.push(directory);
    const catalog = new FileSpeechCorrectionCatalog(path.join(directory, 'catalog.json'));
    const entry = catalog.record('room-default', {
      wrongText: '蓝牙卖', correctText: '蓝牙麦', actorId: 'owner', sessionId: 'live-test', segmentId: 'segment-1',
    });

    catalog.setEnabled(entry.id, false);

    expect(catalog.apply('room-default', '蓝牙卖克风').text).toBe('蓝牙卖克风');
    expect(catalog.list('room-default')[0]).toMatchObject({ enabled: false, wrongText: '蓝牙卖', correctText: '蓝牙麦' });
  });

  it('learns from a transcript edit and corrects the same recognition error next time', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'speech-corrections-'));
    directories.push(directory);
    const catalog = new FileSpeechCorrectionCatalog(path.join(directory, 'catalog.json'));
    const session = new LiveSession('live-learning-test', { speechCorrectionCatalog: catalog });
    session.ingestTranscript('请检查蓝牙卖克风');
    const segmentId = session.state.transcriptHistory[0].id;

    session.correctTranscript(segmentId, '请检查蓝牙麦克风', 'operator-a', {
      learn: true, wrongText: '蓝牙卖', correctText: '蓝牙麦',
    });
    session.ingestTranscript('现在使用蓝牙卖克风直播');

    expect(catalog.list('room-default')[0]).toMatchObject({ wrongText: '蓝牙卖', correctText: '蓝牙麦' });
    expect(session.state.transcriptHistory.at(-1)?.text).toBe('现在使用蓝牙麦克风直播');
  });
});
