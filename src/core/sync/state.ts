/**
 * What the backend holds for one note, as far as this device knows.
 *
 * ## Why this exists
 *
 * A note carries a local `revision` that advances on every keystroke, and the
 * backend carries its own, which advances by exactly one per accepted write
 * because that is what the Firestore rules enforce. They are different numbers.
 * Pushing the local one into the backend's slot means every push that follows
 * more than a single keypress is rejected — on one device, with nobody else
 * involved — and the rejection reads as a conflict, so the note forks. Nothing
 * rebases, so it forks again on the next push, and the next.
 *
 * This record is the missing anchor: it says where the backend is, so a push
 * can send `base + 1` whatever the local counter has reached.
 *
 * ## Why the `kv` store rather than its own
 *
 * A new object store means a `DB_VERSION` bump, and `openDb` rejects on
 * `onblocked` (`../repo/idb.ts`) — which `Workspace.init` treats as "no
 * IndexedDB" and answers with an empty in-memory workspace and a storage
 * warning. A user with a second tab open would upgrade into "my notes are
 * gone". That is not a trade worth making to avoid a ~40-byte row per note in
 * a store that already holds the sync cursor.
 */
import type { NoteRepository } from '../repo/noteRepository.ts';

export interface NoteSyncState {
  /** The backend revision our local copy is derived from. Server-confirmed. */
  base: number;
  /**
   * A newer backend revision we saw but did not apply, because this note had
   * unpushed local edits at the time.
   *
   * Without it, a note that has no `base` yet would bootstrap by reading the
   * backend's *current* revision and push one past it — quietly overwriting
   * the very change we declined to apply. Recording the sighting turns that
   * silent loss into the conflict it actually is.
   *
   * One window this does not cover: a note with no `base` whose first push
   * races a backend change that no pull has seen yet. There is nothing to
   * anchor against and no way to tell "my copy descends from that one" from
   * "my copy diverges from it", so the push wins. Closing it would mean
   * forking every note that differs from the backend on the first sync after
   * upgrade, which is the behaviour this whole change exists to stop. The
   * window is one sync wide and closes for good once `base` is recorded.
   */
  seen?: number;
  /**
   * The nonce of the body ciphertext at `base` — what the backend holds, as
   * far as this device knows. Absent when `base` was learned without seeing
   * a body (the bootstrap read, or a record written before this existed).
   *
   * It answers the one question a conflict needs and the revision cannot:
   * "has the text changed here since the backend last agreed with us?" Every
   * seal draws a fresh random nonce and the engine moves ciphertext
   * byte-for-byte, so a stored body whose nonce still matches is the very
   * body the backend had — the unpushed change is metadata only (a pin, a
   * move), and there is no local text to preserve as a conflict copy.
   * Absent means unknown, and unknown is answered with a copy, as before.
   */
  bodySeal?: string;
  /**
   * The counted size of the document at `base`: `meta` plus `body`, as stored.
   * What a push tells the storage meter it is replacing (`usage.ts`). Absent on
   * a record written before the meter existed; the push then reads the
   * document once to learn it.
   */
  baseBytes?: number;
}

const key = (id: string) => `sync:note:${id}`;

export function loadSyncState(
  repo: NoteRepository,
  id: string,
): Promise<NoteSyncState | undefined> {
  return repo.get<NoteSyncState>(key(id));
}

export function saveSyncState(
  repo: NoteRepository,
  id: string,
  state: NoteSyncState,
): Promise<void> {
  return repo.set(key(id), state);
}

/**
 * The counted size of a folder's `data` as the backend last held it, from the
 * last push or pull. Folders have no `NoteSyncState`, because they have no
 * revision, so this is all they need. Absent means unknown, which a push
 * treats as a folder the backend does not have yet.
 */
const folderKey = (id: string) => `sync:folder:${id}`;

export async function loadFolderBytes(repo: NoteRepository, id: string): Promise<number | undefined> {
  return (await repo.get<{ bytes: number }>(folderKey(id)))?.bytes;
}

export function saveFolderBytes(repo: NoteRepository, id: string, bytes: number): Promise<void> {
  return repo.set(folderKey(id), { bytes });
}
