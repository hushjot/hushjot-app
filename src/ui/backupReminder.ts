/**
 * The backup reminder: a local-only device holds the only copy of its notes,
 * and a syncing one holds a copy that a bad edit or a lost vault can take
 * with it.
 *
 * The durability banner covers a browser that has *not* granted persistent
 * storage. A browser that has (Chrome often does, silently) never shows it,
 * yet clearing browsing data still deletes everything. And sync is a second
 * copy, not a backup (terms §9). So every device is asked to export: first
 * three days after it was first seen, then every 30 days, counted from the
 * later of the last full export and the last dismissal.
 *
 * The first ask is early on purpose. A device that has never exported holds
 * its only copy from the first note, and a 30-day first wait left exactly the
 * newest users — the ones least likely to know that clearing site data erases
 * everything — unprotected for a month. Three days rather than at once: the
 * first session is for writing, and a backup prompt before there is anything
 * worth backing up is noise.
 *
 * The clock starts the first time an *unlocked* app asks (`App.svelte`), not
 * on page load, so a locked or freshly wiped device writes nothing.
 *
 * localStorage, under the `teksto:` prefix, so "Remove all data from this
 * device" clears these with every other preference (`core/repo/deviceData.ts`).
 */

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
const LAST_EXPORT_KEY = 'teksto:last-export-at';
const SNOOZED_KEY = 'teksto:backup-reminder-snoozed-at';
const FIRST_SEEN_KEY = 'teksto:backup-reminder-since';

export const BACKUP_REMINDER_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a device that has never exported or dismissed waits for its first ask. */
export const FIRST_BACKUP_REMINDER_MS = 3 * 24 * 60 * 60 * 1000;

function read(key: string): number | null {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function write(key: string, at: number): void {
  try {
    localStorage.setItem(key, String(at));
  } catch {
    // Storage blocked: the reminder simply comes back, which is harmless.
  }
}

/** Called after an export of every note succeeds. */
export function recordFullExport(now = Date.now()): void {
  write(LAST_EXPORT_KEY, now);
}

export function snoozeBackupReminder(now = Date.now()): void {
  write(SNOOZED_KEY, now);
}

/** Whether the reminder is due. Starts the clock on a device's first call. */
export function backupReminderDue(now = Date.now()): boolean {
  let since = read(FIRST_SEEN_KEY);
  if (since === null) {
    write(FIRST_SEEN_KEY, now);
    since = now;
  }
  const acted = Math.max(read(LAST_EXPORT_KEY) ?? 0, read(SNOOZED_KEY) ?? 0);
  if (acted === 0) return now - since >= FIRST_BACKUP_REMINDER_MS;
  return now - Math.max(since, acted) >= BACKUP_REMINDER_INTERVAL_MS;
}
