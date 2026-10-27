/**
 * Exports from other apps whose files are not the whole story (spec §24).
 *
 * Most apps export a folder of Markdown, and `importTree.ts` reads that as it
 * is. Two that people actually leave do not:
 *
 * - **Simplenote** writes a `.txt` per note, but its tags, pins and dates are
 *   only in `source/notes.json`. Reading the text files alone loses all three.
 * - **Google Keep** (via Google Takeout) writes a `.json` and an `.html` per
 *   note and no text at all, so without this nothing would be imported.
 *
 * When one is recognised, its JSON is the source of truth and the files it
 * duplicates (Simplenote's `.txt`, Keep's `.html` and `Labels.txt`) are
 * dropped without being reported, because nothing in them is lost. Anything
 * else beside it — attachments above all — goes on through the generic path
 * and is reported as skipped as before.
 *
 * ## What a note becomes
 *
 * Tags and labels become inline `#tags` on a last line, because that is what a
 * tag *is* here (`notes/tags.ts`), so they survive the next export too. A tag
 * the note already says is not repeated, and a name `#tag` syntax cannot hold
 * (spaces, punctuation, a bare number, a colour) is reshaped rather than
 * dropped: `to do` becomes `#to-do`, `2024` becomes `#tag-2024`. Keep's title
 * becomes a `# heading`, its checklists `- [ ]` items. Pins and the created and
 * modified dates are carried as fields for `Workspace.importNotes`.
 *
 * Standard Notes is not recognised, but its backup's own JSON file (named
 * `.txt`) is held back and listed, so the plain-text notes beside it import
 * through the generic path without one giant note of JSON among them.
 *
 * Trashed notes are left out and counted, so the summary can say so; a Keep
 * note with no title and no text (a photo on its own) is left out too, and its
 * attachments are what the summary lists.
 *
 * ## Trust
 *
 * The JSON is parsed with `JSON.parse` and only string, number and boolean
 * fields of the expected names are read. A file that does not parse or does
 * not have the shape is not recognised, and falls through to being skipped.
 */
import type { ZipEntry } from './zip.ts';
import { extractTags, normaliseTag, MAX_TAG_LENGTH } from '../notes/tags.ts';

export type SourceApp = 'simplenote' | 'google-keep';

/** A note from a recognised export; `folder` is a path under the import root, or null. */
export interface SourceNote {
  content: string;
  folder: string | null;
  modified: number;
  created: number | undefined;
  pinned: boolean;
}

export interface Recognised {
  /** The entries no recogniser claimed, for the generic path. */
  rest: ZipEntry[];
  notes: SourceNote[];
  sources: SourceApp[];
  /** Notes in the other app's trash, left out. */
  trashed: number;
  /** Notes with nothing to import (Keep photo-only notes), by file path. */
  skipped: string[];
}

const decoder = new TextDecoder('utf-8', { fatal: true });

const STANDARD_NOTES_BACKUP = 'Standard Notes Backup and Import File.txt';

function parseJson(entry: ZipEntry): unknown {
  try {
    return JSON.parse(decoder.decode(entry.data).replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at >= 0 ? path.slice(0, at + 1) : '';
}

function baseOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** A date as either app writes it: an ISO string, or a number in the given unit. */
function time(value: unknown, unitMs: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value * unitMs);
  if (typeof value === 'string') {
    const n = /^\d+$/.test(value) ? Number(value) * unitMs : Date.parse(value);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

/**
 * The `#tag` a foreign tag name becomes, or null when nothing of it survives.
 * Exported for the tests.
 */
export function asTag(name: string): string | null {
  let label = name
    .trim()
    .replace(/[^\p{L}\p{N}_/-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
    .slice(0, MAX_TAG_LENGTH);
  if (!label) return null;
  if (normaliseTag(label) !== label) label = `tag-${label}`.slice(0, MAX_TAG_LENGTH);
  return normaliseTag(label) === label ? label : null;
}

/** `content` with a last line of the tags it does not already have. */
export function withTags(content: string, names: readonly string[]): string {
  const have = new Set(extractTags(content).map((t) => t.key));
  const add: string[] = [];
  for (const name of names) {
    const tag = asTag(name);
    if (!tag || have.has(tag.toLowerCase())) continue;
    have.add(tag.toLowerCase());
    add.push(`#${tag}`);
  }
  if (add.length === 0) return content;
  const body = content.replace(/\s+$/, '');
  return body ? `${body}\n\n${add.join(' ')}\n` : `${add.join(' ')}\n`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Simplenote: `source/notes.json` with `activeNotes` (and usually `trashedNotes`). */
function simplenote(entry: ZipEntry, json: unknown): { notes: SourceNote[]; trashed: number; root: string } | null {
  if (!isRecord(json) || !Array.isArray(json.activeNotes)) return null;
  if (!entry.path.toLowerCase().endsWith('notes.json')) return null;
  const notes: SourceNote[] = [];
  for (const raw of json.activeNotes) {
    if (!isRecord(raw) || typeof raw.content !== 'string') continue;
    const content = raw.content.replace(/\r\n?/g, '\n');
    const modified = time(raw.lastModified, 1000) ?? entry.modified;
    notes.push({
      content: withTags(content, strings(raw.tags)),
      folder: null,
      modified,
      created: time(raw.creationDate, 1000),
      pinned: raw.pinned === true || strings(raw.systemTags).includes('pinned'),
    });
  }
  const trashed = Array.isArray(json.trashedNotes) ? json.trashedNotes.length : 0;
  const dir = dirOf(entry.path);
  const root = dir.toLowerCase().endsWith('source/') ? dir.slice(0, -'source/'.length) : dir;
  return { notes, trashed, root };
}

interface KeepNote {
  note: SourceNote | null;
  trashed: boolean;
  attachments: string[];
}

/** Google Keep (Takeout): one `.json` per note, recognised by its shape. */
function googleKeep(entry: ZipEntry, json: unknown): KeepNote | null {
  if (!isRecord(json) || typeof json.isTrashed !== 'boolean' || json.userEditedTimestampUsec === undefined) return null;
  if (typeof json.textContent !== 'string' && !Array.isArray(json.listContent) && typeof json.title !== 'string') return null;

  const dir = dirOf(entry.path);
  const attachments = (Array.isArray(json.attachments) ? json.attachments : [])
    .map((a) => (isRecord(a) && typeof a.filePath === 'string' ? `${dir}${a.filePath}` : null))
    .filter((p): p is string => p !== null);
  if (json.isTrashed) return { note: null, trashed: true, attachments };

  const title = typeof json.title === 'string' ? json.title.trim() : '';
  const lines: string[] = [];
  if (typeof json.textContent === 'string' && json.textContent.trim()) {
    lines.push(json.textContent.replace(/\r\n?/g, '\n').replace(/\s+$/, ''));
  }
  if (Array.isArray(json.listContent)) {
    const items = json.listContent
      .filter(isRecord)
      .map((item) => `- [${item.isChecked === true ? 'x' : ' '}] ${String(item.text ?? '').replace(/\s+/g, ' ').trim()}`);
    if (items.length) lines.push(items.join('\n'));
  }
  // Links Keep saved beside the note (a pasted URL's preview card).
  if (Array.isArray(json.annotations)) {
    const links = json.annotations
      .filter(isRecord)
      .map((a) => (typeof a.url === 'string' && a.url ? `- [${String(a.title || a.url).replace(/[[\]]/g, '')}](${a.url})` : null))
      .filter((l): l is string => l !== null);
    if (links.length) lines.push(links.join('\n'));
  }
  if (!title && lines.length === 0) return { note: null, trashed: false, attachments };

  const body = [title ? `# ${title}` : '', ...lines].filter(Boolean).join('\n\n');
  const labels = (Array.isArray(json.labels) ? json.labels : [])
    .map((l) => (isRecord(l) && typeof l.name === 'string' ? l.name : null))
    .filter((n): n is string => n !== null);
  return {
    note: {
      content: withTags(`${body}\n`, labels),
      folder: json.isArchived === true ? 'Archive' : null,
      modified: time(json.userEditedTimestampUsec, 1 / 1000) ?? entry.modified,
      created: time(json.createdTimestampUsec, 1 / 1000),
      pinned: json.isPinned === true,
    },
    trashed: false,
    attachments,
  };
}

/** Pull recognised exports out of `entries`; everything else is passed on untouched. */
export function recogniseSources(entries: readonly ZipEntry[]): Recognised {
  const notes: SourceNote[] = [];
  const sources = new Set<SourceApp>();
  const claimed = new Set<string>();
  const simplenoteRoots: string[] = [];
  const keepDirs = new Set<string>();
  const keepBases = new Set<string>();
  const skipped: string[] = [];
  let trashed = 0;

  for (const entry of entries) {
    if (!entry.path.toLowerCase().endsWith('.json')) continue;
    const json = parseJson(entry);
    if (json === undefined) continue;

    const sn = simplenote(entry, json);
    if (sn) {
      sources.add('simplenote');
      claimed.add(entry.path);
      simplenoteRoots.push(sn.root);
      notes.push(...sn.notes);
      trashed += sn.trashed;
      continue;
    }

    const keep = googleKeep(entry, json);
    if (keep) {
      sources.add('google-keep');
      claimed.add(entry.path);
      keepDirs.add(dirOf(entry.path));
      keepBases.add(`${dirOf(entry.path)}${baseOf(entry.path)}`);
      if (keep.trashed) trashed++;
      if (keep.note) notes.push(keep.note);
      else if (!keep.trashed) skipped.push(entry.path);
      // A trashed note's photos are not reported: the note was left out on purpose.
      if (keep.trashed) for (const path of keep.attachments) claimed.add(path);
    }
  }

  const rest = entries.filter((entry) => {
    if (claimed.has(entry.path)) return false;
    // Standard Notes' decrypted backup is one JSON document named `.txt`; read
    // as text it would arrive as a single unreadable note. Its notes are the
    // plain-text files beside it.
    if (entry.path.slice(entry.path.lastIndexOf('/') + 1) === STANDARD_NOTES_BACKUP) {
      skipped.push(entry.path);
      return false;
    }
    const lower = entry.path.toLowerCase();
    // Simplenote's per-note text files repeat notes.json, trash included.
    if (simplenoteRoots.some((root) => lower.startsWith(`${root}notes/`.toLowerCase()) && lower.endsWith('.txt'))) {
      return false;
    }
    const dir = dirOf(entry.path);
    if (keepDirs.has(dir)) {
      if (lower.endsWith('.html') && keepBases.has(`${dir}${baseOf(entry.path)}`)) return false;
      if (lower === `${dir}labels.txt`.toLowerCase()) return false;
    }
    return true;
  });

  return { rest, notes, sources: [...sources], trashed, skipped };
}
