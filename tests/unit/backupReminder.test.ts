import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BACKUP_REMINDER_INTERVAL_MS,
  FIRST_BACKUP_REMINDER_MS,
  backupReminderDue,
  recordFullExport,
  snoozeBackupReminder,
} from '../../src/ui/backupReminder.ts';

const DAY = 24 * 60 * 60 * 1000;

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    keys: () => [...map.keys()],
  };
}

let store: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  store = fakeStorage();
  vi.stubGlobal('localStorage', store);
});
afterEach(() => vi.unstubAllGlobals());

describe('backupReminderDue', () => {
  it('is not due on a new device, and first asks three days later', () => {
    const t0 = 1_800_000_000_000;
    expect(backupReminderDue(t0)).toBe(false);
    expect(backupReminderDue(t0 + 2 * DAY)).toBe(false);
    expect(backupReminderDue(t0 + FIRST_BACKUP_REMINDER_MS)).toBe(true);
  });

  it('waits the full interval once the user has dismissed the first ask', () => {
    const t0 = 1_800_000_000_000;
    backupReminderDue(t0);
    snoozeBackupReminder(t0 + 3 * DAY);
    expect(backupReminderDue(t0 + 4 * DAY)).toBe(false);
    expect(backupReminderDue(t0 + 3 * DAY + BACKUP_REMINDER_INTERVAL_MS - 1)).toBe(false);
    expect(backupReminderDue(t0 + 3 * DAY + BACKUP_REMINDER_INTERVAL_MS)).toBe(true);
  });

  it('restarts the clock on a full export and on a snooze', () => {
    const t0 = 1_800_000_000_000;
    backupReminderDue(t0);
    recordFullExport(t0 + 40 * DAY);
    expect(backupReminderDue(t0 + 41 * DAY)).toBe(false);
    expect(backupReminderDue(t0 + 70 * DAY)).toBe(true);
    snoozeBackupReminder(t0 + 70 * DAY);
    expect(backupReminderDue(t0 + 71 * DAY)).toBe(false);
  });

  it('writes only teksto: keys, so a device reset clears them', () => {
    backupReminderDue(1);
    recordFullExport(2);
    snoozeBackupReminder(3);
    expect(store.keys().every((k) => k.startsWith('teksto:'))).toBe(true);
  });

  it('treats blocked storage as not due rather than throwing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(backupReminderDue(Date.now())).toBe(false);
  });
});
