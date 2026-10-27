/**
 * Turning dropped files and zips into notes and folders (spec §24, in reverse).
 *
 * The shape is a *plan* — folders keyed by their path, notes pointing at a key —
 * rather than writes, so everything that decides what a file becomes is here
 * and tested, and the workspace only has to persist it.
 *
 * ## What is read, and what is left alone
 *
 * Text only: `.md`, `.markdown`, `.mdown`, `.txt`. The input is whatever a user
 * zipped or dragged — an Obsidian vault, a Finder "Compress" of a folder, a
 * Notesnook export — so anything else is reported as skipped, never guessed at.
 * Hidden paths (`.obsidian/`, `.DS_Store`) and the `__MACOSX/` resource forks
 * Finder adds are dropped silently: the user never saw them as files.
 *
 * A file that is not valid UTF-8, or holds a NUL byte, is binary in disguise
 * and skipped rather than imported as mojibake.
 *
 * ## Titles
 *
 * A note's title is derived from its first line (`notes/model.ts`). In a
 * folder of Markdown files — an Obsidian vault above all — the *file name* is
 * the title, and `[[Architecture]]` names `Architecture.md` whatever its first
 * line says. Dropping the name would leave every such link pointing at
 * nothing, silently.
 *
 * So a file whose first line does not already say its name gets the name as a
 * heading on top (`# Architecture`). Text exported from a first-line-is-the-
 * title app — Simplenote, HushJot itself — already matches its file name and
 * arrives byte for byte. The match is loose on purpose (case, accents and
 * punctuation ignored, and either may be a truncation of the other), because
 * exporters sanitise and shorten names, and a false "mismatch" costs a
 * duplicated heading where a false "match" costs nothing worse than today.
 * An empty file gets the heading too, or it would arrive as "Untitled".
 *
 * How many notes gained a heading is reported, so the change is never silent.
 *
 * ## Exports that carry more than their files
 *
 * A `.json` file is read too, but only so `sources.ts` can recognise the two
 * exports whose JSON is the real content — Simplenote's (tags, pins, dates)
 * and Google Keep's (everything). Any other `.json` is skipped as before.
 */
import { isZip, readZip, type ZipEntry } from './zip.ts';
import { deriveTitle } from '../notes/model.ts';
import { recogniseSources, type SourceApp } from './sources.ts';

export type { SourceApp };

export const TEXT_EXTENSIONS = ['.md', '.markdown', '.mdown', '.txt'];

export interface ImportFolder {
  /** The folder's path with a trailing `/`, e.g. `Code/Rust/`. */
  key: string;
  name: string;
  parentKey: string | null;
}

export interface ImportNote {
  content: string;
  folderKey: string | null;
  modified: number;
  /** When the other app says the note was made; absent for plain files. */
  created?: number;
  pinned?: boolean;
}

export interface ImportPlan {
  folders: ImportFolder[];
  notes: ImportNote[];
  /** Paths that were not imported, for the summary shown afterwards. */
  skipped: string[];
  /** Notes that were given their file name as a heading. */
  titledFromName: number;
  /** Apps whose export was recognised (`sources.ts`). */
  sources: SourceApp[];
  /** Notes in a recognised export's trash, left out. */
  trashed: number;
}

export function isTextPath(path: string): boolean {
  const lower = path.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isZipPath(path: string): boolean {
  return path.toLowerCase().endsWith('.zip');
}

/** Whether a picked, dropped or pasted file is something import can use. */
export function isImportable(path: string): boolean {
  return isTextPath(path) || isZipPath(path) || path.toLowerCase().endsWith('.json');
}

/**
 * Open any zips among the input, so every entry is a plain path. A zip's
 * contents are placed where the zip was: a zip at the top level restores its
 * tree at the top level, which is what re-importing an export needs.
 */
export async function expandArchives(files: readonly ZipEntry[]): Promise<{ entries: ZipEntry[]; skipped: string[] }> {
  const entries: ZipEntry[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (!isZipPath(file.path) && !(isZip(file.data) && !isTextPath(file.path))) {
      entries.push(file);
      continue;
    }
    const at = file.path.lastIndexOf('/');
    const dir = at >= 0 ? file.path.slice(0, at + 1) : '';
    for (const inner of await readZip(file.data)) {
      // A zip inside a zip is not opened: one level is what anyone makes on purpose.
      if (isZipPath(inner.path)) skipped.push(`${dir}${inner.path}`);
      else entries.push({ ...inner, path: `${dir}${inner.path}` });
    }
  }
  return { entries, skipped };
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function decodeText(data: Uint8Array): string | null {
  if (data.includes(0)) return null;
  try {
    return decoder.decode(data).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  } catch {
    return null;
  }
}

function baseName(segment: string): string {
  const dot = segment.lastIndexOf('.');
  return dot > 0 ? segment.slice(0, dot) : segment;
}

/** Letters and digits only, lower-cased and without accents: what survives any exporter. */
function comparable(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Whether a file's first line already says what its name says. */
export function titleMatchesName(content: string, name: string): boolean {
  const title = comparable(deriveTitle(content));
  const base = comparable(name);
  if (!base) return true;
  if (!title) return false;
  return title === base || title.startsWith(base) || base.startsWith(title);
}

export function planImport(input: readonly ZipEntry[]): ImportPlan {
  const folders = new Map<string, ImportFolder>();
  const notes: ImportNote[] = [];
  const recognised = recogniseSources(input);
  const files = recognised.rest;
  const skipped: string[] = [...recognised.skipped];
  let titledFromName = 0;

  const folderFor = (segments: readonly string[]): string | null => {
    let parentKey: string | null = null;
    let key = '';
    for (const name of segments) {
      key += `${name}/`;
      if (!folders.has(key)) folders.set(key, { key, name, parentKey });
      parentKey = key;
    }
    return parentKey;
  };

  for (const file of files) {
    const isDir = file.path.endsWith('/');
    const segments = file.path
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s && s !== '.' && s !== '..');
    if (segments.length === 0) continue;
    if (segments.some((s) => s.startsWith('.') || s === '__MACOSX')) continue;

    if (isDir) {
      folderFor(segments);
      continue;
    }

    const fileName = segments[segments.length - 1]!;
    if (!isTextPath(fileName)) {
      skipped.push(file.path);
      continue;
    }
    const text = decodeText(file.data);
    if (text === null) {
      skipped.push(file.path);
      continue;
    }

    const name = baseName(fileName);
    let content = text;
    if (!text.trim()) {
      content = `# ${name}\n`;
      titledFromName++;
    } else if (!titleMatchesName(text, name)) {
      content = `# ${name}\n\n${text}`;
      titledFromName++;
    }

    notes.push({
      content,
      folderKey: folderFor(segments.slice(0, -1)),
      modified: file.modified,
    });
  }

  for (const note of recognised.notes) {
    notes.push({
      content: note.content,
      folderKey: note.folder === null ? null : folderFor([note.folder]),
      modified: note.modified,
      ...(note.created !== undefined && { created: note.created }),
      ...(note.pinned && { pinned: true }),
    });
  }

  return {
    folders: [...folders.values()],
    notes,
    skipped,
    titledFromName,
    sources: recognised.sources,
    trashed: recognised.trashed,
  };
}
