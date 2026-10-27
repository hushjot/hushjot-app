/**
 * Deterministic synthetic note generator shared by every Phase 0 spike.
 *
 * Determinism matters: a benchmark that regenerates different data each run
 * cannot detect a regression. Everything here derives from a seeded PRNG.
 */

export interface SyntheticNote {
  id: string;
  title: string;
  content: string;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

/** mulberry32 — small, fast, good enough for fixture generation. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  'postgres', 'docker', 'rust ownership', 'kubernetes ingress', 'terraform state',
  'react hooks', 'sql window functions', 'nginx config', 'bash one-liners', 'git rebase',
  'aws iam policy', 'redis eviction', 'grpc streaming', 'webpack config', 'ci pipeline',
  'holiday ideas', 'meeting notes', 'shopping list', 'book notes', 'interview prep',
  'api design', 'oauth flow', 'regex cheatsheet', 'vim motions', 'ssh tunnels',
];

const QUALIFIERS = [
  'commands', 'setup', 'notes', 'cheatsheet', 'debugging', 'gotchas', 'draft',
  'scratch', 'ideas', 'todo', 'reference', 'migration', 'v2', 'old', 'wip',
];

const FOLDERS = ['ideas', 'code', 'code/rust', 'code/sql', 'code/commands', 'work', 'personal'];

const SNIPPETS: Record<string, string> = {
  bash: `docker compose up -d\ndocker compose logs -f api\nkubectl get pods -n prod --sort-by=.status.startTime`,
  sql: `SELECT c.id, c.name, count(o.id) AS orders\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nWHERE c.active = true\nGROUP BY c.id, c.name\nHAVING count(o.id) > 3\nORDER BY orders DESC;`,
  rust: `pub fn parse(input: &str) -> Result<Config, ParseError> {\n    let mut cfg = Config::default();\n    for (lineno, line) in input.lines().enumerate() {\n        let line = line.trim();\n        if line.is_empty() || line.starts_with('#') { continue; }\n        let (k, v) = line.split_once('=').ok_or(ParseError::Syntax(lineno))?;\n        cfg.set(k.trim(), v.trim())?;\n    }\n    Ok(cfg)\n}`,
  typescript: `export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {\n  let lastErr: unknown;\n  for (let i = 0; i < attempts; i++) {\n    try { return await fn(); }\n    catch (err) { lastErr = err; await sleep(2 ** i * 100); }\n  }\n  throw lastErr;\n}`,
  python: `def chunked(iterable, size):\n    it = iter(iterable)\n    while batch := list(islice(it, size)):\n        yield batch`,
  json: `{\n  "version": 1,\n  "retries": 3,\n  "endpoints": ["https://api.example.com/v1", "https://api.example.com/v2"],\n  "timeoutMs": 5000\n}`,
  yaml: `services:\n  api:\n    image: ghcr.io/acme/api:latest\n    ports: ["8080:8080"]\n    environment:\n      DATABASE_URL: postgres://localhost/acme`,
  go: `func Middleware(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tstart := time.Now()\n\t\tnext.ServeHTTP(w, r)\n\t\tlog.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))\n\t})\n}`,
};

const LANGS = Object.keys(SNIPPETS);

const PROSE = [
  'Remember to check the connection pool size before scaling this up.',
  'This broke in production last time because the timeout was too aggressive.',
  'Ask the team whether we still need the legacy path here.',
  'Works locally but fails in CI — likely an env difference.',
  'Keep this around, it took an hour to work out the right incantation.',
  'The docs are wrong about the default value; verified empirically.',
  'Roughly twice as fast as the previous approach on the same dataset.',
];

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/**
 * A canned prose/snippet corpus produces only a few hundred unique tokens,
 * which makes any search index look artificially small and fast. Real notes
 * are full of identifiers, hostnames, ids, hashes and one-off words, so the
 * fixture mixes in generated high-cardinality tokens to keep the search
 * benchmark honest.
 */
const STEMS = [
  'auth', 'cache', 'queue', 'shard', 'index', 'token', 'batch', 'stream', 'lease',
  'ledger', 'broker', 'digest', 'kernel', 'socket', 'buffer', 'cursor', 'walker',
  'parser', 'router', 'worker', 'daemon', 'client', 'server', 'schema', 'vector',
];
const SUFFIXES = [
  'ing', 'er', 'ed', 'able', 'less', 'ish', 'ment', 'ction', 'ise', 'ify', 'or',
  'sync', 'pool', 'lock', 'guard', 'store', 'proxy', 'shim', 'hook', 'meta',
];

function rareToken(rng: () => number): string {
  const roll = rng();
  if (roll < 0.35) {
    // identifier-ish: authPoolShard_42
    return `${pick(rng, STEMS)}${pick(rng, SUFFIXES)}_${Math.floor(rng() * 10000)}`;
  }
  if (roll < 0.6) {
    // hex id / hash fragment
    return Math.floor(rng() * 0xffffffff).toString(16).padStart(8, '0');
  }
  if (roll < 0.8) {
    // hostname-ish
    return `${pick(rng, STEMS)}-${Math.floor(rng() * 999)}.internal.example.com`;
  }
  return `${pick(rng, STEMS)}${pick(rng, SUFFIXES)}`;
}

/** A sentence carrying several unique tokens. */
function rareLine(rng: () => number): string {
  const n = 3 + Math.floor(rng() * 5);
  return Array.from({ length: n }, () => rareToken(rng)).join(' ');
}

/** Build one note body of roughly `targetBytes` characters. */
function buildContent(rng: () => number, title: string, targetBytes: number): string {
  const parts: string[] = [`# ${title}`, ''];
  let size = title.length + 4;

  while (size < targetBytes) {
    const roll = rng();
    let block: string;

    if (roll < 0.3) {
      const lang = pick(rng, LANGS);
      block = '```' + lang + '\n' + SNIPPETS[lang] + '\n```';
    } else if (roll < 0.45) {
      block = `## ${pick(rng, QUALIFIERS)} ${pick(rng, TOPICS)}`;
    } else if (roll < 0.6) {
      const n = 2 + Math.floor(rng() * 4);
      block = Array.from({ length: n }, () => `- ${pick(rng, PROSE)}`).join('\n');
    } else if (roll < 0.7) {
      const n = 2 + Math.floor(rng() * 3);
      block = Array.from({ length: n }, (_, i) => `${i + 1}. ${pick(rng, PROSE)}`).join('\n');
    } else if (roll < 0.78) {
      block = `> ${pick(rng, PROSE)}`;
    } else if (roll < 0.84) {
      block = `| key | value |\n| --- | --- |\n| ${pick(rng, QUALIFIERS)} | \`${pick(rng, TOPICS)}\` |`;
    } else if (roll < 0.88) {
      block = '---';
    } else if (roll < 0.9) {
      block = `- [${rng() < 0.5 ? 'x' : ' '}] ${pick(rng, PROSE)}`;
    } else if (roll < 0.96) {
      // High-cardinality content: identifiers, ids, hostnames.
      block = rareLine(rng);
    } else {
      block = `${pick(rng, PROSE)} See [the docs](https://example.com/${pick(rng, QUALIFIERS)}) for **detail**, _context_, ~~history~~ and \`inline code\`.`;
    }

    parts.push(block, '');
    size += block.length + 2;
  }

  return parts.join('\n');
}

export interface GenerateOptions {
  count: number;
  seed?: number;
  /** Median note size in characters. A long tail is generated around it. */
  medianBytes?: number;
}

export function generateNotes(opts: GenerateOptions): SyntheticNote[] {
  const { count, seed = 0xC0FFEE, medianBytes = 1200 } = opts;
  const rng = mulberry32(seed);
  const now = 1_755_000_000_000; // fixed epoch — keeps fixtures byte-identical across runs
  const notes: SyntheticNote[] = [];

  for (let i = 0; i < count; i++) {
    // Log-normal-ish size distribution: most notes small, a few very large.
    const tail = rng();
    const target =
      tail > 0.98 ? medianBytes * 40 :
      tail > 0.9 ? medianBytes * 8 :
      tail > 0.6 ? medianBytes * 2 :
      Math.max(80, Math.floor(medianBytes * (0.2 + rng())));

    const title = `${pick(rng, TOPICS)} ${pick(rng, QUALIFIERS)}`;
    const createdAt = now - Math.floor(rng() * 400 * 86_400_000);

    notes.push({
      id: `note_${i.toString(36).padStart(6, '0')}`,
      title: title.charAt(0).toUpperCase() + title.slice(1),
      content: buildContent(rng, title, target),
      folderId: rng() < 0.65 ? pick(rng, FOLDERS) : null,
      createdAt,
      updatedAt: createdAt + Math.floor(rng() * 30 * 86_400_000),
      revision: 1 + Math.floor(rng() * 50),
    });
  }

  return notes;
}

/**
 * One deliberately huge note for the editor spike. The spec's worst realistic
 * case is a long scratch file full of fenced code, which is the hardest thing
 * for a syntax-highlighting editor to keep responsive.
 */
export function generateLargeNote(targetBytes = 200_000, seed = 0xBEEF): string {
  const rng = mulberry32(seed);
  return buildContent(rng, 'Large scratch buffer', targetBytes);
}
