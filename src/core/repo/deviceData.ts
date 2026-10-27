/**
 * "Remove all data from this device": the half that is not a database.
 *
 * Deleting the two IndexedDB databases (`vaultStorage.clearAll()`) takes the
 * notes, the folders, the note history, the key record and the device key with
 * it. What it cannot reach is `localStorage`, which holds the crash journal and
 * every per-device preference — and those are the things a borrowed machine
 * still shows the next person: the tile layout, which notes were open, which
 * folders were expanded.
 *
 * **Scanned by prefix, not listed by name.** Eleven keys exist today, written
 * by eight different modules, and none of them knows this function exists. A
 * hard-coded list is a list that is wrong the first time somebody adds a
 * preference, and the failure is silent — a reset that quietly leaves one key
 * behind looks exactly like a reset that worked. The prefix is the only thing
 * every key provably shares.
 *
 * The prefix itself is frozen at the original product name: see
 * `docs/security.md` § "Frozen identifiers". Renaming it here would orphan
 * every key already written rather than clear it.
 *
 * Two `teksto:` names are deliberately *not* storage and so are unaffected:
 * `teksto:sync` is a BroadcastChannel and `teksto:sync-leader` is a Web Lock
 * (`core/sync/tabs.ts`).
 */

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
export const DEVICE_KEY_PREFIX = 'teksto:';

/**
 * Remove every per-device key this app has written to `localStorage`.
 *
 * Collected before deleting, because removing during the scan renumbers the
 * indices `key(i)` walks and would skip every second match.
 *
 * Best-effort: a browser that refuses `localStorage` (Safari in private mode,
 * some embedded webviews) has nothing here to clear, and throwing would abort
 * a reset whose destructive half has already happened.
 */
export function clearDevicePreferences(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(DEVICE_KEY_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    // Nothing usable to do, and nothing left worth failing the reset over.
  }
}
