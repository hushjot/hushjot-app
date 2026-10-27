/**
 * What the sync engine needs from note history, and nothing more.
 *
 * The engine moves ciphertext and never holds the key; this interface keeps it
 * that way for versions too. It hands over stored records to upload and takes
 * back which ones landed, and it can ask for a local copy of a note that a
 * remote tombstone is about to erase. It never sees text.
 */
import type { RawNote } from '../repo/noteRepository.ts';
import type { VersionRecord } from './record.ts';

export interface HistoryOutbox {
  /**
   * Versions waiting to upload, oldest capture first, bounded by count and by
   * total bytes. Versions that would expire before the backend could keep them
   * are retired to `local` rather than returned.
   */
  pending(maxCount: number, maxBytes: number): Promise<VersionRecord[]>;
  /** One note's versions still waiting to upload. */
  pendingFor(noteId: string): Promise<VersionRecord[]>;
  /** The backend has these (written now, or already there). */
  markPushed(ids: readonly string[]): Promise<void>;
  /** These will never be uploaded: refused, or belonging to another account. */
  markLocal(ids: readonly string[]): Promise<void>;
  /** Retire every waiting upload. Used when the database belongs to another account. */
  retireAll(): Promise<void>;
  /**
   * Keep a copy of a note a remote tombstone is about to erase from this
   * device, so Recently deleted can still offer it here. Not uploaded: the text
   * is what the backend already held.
   */
  mirror(row: RawNote): Promise<void>;
}
