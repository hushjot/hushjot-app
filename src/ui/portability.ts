/**
 * Export and import, as the browser sees them: files in, downloads out.
 *
 * Reached only by dynamic import — from the dialog, the drop handler and the
 * export commands — so none of it, nor the zip code beneath it, is on the
 * critical path (§28). The decisions about what a file becomes live in
 * `core/portability/`; this module reads bytes and hands out blobs.
 *
 * ## Why an export is a download and never a share or an upload
 *
 * It is the one place decrypted text deliberately leaves the app (§24), so it
 * goes exactly where the user pointed it and nowhere else: a blob URL, a
 * `download` link, revoked shortly after. `docs/security.md` § "Export and
 * import" has the rest.
 *
 * `share.ts` publishes a note to a URL, which looks like a contradiction and
 * is not. The distinction is what leaves, not where it goes: an export is
 * **plaintext** — that is the whole point of it, since §24 is about lock-in —
 * so the only safe destination is a disk the user named. A share is
 * **ciphertext under a key that never reaches the network**, because the key
 * rides in a URL fragment and browsers do not transmit those. What the backend
 * receives is no more readable than a synced note. Different object, different
 * rule; there is still no upload of anything anyone but the user can read.
 *
 * ## Dropped folders
 *
 * `DataTransfer.files` flattens a dropped folder into nothing useful, so the
 * drop handler grabs `webkitGetAsEntry()` handles *synchronously* — they are
 * gone once the event returns — and this module walks them. Chrome, Safari and
 * Firefox all implement it under that name.
 */
import { workspace } from './state/workspace.svelte.ts';
import { planExport, noteFileName, safeName } from '../core/portability/exportTree.ts';
import { expandArchives, isImportable, planImport, type SourceApp } from '../core/portability/importTree.ts';
import { writeZip, MAX_TOTAL_BYTES, ZipError, type ZipEntry } from '../core/portability/zip.ts';
import { folderPath } from '../core/notes/folders.ts';
import { recordFullExport } from './backupReminder.ts';

/** What a drop, paste or file picker produced, captured before the event ends. */
export interface ImportSource {
  entries: readonly (FileSystemEntry | null)[];
  files: readonly File[];
}

export interface ImportResult {
  notes: number;
  folders: number;
  skipped: string[];
  /** Notes given their file name as a heading, so links to them still resolve. */
  titledFromName: number;
  /** Other apps' exports recognised, and how many of their trashed notes were left out. */
  sources: SourceApp[];
  trashed: number;
  firstNoteId: string | null;
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoked late: Safari starts the download after the click handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Download every note, or one folder's subtree, as a zip. Returns the note count. */
export async function exportZip(
  folderId: string | null,
  onProgress?: (done: number, total: number) => void,
): Promise<{ fileName: string; notes: number }> {
  const { folders, notes } = await workspace.exportSnapshot(folderId, onProgress);
  const entries = planExport(folders, notes, folderId);
  const label = folderId ? ` – ${safeName(folderPath(folders, folderId, ' - '))}` : '';
  const fileName = `HushJot${label} ${today()}.zip`;
  download(fileName, new Blob([writeZip(entries) as BlobPart], { type: 'application/zip' }));
  if (folderId === null) recordFullExport();
  return { fileName, notes: notes.length };
}

/** Download one note as `<title>.md`. */
export async function exportNote(id: string): Promise<string> {
  const title = workspace.metaById(id)?.title ?? 'Untitled';
  const fileName = noteFileName(title);
  const body = await workspace.bodyOf(id);
  download(fileName, new Blob([body], { type: 'text/markdown;charset=utf-8' }));
  return fileName;
}

function readEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // `readEntries` answers in pages (100 in Chrome) until it returns none.
    const next = () =>
      reader.readEntries((page) => {
        if (page.length === 0) return resolve(all);
        all.push(...page);
        next();
      }, reject);
    next();
  });
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, out: { path: string; file: File }[], skipped: string[]): Promise<void> {
  const path = entry.fullPath.replace(/^\/+/, '');
  // `.obsidian/`, `.git/`, `.DS_Store`: never seen as content, so never read or reported.
  if (entry.name.startsWith('.') || entry.name === '__MACOSX') return;
  if (entry.isDirectory) {
    const children = await readEntries(entry as FileSystemDirectoryEntry);
    if (children.length === 0) out.push({ path: `${path}/`, file: new File([], '') });
    for (const child of children) await walk(child, out, skipped);
  } else if (isImportable(entry.name)) {
    out.push({ path, file: await fileOf(entry as FileSystemFileEntry) });
  } else {
    skipped.push(path);
  }
}

/** Every importable file in a source, read into memory, plus what was passed over. */
async function collect(source: ImportSource): Promise<{ files: ZipEntry[]; skipped: string[] }> {
  const found: { path: string; file: File }[] = [];
  const skipped: string[] = [];

  const entries = source.entries.filter((e): e is FileSystemEntry => e !== null);
  if (entries.length > 0) {
    for (const entry of entries) await walk(entry, found, skipped);
  } else {
    for (const file of source.files) {
      // A folder picked with `webkitdirectory` keeps its layout here.
      const path = file.webkitRelativePath || file.name;
      if (isImportable(path)) found.push({ path, file });
      else if (!file.name.startsWith('.')) skipped.push(path);
    }
  }

  let total = 0;
  const files: ZipEntry[] = [];
  for (const { path, file } of found) {
    total += file.size;
    if (total > MAX_TOTAL_BYTES) throw new ZipError('That is too much to import at once (over 200 MB).');
    files.push({ path, data: new Uint8Array(await file.arrayBuffer()), modified: file.lastModified });
  }
  return { files, skipped };
}

/** Count what a source holds without reading it, for the "ready to import" line. */
export function describeSource(source: ImportSource): string {
  const items = source.entries.some((e) => e !== null)
    ? source.entries.filter((e): e is FileSystemEntry => e !== null).map((e) => ({ name: e.name, dir: e.isDirectory }))
    : source.files.map((f) => ({ name: f.webkitRelativePath || f.name, dir: false }));
  if (items.length === 1) return `“${items[0]!.name.split('/').pop()}”`;
  const dirs = items.filter((i) => i.dir).length;
  const files = items.length - dirs;
  const parts = [];
  if (files) parts.push(`${files} file${files === 1 ? '' : 's'}`);
  if (dirs) parts.push(`${dirs} folder${dirs === 1 ? '' : 's'}`);
  return parts.join(' and ');
}

export async function importSource(
  source: ImportSource,
  intoFolderId: string | null,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const collected = await collect(source);
  const expanded = await expandArchives(collected.files);
  const plan = planImport(expanded.entries);
  const skipped = [...collected.skipped, ...expanded.skipped, ...plan.skipped];

  if (plan.notes.length === 0 && plan.folders.length === 0) {
    return { notes: 0, folders: 0, skipped, titledFromName: 0, sources: plan.sources, trashed: plan.trashed, firstNoteId: null };
  }
  const written = await workspace.importNotes(plan, intoFolderId, onProgress);
  return { ...written, skipped, titledFromName: plan.titledFromName, sources: plan.sources, trashed: plan.trashed };
}
