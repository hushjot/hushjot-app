/**
 * Display formatting. Uses `Intl` rather than a date library — the platform is
 * enough here, and §28 asks every dependency to justify itself.
 */

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });
const sameYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const otherYear = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now" / "3m ago" / "2h ago" / "Apr 4". Switches to an absolute date
 * after a week, where "8 days ago" stops being more useful than the date.
 */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const delta = now - timestamp;

  if (delta < 45_000) return 'just now';
  if (delta < HOUR) return rtf.format(-Math.round(delta / MINUTE), 'minute');
  if (delta < DAY) return rtf.format(-Math.round(delta / HOUR), 'hour');
  if (delta < 7 * DAY) return rtf.format(-Math.round(delta / DAY), 'day');

  const date = new Date(timestamp);
  const formatter =
    date.getFullYear() === new Date(now).getFullYear() ? sameYear : otherYear;
  return formatter.format(date);
}
