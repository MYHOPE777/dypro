import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SpeechCorrectionEntry } from '../src/shared/types';

type CorrectionInput = {
  wrongText: string;
  correctText: string;
  actorId: string;
  sessionId: string;
  segmentId: string;
};

type CorrectionFile = {
  schemaVersion: 1;
  entries: SpeechCorrectionEntry[];
};

export interface SpeechCorrectionCatalog {
  list(roomId: string): SpeechCorrectionEntry[];
  getById(entryId: string): SpeechCorrectionEntry | null;
  record(roomId: string, input: CorrectionInput): SpeechCorrectionEntry;
  setEnabled(entryId: string, enabled: boolean): SpeechCorrectionEntry;
  apply(roomId: string, text: string): { text: string; applied: SpeechCorrectionEntry[] };
  hotwords(roomId: string): string[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyFile(): CorrectionFile {
  return { schemaVersion: 1, entries: [] };
}

function assertRoomId(roomId: string): void {
  if (!/^room-[a-z0-9-]{4,64}$/u.test(roomId)) throw new Error('invalid room id');
}

function normalizedPair(input: CorrectionInput): CorrectionInput {
  const wrongText = input.wrongText.trim();
  const correctText = input.correctText.trim();
  if (!wrongText || !correctText) throw new Error('错误词和正确词不能为空');
  if (wrongText === correctText) throw new Error('错误词和正确词不能相同');
  if (wrongText.length > 80 || correctText.length > 80) throw new Error('单条语音纠错不能超过 80 个字符');
  return {
    wrongText,
    correctText,
    actorId: input.actorId.trim() || 'owner',
    sessionId: input.sessionId,
    segmentId: input.segmentId,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function deriveSpeechCorrection(originalText: string, correctedText: string): { wrongText: string; correctText: string } | null {
  const original = [...originalText.trim()];
  const corrected = [...correctedText.trim()];
  if (original.join('') === corrected.join('')) return null;
  let prefix = 0;
  while (prefix < original.length && prefix < corrected.length && original[prefix] === corrected[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < original.length - prefix
    && suffix < corrected.length - prefix
    && original[original.length - 1 - suffix] === corrected[corrected.length - 1 - suffix]
  ) suffix += 1;
  const wrongText = original.slice(prefix, original.length - suffix).join('').trim();
  const correctText = corrected.slice(prefix, corrected.length - suffix).join('').trim();
  return wrongText && correctText && wrongText !== correctText ? { wrongText, correctText } : null;
}

export class FileSpeechCorrectionCatalog implements SpeechCorrectionCatalog {
  private data: CorrectionFile;

  constructor(
    private readonly filePath = path.resolve(process.cwd(), '.data/speech-corrections/catalog.json'),
    private readonly now: () => number = Date.now,
  ) {
    this.data = this.readFile();
  }

  list(roomId: string): SpeechCorrectionEntry[] {
    assertRoomId(roomId);
    return clone(this.data.entries.filter((entry) => entry.roomId === roomId).sort((first, second) => second.updatedAt - first.updatedAt));
  }

  getById(entryId: string): SpeechCorrectionEntry | null {
    return clone(this.data.entries.find((entry) => entry.id === entryId) ?? null);
  }

  record(roomId: string, input: CorrectionInput): SpeechCorrectionEntry {
    assertRoomId(roomId);
    const normalized = normalizedPair(input);
    const occurredAt = this.now();
    const existingIndex = this.data.entries.findIndex((entry) => entry.roomId === roomId && entry.wrongText === normalized.wrongText);
    if (existingIndex >= 0) {
      const existing = this.data.entries[existingIndex];
      const updated: SpeechCorrectionEntry = {
        ...existing,
        correctText: normalized.correctText,
        enabled: true,
        confirmations: existing.confirmations + 1,
        updatedAt: occurredAt,
        lastSessionId: normalized.sessionId,
        lastSegmentId: normalized.segmentId,
      };
      this.data.entries[existingIndex] = updated;
      this.writeFile();
      return clone(updated);
    }
    const entry: SpeechCorrectionEntry = {
      id: `speech-correction-${randomUUID()}`,
      roomId,
      wrongText: normalized.wrongText,
      correctText: normalized.correctText,
      enabled: true,
      confirmations: 1,
      createdBy: normalized.actorId,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      lastSessionId: normalized.sessionId,
      lastSegmentId: normalized.segmentId,
    };
    this.data.entries.push(entry);
    this.writeFile();
    return clone(entry);
  }

  setEnabled(entryId: string, enabled: boolean): SpeechCorrectionEntry {
    const index = this.data.entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) throw new Error('语音纠错记录不存在');
    const entry = { ...this.data.entries[index], enabled, updatedAt: this.now() };
    this.data.entries[index] = entry;
    this.writeFile();
    return clone(entry);
  }

  apply(roomId: string, text: string): { text: string; applied: SpeechCorrectionEntry[] } {
    const entries = this.list(roomId)
      .filter((entry) => entry.enabled && text.includes(entry.wrongText))
      .sort((first, second) => second.wrongText.length - first.wrongText.length || second.updatedAt - first.updatedAt);
    if (entries.length === 0) return { text, applied: [] };
    const replacements = new Map(entries.map((entry) => [entry.wrongText, entry.correctText]));
    const pattern = new RegExp(entries.map((entry) => escapeRegExp(entry.wrongText)).join('|'), 'gu');
    return { text: text.replace(pattern, (match) => replacements.get(match) ?? match), applied: entries };
  }

  hotwords(roomId: string): string[] {
    return [...new Set(this.list(roomId).filter((entry) => entry.enabled).map((entry) => entry.correctText))].slice(0, 20);
  }

  private readFile(): CorrectionFile {
    if (!existsSync(this.filePath)) return emptyFile();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as CorrectionFile;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.entries)) return parsed;
    } catch {
      // Keep local capture available when the correction file is incomplete.
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
