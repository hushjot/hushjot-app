/** Percentile / summary helpers shared by the spikes. */

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  // Nearest-rank: the smallest value at or above the p-th percentile position.
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

export function summarize(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? NaN,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sorted.length ? sum / sorted.length : NaN,
  };
}

export const round = (v: number, dp = 2): number =>
  Number.isFinite(v) ? Number(v.toFixed(dp)) : v;

export function roundSummary(s: Summary, dp = 2): Summary {
  return {
    n: s.n,
    min: round(s.min, dp),
    p50: round(s.p50, dp),
    p95: round(s.p95, dp),
    p99: round(s.p99, dp),
    max: round(s.max, dp),
    mean: round(s.mean, dp),
  };
}
