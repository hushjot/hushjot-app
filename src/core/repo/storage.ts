/**
 * Storage durability.
 *
 * The plan's issue #6: Safari's ITP clears IndexedDB for non-installed sites
 * after roughly seven days without interaction. For a local-first app that is
 * silent data loss, and it is worst before the user has any cloud copy.
 *
 * `navigator.storage.persist()` asks the browser to exempt us. Chrome grants
 * it based on engagement heuristics, Firefox prompts, Safari grants it when the
 * site is installed to the home screen. It can be refused, so the honest
 * position is: *local storage is a cache, sync is the durability guarantee* —
 * and we say so in the UI when persistence is denied.
 *
 * Checking and asking are separate on purpose. `persisted()` never shows UI, so
 * it runs at startup and a user who only reads still learns their notes are at
 * risk. `persist()` can put a permission prompt on screen (Firefox), so it
 * waits for the first write — before that the user has no stake in the answer.
 */

export type StorageDurability = 'persistent' | 'best-effort' | 'unavailable';

/** What the browser has already decided, without asking it anything. */
export async function checkPersisted(): Promise<StorageDurability> {
  if (typeof navigator === 'undefined' || !navigator.storage) return 'unavailable';
  if (!navigator.storage.persisted) return 'best-effort';
  try {
    return (await navigator.storage.persisted()) ? 'persistent' : 'best-effort';
  } catch {
    return 'best-effort';
  }
}

export async function requestPersistence(): Promise<StorageDurability> {
  const already = await checkPersisted();
  if (already !== 'best-effort') return already;

  try {
    if (navigator.storage.persist) {
      const granted = await navigator.storage.persist();
      return granted ? 'persistent' : 'best-effort';
    }
    return 'best-effort';
  } catch {
    return 'best-effort';
  }
}

/**
 * True when a write failed because the origin is out of space. Browsers
 * disagree on the error shape, so match on both the modern name and the
 * legacy code.
 */
export function isQuotaExceeded(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; code?: number };
  return e.name === 'QuotaExceededError' || e.code === 22 || e.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
