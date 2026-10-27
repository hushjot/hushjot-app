/**
 * Crash journal.
 *
 * IndexedDB writes cannot be relied on to complete while a page is being torn
 * down. Measured directly: `pagehide` and `visibilitychange` both fire, the
 * flush starts, and the transaction never commits — the edit is gone. That is
 * §25's "user types and immediately closes tab", which the spec lists as a
 * scenario that must not lose data.
 *
 * `localStorage` is the one storage API that is *synchronous*, so a write
 * issued inside the `pagehide` handler completes before the page dies. The
 * journal holds only the note being edited, and is cleared the moment the real
 * database write succeeds — it is a safety net, never a store.
 *
 * ## What is stored
 *
 * **Ciphertext only.** Encryption is asynchronous, so the entry cannot be
 * produced during teardown; instead the caller keeps an up-to-date sealed copy
 * of the open note as the user types (Spike 4: 0.1 ms for a 10 KB note) and
 * this module writes whatever is current when the page dies. The journal can
 * therefore lag by at most one keystroke — the price of never letting plaintext
 * reach localStorage.
 *
 * The note id, revision and timestamp are stored in the clear. They are needed
 * to decide whether an entry may be replayed at all, before any key exists to
 * decrypt with. A UUID and a counter reveal nothing a database file would not.
 */
import { toBase64, fromBase64, type Bytes } from '../crypto/bytes.ts';

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
const KEY = 'teksto:journal:v2';
/** Written by Phase 2, which journalled plaintext. Removed, never read. */
const LEGACY_KEYS = ['teksto:journal:v1'];

export interface JournalEntry {
  id: string;
  revision: number;
  updatedAt: number;
  /** Sealed note content — an envelope, base64 for localStorage's string API. */
  cipher: Bytes;
}

interface StoredEntry {
  id: string;
  revision: number;
  updatedAt: number;
  cipher: string;
}

/**
 * Anything much larger than this is not worth risking a `QuotaExceededError`
 * for inside a teardown handler, where we cannot recover from one. localStorage
 * origins are typically capped around 5 MB.
 */
const MAX_CIPHER_BYTES = 400_000;

export function writeJournal(entries: readonly JournalEntry[]): void {
  try {
    const kept = entries.filter((e) => e.cipher.length <= MAX_CIPHER_BYTES);
    if (kept.length === 0) {
      localStorage.removeItem(KEY);
      return;
    }
    const stored: StoredEntry[] = kept.map((e) => ({
      id: e.id,
      revision: e.revision,
      updatedAt: e.updatedAt,
      cipher: toBase64(e.cipher),
    }));
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Storage disabled, full, or unavailable. The journal is best-effort by
    // definition; failing to write it must never break the app.
  }
}

export function readJournal(): JournalEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const out: JournalEntry[] = [];
    for (const value of parsed) {
      if (!isStored(value)) continue;
      try {
        out.push({
          id: value.id,
          revision: value.revision,
          updatedAt: value.updatedAt,
          cipher: fromBase64(value.cipher),
        });
      } catch {
        // Undecodable base64: skip the entry rather than failing the replay.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function clearJournal(): void {
  try {
    localStorage.removeItem(KEY);
    for (const legacy of LEGACY_KEYS) localStorage.removeItem(legacy);
  } catch {
    // Nothing to do; a stale journal is discarded on the next replay anyway.
  }
}

function isStored(value: unknown): value is StoredEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.revision === 'number' &&
    typeof e.updatedAt === 'number' &&
    typeof e.cipher === 'string'
  );
}

export interface ReplayDecision {
  restore: JournalEntry[];
  skipped: number;
}

/**
 * Decide what a journal is still allowed to restore.
 *
 * Two rules, both about not doing harm:
 *
 * - **Never resurrect a deleted note.** If the id is not among the notes the
 *   database returned, the user deleted it; the journal does not get a vote.
 * - **Never overwrite a newer database record.** The journal only wins when
 *   its revision is ahead, which is exactly the "the write never landed" case.
 */
export function planReplay(
  entries: readonly JournalEntry[],
  stored: ReadonlyMap<string, number>,
): ReplayDecision {
  const restore: JournalEntry[] = [];
  let skipped = 0;

  for (const entry of entries) {
    const storedRevision = stored.get(entry.id);
    if (storedRevision === undefined || entry.revision <= storedRevision) {
      skipped++;
      continue;
    }
    restore.push(entry);
  }

  return { restore, skipped };
}
