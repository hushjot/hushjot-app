/**
 * Line diff for the history panel: what changed between a version and now.
 *
 * Hand-written rather than a dependency (§28). Myers' O(ND) algorithm — the
 * one `git diff` descends from — over lines interned to integers, so the inner
 * loop compares numbers, not strings. Common head and tail lines are trimmed
 * first, which for the usual "edited one paragraph" case leaves almost nothing
 * for the algorithm to do.
 *
 * ## Bounded, because it runs on the main thread
 *
 * Myers is O((N+M)·D) time and keeps one frontier per edit step, so two
 * unrelated 10,000-line documents are the worst case. Past `maxLines` on either
 * side or `maxEdits` differing lines it gives up and says so; the panel then
 * shows the version's text instead. A diff nobody can read is not worth a
 * frozen tab.
 */

export type DiffLine =
  | { kind: 'same'; text: string; oldLine: number; newLine: number }
  | { kind: 'removed'; text: string; oldLine: number }
  | { kind: 'added'; text: string; newLine: number };

export interface DiffHunk {
  lines: DiffLine[];
}

export type DiffResult =
  | { kind: 'identical' }
  | { kind: 'too-large' }
  | { kind: 'changes'; hunks: DiffHunk[]; added: number; removed: number };

export interface DiffOptions {
  maxLines?: number;
  maxEdits?: number;
  context?: number;
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** The full edit script, or null if it would exceed `maxEdits`. */
export function diffLines(a: readonly string[], b: readonly string[], maxEdits: number): DiffLine[] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const ids = new Map<string, number>();
  const intern = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) ids.set(line, (id = ids.size));
    return id;
  };
  const x = Int32Array.from(a.slice(head, a.length - tail), intern);
  const y = Int32Array.from(b.slice(head, b.length - tail), intern);

  const middle = myers(x, y, maxEdits);
  if (!middle) return null;

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: 'same', text: a[i]!, oldLine: i + 1, newLine: i + 1 });
  for (const op of middle) {
    if (op.kind === 'same') {
      out.push({ kind: 'same', text: a[head + op.i]!, oldLine: head + op.i + 1, newLine: head + op.j + 1 });
    } else if (op.kind === 'removed') {
      out.push({ kind: 'removed', text: a[head + op.i]!, oldLine: head + op.i + 1 });
    } else {
      out.push({ kind: 'added', text: b[head + op.j]!, newLine: head + op.j + 1 });
    }
  }
  for (let t = tail; t > 0; t--) {
    const i = a.length - t;
    const j = b.length - t;
    out.push({ kind: 'same', text: a[i]!, oldLine: i + 1, newLine: j + 1 });
  }
  return out;
}

type Op = { kind: 'same'; i: number; j: number } | { kind: 'removed'; i: number } | { kind: 'added'; j: number };

function myers(x: Int32Array, y: Int32Array, maxEdits: number): Op[] | null {
  const n = x.length;
  const m = y.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v;
    for (let k = -d; k <= d; k += 2) {
      let i =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      next[offset + k] = i;
      if (i >= n && j >= m) {
        found = d;
        break;
      }
    }
    v = next;
    if (found !== -1) break;
  }
  if (found === -1) return n + m === 0 ? [] : null;

  // Walk the frontiers back from the end to recover the path.
  const ops: Op[] = [];
  let i = n;
  let j = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!;
    const k = i - j;
    const down = k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevI = prev[offset + prevK]!;
    const prevJ = prevI - prevK;
    while (i > prevI && j > prevJ) {
      i--;
      j--;
      ops.push({ kind: 'same', i, j });
    }
    if (down) {
      j--;
      ops.push({ kind: 'added', j });
    } else {
      i--;
      ops.push({ kind: 'removed', i });
    }
  }
  while (i > 0 && j > 0) {
    i--;
    j--;
    ops.push({ kind: 'same', i, j });
  }
  return ops.reverse();
}

/** Diff two texts into hunks with `context` unchanged lines around each change. */
export function diffTexts(before: string, after: string, options: DiffOptions = {}): DiffResult {
  if (before === after) return { kind: 'identical' };
  const { maxLines = 10_000, maxEdits = 2_000, context = 3 } = options;
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > maxLines || b.length > maxLines) return { kind: 'too-large' };

  const lines = diffLines(a, b, maxEdits);
  if (!lines) return { kind: 'too-large' };

  let added = 0;
  let removed = 0;
  const keep = new Uint8Array(lines.length);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    if (line.kind === 'added') added++;
    else removed++;
    for (let c = Math.max(0, index - context); c <= Math.min(lines.length - 1, index + context); c++) keep[c] = 1;
  });
  if (added === 0 && removed === 0) return { kind: 'identical' };

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] | null = null;
  lines.forEach((line, index) => {
    if (!keep[index]) {
      current = null;
      return;
    }
    if (!current) {
      current = [];
      hunks.push({ lines: current });
    }
    current.push(line);
  });
  return { kind: 'changes', hunks, added, removed };
}
