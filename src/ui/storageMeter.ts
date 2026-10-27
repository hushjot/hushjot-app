/**
 * The account panel's storage meter, in words. Kept out of the component so the
 * thresholds are tested rather than eyeballed.
 *
 * Binary units labelled the familiar way: the allowance is 1 GiB and the panel
 * says "1 GB", which is what the pricing page says too. Mixing a decimal
 * numerator with a binary denominator would show "1.07 GB of 1 GB" at the cap.
 */
import type { Usage } from '../core/sync/usage.ts';

export type MeterLevel = 'ok' | 'warn' | 'full';

export interface MeterView {
  /** "312 MB of 1 GB". */
  label: string;
  /** 0–100, for the bar. */
  percent: number;
  /** `warn` from 80%, `full` from 95%: the two points the panel speaks up at. */
  level: MeterLevel;
}

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

export function formatBytes(bytes: number): string {
  const n = Math.max(0, bytes);
  const trim = (x: number) => (x >= 10 || Number.isInteger(x) ? String(Math.round(x)) : x.toFixed(1));
  if (n >= GB) return `${trim(n / GB)} GB`;
  if (n >= MB) return `${trim(n / MB)} MB`;
  if (n >= KB) return `${trim(n / KB)} KB`;
  return `${n} bytes`;
}

export function meterView(usage: Usage): MeterView {
  const ratio = usage.quota > 0 ? usage.bytes / usage.quota : 1;
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  return {
    label: `${formatBytes(usage.bytes)} of ${formatBytes(usage.quota)}`,
    percent,
    level: ratio >= 0.95 ? 'full' : ratio >= 0.8 ? 'warn' : 'ok',
  };
}
