/**
 * The cases behind `contract/behaviour-vectors.json`.
 *
 * `format-vectors.json` freezes stored *bytes*: random nonces and salts, so it
 * can never be regenerated without meaning a format change. This file is its
 * deterministic sibling. It pins *behaviour* that a second implementation has
 * to reproduce exactly but that never touches a random number: the query
 * grammar, tag extraction, folder resolution, list order, search ranking over a
 * fixed corpus, title and excerpt edge cases, and the meter's arithmetic.
 *
 * The Rust SDK (`hushjot-rs`) is that second implementation, and it asserts
 * every case here against its port. Because nothing here is random, the file is
 * regenerated freely (`npm run vectors:behaviour`), and
 * `tests/unit/behaviourVectors.test.ts` fails when the live core and the
 * committed file disagree — so a behaviour change is a visible diff of this
 * file, which is what tells the other clients they need a release.
 *
 * `build(core)` takes the module rather than importing it, so the generator can
 * pass the built `dist-core` and the unit test can pass the live sources.
 *
 * Inputs avoid one thing on purpose: a cut through the middle of a surrogate
 * pair. JavaScript keeps the lone half, which JSON then cannot carry to a
 * language whose strings must be valid Unicode. That divergence is documented
 * in the Rust port rather than encoded here.
 */

const TITLE_INPUTS = [
  '# Heading\nbody',
  '###### Six\nbody',
  '####### Seven is not a heading',
  '#NoSpace',
  '- [x] done task',
  '* [ ] open task',
  '+ plus bullet',
  '12) twelfth',
  '3. third',
  '> > nested quote',
  '| --- | --- |\n| a | b |',
  '***\n___\n===\nreal line',
  '﻿  bom and spaces  ',
  '　ideographic space',
  ' nbsp led',
  '🔐 emoji first',
  '日本語のタイトル',
  `${'a'.repeat(118)}🔐tail`,
  `${'🔐'.repeat(60)}more`,
  `${'x'.repeat(5000)}`,
  `${'\n'.repeat(4100)}too far down`,
  '```\nfence first\n```',
  '[[Note link]] first',
  '',
];

const EXCERPT_INPUTS = [
  '# Title\nSecond line',
  '# Title\n\n- bullet one\n- bullet two',
  '# Title\n```js\ncode line\n```\nafter',
  '# Title\n   ```indented fence\nstill code\n',
  `# Title\n${'word '.repeat(40)}`,
  `# Title\n${'b'.repeat(99)} next`,
  'Only line',
  '---\n# After a rule\nexcerpt here',
  '# T\n> quoted second\n12. numbered',
];

const TOKENIZE_INPUTS = [
  'Hello, World!',
  'snake_case kebab-case CamelCase',
  'a I to be',
  'Ræksmörgås 日本語 Ωmega',
  `${'z'.repeat(45)} short`,
  '[[Linked Note]] #tag/nested',
  'v1.2.3 x86_64',
  '',
];

const QUERY_INPUTS = [
  'postgres pool',
  '#work -#old',
  'in:Work/DB -in:Archive',
  'in:"My Work" -in:"Old Stuff"',
  '"#include" -"connection  pool"',
  'foo-"bar"',
  '"unterminated phrase',
  '-draft',
  'in: # - ""',
  'Kebab-Case MIXED',
  'in:/ loose',
  '-#',
  '#a/b in:x/y "q"',
];

const TAG_INPUTS = [
  '#work and #Home\nmore #work',
  '# Heading\n[x](#anchor) C# a#b',
  '#2024 #ff0000 #1e90ff #fade #abc1x',
  '```\n#inside\n```\n#after',
  '~~~~\n#inside\n~~~\n#still\n~~~~\n#out',
  'para\n\n    #indented\n\n#back',
  'para\n    #continuation',
  'use `#include` here and `` #two `` #real',
  '#a//b #done/ #next- #-x',
  `#${'a'.repeat(64)} #${'b'.repeat(65)}`,
  '#日本語 #über #ü1',
  '\t#tabbed',
];

const NORMALISE_TAG_INPUTS = ['work', 'a//b', 'done/', 'next-', '1234', 'ff0000', 'fade', 'x/-/y'];

const FOLDERS = [
  { id: 'w', name: 'Work', parentId: null, createdAt: 1, updatedAt: 1 },
  { id: 'db', name: 'DB', parentId: 'w', createdAt: 1, updatedAt: 1 },
  { id: 'pg', name: 'Postgres', parentId: 'db', createdAt: 1, updatedAt: 1 },
  { id: 'h', name: 'Home', parentId: null, createdAt: 1, updatedAt: 1 },
  { id: 'hdb', name: 'db', parentId: 'h', createdAt: 1, updatedAt: 1 },
  { id: 'ws', name: 'Workshop', parentId: null, createdAt: 1, updatedAt: 1 },
  { id: 'c1', name: 'Cycle A', parentId: 'c2', createdAt: 1, updatedAt: 1 },
  { id: 'c2', name: 'Cycle B', parentId: 'c1', createdAt: 1, updatedAt: 1 },
  { id: 'orph', name: 'Orphan', parentId: 'gone', createdAt: 1, updatedAt: 1 },
];

const FOLDER_QUERIES = ['W', 'work/db', 'DB', 'home/db', 'Wor', 'work/', 'Workshop', '  ', 'nothing', 'CYCLE A'];

const NOTES_FOR_ORDER = [
  { id: 'a', title: 'note 10', pinnedAt: null, updatedAt: 50, createdAt: 5 },
  { id: 'b', title: 'Note 2', pinnedAt: 300, updatedAt: 40, createdAt: 9 },
  { id: 'c', title: 'apple', pinnedAt: null, updatedAt: 60, createdAt: 1 },
  { id: 'd', title: 'Banana', pinnedAt: 100, updatedAt: 70, createdAt: 3 },
  { id: 'e', title: 'apple', pinnedAt: null, updatedAt: 60, createdAt: 2 },
];

const SORTS = [
  { key: 'edited', reversed: false },
  { key: 'edited', reversed: true },
  { key: 'created', reversed: false },
  { key: 'title', reversed: false },
  { key: 'title', reversed: true },
];

const CORPUS = [
  { id: 'pg', title: 'Postgres tuning', content: '# Postgres tuning\nconnection pool size #db', updatedAt: 3, folderId: 'db' },
  { id: 'my', title: 'MySQL', content: '# MySQL\npostgres comparison #db/legacy', updatedAt: 2, folderId: null },
  { id: 'draft', title: 'Draft', content: '# Draft\npool notes #draft', updatedAt: 1, folderId: 'w' },
  { id: 'shop', title: 'Shopping', content: '# Shopping\noat milk, coffee, pool noodles', updatedAt: 4, folderId: 'h' },
  { id: 'tie1', title: 'Tie', content: '# Tie\nsame words here', updatedAt: 5, folderId: null },
  { id: 'tie2', title: 'Tie', content: '# Tie\nsame words here', updatedAt: 5, folderId: null },
];

const SEARCHES = [
  { query: 'postgres' },
  { query: 'po' },
  { query: 'p' },
  { query: 'pool conn' },
  { query: '#db' },
  { query: '#db/le' },
  { query: 'pool -#draft' },
  { query: 'pool -draft' },
  { query: '-pool' },
  { query: 'same' },
  { query: 'pool', folderIds: ['w', 'db', 'pg'] },
  { query: 'postgres', folderIds: [null] },
  { query: 'pool', notFolderIds: ['h'] },
  { query: '#db', folderIds: ['zzz'] },
  { query: 'pool', limit: 2 },
];

const METER = [
  [0, 0],
  [1, 0],
  [1024, 0],
  [5000, 10],
  [10, 5000],
  [10, 20],
  [0, 3000],
  [2048, 2047],
];

const MONTHS = [0, 1_793_489_400_000, 1_790_035_200_000, 951_782_400_000];

function sealIdInputs() {
  const short = Array.from({ length: 29 }, (_, i) => i);
  const env = [2, 1, ...Array.from({ length: 12 }, (_, i) => 255 - i), ...Array(16).fill(0)];
  return [short, env];
}

export function build(core) {
  const searchIndex = new core.SearchIndex();
  for (const doc of CORPUS) searchIndex.add(doc);

  return {
    about:
      'Deterministic behaviour vectors: what every HushJot client must compute identically. ' +
      'Generated by tools/make-behaviour-vectors.mjs from tools/behaviour-cases.mjs; safe to regenerate.',
    deriveTitle: TITLE_INPUTS.map((content) => ({ content, expected: core.deriveTitle(content) })),
    excerptOf: EXCERPT_INPUTS.map((content) => ({ content, expected: core.excerptOf(content) })),
    tokenize: TOKENIZE_INPUTS.map((text) => ({ text, expected: core.tokenize(text) })),
    parseQuery: QUERY_INPUTS.map((query) => ({
      query,
      expected: core.parseQuery(query),
      hasPositiveTerm: core.hasPositiveTerm(core.parseQuery(query)),
    })),
    normalisePhrase: ['  A\n\tB  c ', 'ÄÖ  ü', ''].map((text) => ({ text, expected: core.normalisePhrase(text) })),
    extractTags: TAG_INPUTS.map((content) => ({ content, expected: core.extractTags(content) })),
    normaliseTag: NORMALISE_TAG_INPUTS.map((body) => ({ body, expected: core.normaliseTag(body) })),
    tagMatches: [
      ['work', 'work'],
      ['work/clients', 'work'],
      ['workshop', 'work'],
      ['work', 'work/clients'],
    ].map(([key, filter]) => ({ key, filter, expected: core.tagMatches(key, filter) })),
    folders: {
      fixture: FOLDERS,
      foldersMatching: FOLDER_QUERIES.flatMap((wanted) =>
        [false, true].map((prefix) => ({
          wanted,
          prefix,
          expected: core.foldersMatching(FOLDERS, wanted, { prefix }),
        })),
      ),
      subtreeIds: FOLDERS.map((f) => ({ id: f.id, expected: core.subtreeIds(FOLDERS, f.id) })),
      ancestorIds: FOLDERS.map((f) => ({ id: f.id, expected: core.ancestorIds(FOLDERS, f.id) })),
      folderPath: FOLDERS.map((f) => ({ id: f.id, expected: core.folderPath(FOLDERS, f.id, ' / ') })),
      canMoveFolder: [
        ['w', 'pg'],
        ['w', 'w'],
        ['pg', null],
        ['h', 'db'],
        ['h', 'missing'],
      ].map(([id, parent]) => ({ id, parent, expected: core.canMoveFolder(FOLDERS, id, parent) })),
    },
    orderForList: {
      fixture: NOTES_FOR_ORDER,
      cases: SORTS.map((sort) => ({ sort, expected: core.orderForList(NOTES_FOR_ORDER, sort).map((n) => n.id) })),
    },
    search: {
      corpus: CORPUS,
      cases: SEARCHES.map(({ query, folderIds, notFolderIds, limit }) => ({
        query,
        folderIds: folderIds ?? null,
        notFolderIds: notFolderIds ?? null,
        limit: limit ?? 50,
        expected: searchIndex.searchParsed(core.parseQuery(query), {
          limit: limit ?? 50,
          folderIds: folderIds ? new Set(folderIds) : undefined,
          notFolderIds: notFolderIds ? new Set(notFolderIds) : undefined,
        }),
      })),
      tagSummary: searchIndex.tagSummary(),
    },
    meter: {
      meterDelta: METER.map(([next, old]) => ({ next, old, expected: core.meterDelta(next, old) })),
      chargedBytes: [0, -5, 1, 1023, 1024, 5000].map((size) => ({ size, expected: core.chargedBytes(size) })),
      usageMonth: MONTHS.map((ms) => ({ ms, expected: core.usageMonth(ms) })),
    },
    sealIdOf: sealIdInputs().map((bytes) => ({ bytes, expected: core.sealIdOf(new Uint8Array(bytes)) })),
  };
}
