/**
 * Generate `contract/format-vectors.json` — the stored-byte contract between
 * this repo and the CLI that lives in another one.
 *
 * The problem this solves. Once `@hushjot/core` is published, two repositories
 * can disagree about what a note looks like on disk, and almost every way they
 * could disagree is silent. A `deriveTitle` that handles one edge case
 * differently writes a different title for identical text. A `noteMetaJson`
 * that stops omitting a null `pinnedAt` grows every record and breaks nothing
 * visible. Neither produces an error; both are permanent once they reach
 * Firestore. Fixed vectors turn all of that into a failing test on both sides.
 *
 * **Why the output is committed, and why regenerating it is a decision.** A
 * vector regenerated on every run proves nothing: a changed implementation just
 * produces changed vectors and the test goes on passing. These bytes are
 * frozen artefacts of the format as it stood when they were written, and the
 * test only ever *reads* them. Regenerate only when the format itself is
 * deliberately changed — and when it is, `FORMAT_VERSION` in
 * `src/core/public.ts` moves with it, because the CLI keys off that to refuse a
 * core it cannot read.
 *
 * **Adding a case to a frozen file.** This script cannot do it. It mints a
 * fresh DEK and fresh Argon2id salts on every run, so a regeneration moves
 * every envelope and every key record in the output — which is the same
 * "proves nothing" problem above, and it would also force `FORMAT_VERSION`
 * and a CLI release for what was meant to be an addition. To add a case
 * without disturbing the existing bytes, unlock the frozen `sealedUnder`
 * record with its own published passphrase to recover the same DEK, seal only
 * the new payloads, and append them. The cases below are still kept current so
 * that a deliberate, version-moving regeneration produces the whole set.
 *
 * It runs against `dist-core/` rather than `src/`, so what gets vectored is the
 * emitted package a consumer actually installs. (Node's type stripping cannot
 * load the sources directly — one of the error classes uses a parameter
 * property, which strip-only mode rejects.) Run `npm run vectors`, which builds
 * first.
 *
 * The passphrases, recovery codes and keys below are test material and are
 * meant to be readable in the file. They open nothing but these vectors.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const core = await import(resolve(repoRoot, 'dist-core/public.js'));
const {
  FORMAT_VERSION,
  ALG_AES_256_GCM,
  ENVELOPE_VERSION,
  ENVELOPE_VERSION_BOUND,
  DEFAULT_ARGON2_PARAMS,
  deriveTitle,
  excerptOf,
  noteMetaJson,
  recordContext,
  seal,
  sealText,
  serializeKeyRecord,
  toBase64,
  tokenize,
  utf8,
} = core;

// `createKeyRecord` is not on the published surface — a CLI reads key records
// and never writes one — so reach past the barrel for it. This is the only
// place in the repo that mints a vault outside the app.
const { createKeyRecord } = await import(resolve(repoRoot, 'dist-core/crypto/keyRecord.js'));

const PASSPHRASE = 'correct horse battery staple vector';
const RECOVERY_CODE = 'K7Q4-9XMV-2ZWR-8DHC-6BTN-4YFJ-3GKP-1SAE';

/**
 * Two records on purpose. `fast` keeps the test suite quick; `default` proves
 * the production parameters round-trip and that both are read *out of the
 * record* rather than out of a constant — which is the property that lets the
 * KDF be retuned later without invalidating existing vaults.
 */
const PARAM_SETS = [
  { id: 'fast', params: { name: 'argon2id', memoryKiB: 8192, iterations: 1, parallelism: 1 } },
  { id: 'default', params: DEFAULT_ARGON2_PARAMS },
];

/** A fixed instant, so nothing in the output moves when it is regenerated. */
const CREATED_AT = Date.UTC(2026, 8, 22);

const keyRecords = [];
let sealer = null;

for (const { id, params } of PARAM_SETS) {
  const { record, dek } = await createKeyRecord(PASSPHRASE, RECOVERY_CODE, params, CREATED_AT);
  keyRecords.push({
    id,
    passphrase: PASSPHRASE,
    recoveryCode: RECOVERY_CODE,
    record: serializeKeyRecord(record),
  });
  // The sealed samples below hang off the `fast` record's DEK, so verifying
  // them exercises the whole chain: passphrase → Argon2id → KEK → unwrap →
  // DEK → open. No raw key bytes appear in the file at all.
  sealer ??= dek;
}

/**
 * Meta payloads chosen for the omission rules, which are the part most likely
 * to be reimplemented wrongly: an unpinned, excerpt-less note must serialise to
 * exactly the two fields it did before pins and excerpts existed.
 */
const META_CASES = [
  { id: 'minimal', payload: { title: 'Shopping', folderId: null, pinnedAt: null } },
  { id: 'in-folder', payload: { title: 'Rust notes', folderId: 'f-1', pinnedAt: null } },
  { id: 'pinned', payload: { title: 'Standup', folderId: null, pinnedAt: 1758500000123 } },
  {
    id: 'pinned-with-excerpt',
    payload: {
      title: 'Release plan',
      folderId: 'f-2',
      pinnedAt: 1758500000456,
      excerpt: 'Ship the CLI first, then the MCP server.',
    },
  },
  // An excerpt present but empty must be omitted, not written as "".
  { id: 'empty-excerpt', payload: { title: 'Blank', folderId: null, pinnedAt: null, excerpt: '' } },
  // `createdAt` is the newest field and therefore the last one in the JSON.
  // A reimplementation that inserted it anywhere else — beside `updatedAt`
  // would read most naturally — fails here.
  {
    id: 'created',
    payload: { title: 'First note', folderId: null, pinnedAt: null, createdAt: 1758400000000 },
  },
  {
    id: 'every-field',
    payload: {
      title: 'Release plan',
      folderId: 'f-2',
      pinnedAt: 1758500000456,
      excerpt: 'Ship the CLI first, then the MCP server.',
      createdAt: 1758400000000,
    },
  },
  // Zero is a real instant and must survive; only `undefined` is omitted.
  { id: 'created-zero', payload: { title: 'Epoch', folderId: null, pinnedAt: null, createdAt: 0 } },
];

const BODY_CASES = [
  { id: 'empty', text: '' },
  { id: 'ascii', text: '# Hello\n\nA plain note.\n' },
  // Non-ASCII and astral-plane characters catch a decoder that assumes Latin-1
  // or counts UTF-16 units where it should count bytes.
  { id: 'unicode', text: '# Ræksmörgås 日本語\n\nEmoji: 🔐🗒️ — em-dash, “quotes”.\n' },
  { id: 'fenced', text: '# Code\n\n```rust\nfn main() { println!("hi"); }\n```\n' },
  { id: 'tags', text: '# Tagged\n\nSome text #work #proj/alpha and more.\n' },
];

const FOLDER_CASES = [
  { id: 'root', payload: { name: 'Ideas', parentId: null } },
  { id: 'nested', payload: { name: 'Rust', parentId: 'f-1' } },
];

/**
 * Bound (version 2) envelopes: what every note, folder and share-key record is
 * sealed as since format 2. The cases above stay as the version-1 contract,
 * which both clients must still open while the legacy window is open. Format 2
 * added these by appending to the frozen file, as described at the top.
 */
const BOUND_CASES = [
  { id: 'meta-every-field', kind: 'note-meta', recordId: 'n-1', plaintext: noteMetaJson(META_CASES.find((c) => c.id === 'every-field').payload) },
  { id: 'body-unicode', kind: 'note-body', recordId: 'n-1', plaintext: BODY_CASES.find((c) => c.id === 'unicode').text },
  { id: 'body-empty', kind: 'note-body', recordId: 'n-2', plaintext: '' },
  { id: 'folder-nested', kind: 'folder', recordId: 'f-2', plaintext: JSON.stringify({ name: 'Rust', parentId: 'f-1' }) },
  // A share id is 22 base64url characters; the plaintext is a share key.
  { id: 'share-key', kind: 'share-key', recordId: 'AAAAAAAAAAAAAAAAAAAAAA', plaintext: 'Zm9yIHRlc3Rpbmcgb25seSwgb3BlbnMgbm90aGluZw' },
];

/**
 * Pure derivations, no crypto. These are the silent-divergence risk: nothing
 * fails when a second implementation gets one wrong, it just writes a different
 * title than the browser would for the same text.
 */
const TITLE_CASES = [
  '# Heading note\nbody',
  '## Deeper heading',
  '- bullet first\nrest',
  '1. ordered first',
  '> quoted first',
  '\n\n   \nfirst real line',
  '',
  '---',
  '```\nfence first\n```',
  'A very long first line that runs well past the hundred and twenty character cap this function applies so that the tail is dropped rather than kept',
];

const EXCERPT_CASES = [
  '# Title\nSecond line becomes the excerpt.',
  '# Title\n\n```\nfenced content is skipped\n```\nafter the fence',
  '# Only a title',
  'No heading, just a first line\nand a second',
];

const TOKENIZE_CASES = [
  'Hello world',
  'CamelCase and snake_case and kebab-case',
  'a bb ccc',
  'Ræksmörgås 日本語 tokens',
  'punctuation! does; not: survive?',
];

const vectors = {
  formatVersion: FORMAT_VERSION,
  generatedAt: new Date(CREATED_AT).toISOString().slice(0, 10),
  about:
    'Frozen stored-byte vectors shared by the HushJot app and the HushJot CLI. ' +
    'Read by tests in both repositories; regenerate only when the format is ' +
    'deliberately changed, and move FORMAT_VERSION when you do.',

  envelope: {
    version: ENVELOPE_VERSION,
    alg: ALG_AES_256_GCM,
    headerBytes: 14,
    nonceBytes: 12,
    tagBytes: 16,
    // The additional authenticated data is the first two bytes — version and
    // algorithm — and not the nonce.
    aadHex: '0101',
  },

  keyRecords,

  // Every sealed sample opens under the DEK of the `fast` key record.
  sealedUnder: 'fast',

  noteMeta: await Promise.all(
    META_CASES.map(async ({ id, payload }) => ({
      id,
      payload,
      json: noteMetaJson(payload),
      envelopeBase64: toBase64(await seal(sealer, utf8(noteMetaJson(payload)))),
    })),
  ),

  body: await Promise.all(
    BODY_CASES.map(async ({ id, text }) => ({
      id,
      text,
      envelopeBase64: toBase64(await sealText(sealer, text)),
    })),
  ),

  folder: await Promise.all(
    FOLDER_CASES.map(async ({ id, payload }) => ({
      id,
      payload,
      json: JSON.stringify(payload),
      envelopeBase64: toBase64(await seal(sealer, utf8(JSON.stringify(payload)))),
    })),
  ),

  boundEnvelope: {
    version: ENVELOPE_VERSION_BOUND,
    alg: ALG_AES_256_GCM,
    aadPrefixHex: '0201',
    contextFormat: 'hushjot:<kind>:<record id>, UTF-8, appended to the two header bytes',
  },

  bound: await Promise.all(
    BOUND_CASES.map(async (c) => {
      const context = recordContext(c.kind, c.recordId);
      return { ...c, context, envelopeBase64: toBase64(await seal(sealer, utf8(c.plaintext), context)) };
    }),
  ),

  deriveTitle: TITLE_CASES.map((content) => ({ content, expected: deriveTitle(content) })),
  excerptOf: EXCERPT_CASES.map((content) => ({ content, expected: excerptOf(content) })),
  tokenize: TOKENIZE_CASES.map((text) => ({ text, expected: tokenize(text) })),
};

const out = resolve(repoRoot, 'contract/format-vectors.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);

console.log(
  `contract/format-vectors.json — format v${FORMAT_VERSION}, ` +
    `${keyRecords.length} key records, ${vectors.noteMeta.length} meta, ` +
    `${vectors.body.length} body, ${vectors.folder.length} folder, ` +
    `${vectors.deriveTitle.length + vectors.excerptOf.length + vectors.tokenize.length} pure cases`,
);
