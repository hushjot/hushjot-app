/**
 * Build the publishable `@hushjot/core` package into `dist-core/`.
 *
 * What the package is and why it exists is in `src/core/public.ts`. This file
 * is the mechanics, and three of them are decisions rather than plumbing:
 *
 * **It is tsc, not Vite.** Every other build in this repo goes through Vite,
 * and this one deliberately does not. `kdf.ts` contains
 * `new Worker(new URL('./kdf.worker.ts', import.meta.url))`, which Vite's
 * worker plugin would try to bundle into a browser worker asset — inside a
 * package meant for Node, where that branch is unreachable. tsc leaves the
 * expression alone as ordinary JavaScript behind its `typeof Worker` guard,
 * which is exactly what is wanted.
 *
 * **The KDF worker is removed from the output.** Node has no global `Worker`,
 * so `deriveKekFromPassphrase` always takes the inline `hash-wasm` path here;
 * shipping the worker would ship a file nothing can reach — its specifier is a
 * `.ts` path that does not resolve in the emit either way. Removing it makes
 * the package's Node-only KDF an obvious fact rather than a broken promise.
 *
 * **The contract travels with the code.** `contract/format-vectors.json` and
 * the repo's live `firestore.rules` are copied in on every build, so the CLI's
 * tests always run against the rules and the vectors of the core they
 * installed. Copying at build time rather than committing a second copy means
 * there is no duplicate to drift and no test needed to police one.
 *
 * **The package carries its own `CryptoKey`.** The signatures here name DOM
 * globals, and `@types/node` keeps `CryptoKey` inside its `webcrypto`
 * namespace rather than declaring it globally — so a Node CLI with
 * `lib: ["ES2022"]` could not typecheck a single call. `globals.d.ts` supplies
 * it as an *interface*, which merges harmlessly when the consumer does have
 * `lib.dom`. `BufferSource` could not be handled the same way, because a type
 * alias cannot be re-declared; `importKey` takes `Bytes` instead.
 *
 * The build finishes by importing what it just emitted and exercising it. A
 * package that does not load is the one failure mode that would otherwise be
 * discovered by a stranger running `npm i`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(repoRoot, 'dist-core');

/**
 * The package's own version, independent of the app's `0.0.0`. Bump it here.
 * A change to `FORMAT_VERSION` in `src/core/public.ts` is always at least a
 * minor bump, because it means the CLI has to be released too.
 */
const CORE_VERSION = '0.4.0';

const run = (command, args) =>
  execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit', shell: false });

// 1. Clean, so a symbol removed from the barrel really leaves the package.
rmSync(outDir, { recursive: true, force: true });

// 2. Emit. `tsconfig.core.json`'s program is exactly `public.ts` plus whatever
//    it transitively imports, so nothing unreachable from the barrel is built.
run(process.execPath, [resolve(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.core.json']);

// 3. Catch a rootDir fallback before it reaches anyone.
//
//    This is not hypothetical. An early version of `tsconfig.core.json` set
//    `files` without `include: []`, so `extends` kept the app's globs, tsc
//    reported rootDir violations, and then emitted .js/.d.ts *next to every
//    source file* — 468 of them scattered through src/, tests/ and bench/.
//    The config is fixed; this is the alarm if it ever regresses.
if (existsSync(resolve(repoRoot, 'src/core/public.js'))) {
  throw new Error(
    'build-core: tsc emitted beside the sources, not into dist-core. ' +
      'Check `rootDir` and `include` in tsconfig.core.json, and delete the stray files.',
  );
}

// 4. Drop the browser worker. See the header.
for (const name of ['kdf.worker.js', 'kdf.worker.d.ts']) {
  rmSync(resolve(outDir, 'crypto', name), { force: true });
}

// 5. The contract.
mkdirSync(resolve(outDir, 'contract'), { recursive: true });
cpSync(
  resolve(repoRoot, 'contract/format-vectors.json'),
  resolve(outDir, 'contract/format-vectors.json'),
);
cpSync(resolve(repoRoot, 'firestore.rules'), resolve(outDir, 'contract/firestore.rules'));

// 6. Ambient types the emitted signatures depend on. See the header.
writeFileSync(
  resolve(outDir, 'globals.d.ts'),
  [
    "// Supplied by the package because `@types/node` does not declare `CryptoKey`",
    '// globally — it lives in the `webcrypto` namespace. Declared as an interface',
    '// rather than a type alias so that it merges silently instead of colliding',
    '// when the consumer also has `lib.dom`.',
    "import type { webcrypto } from 'node:crypto';",
    '',
    'declare global {',
    '  interface CryptoKey extends webcrypto.CryptoKey {}',
    '}',
    '',
  ].join('\n'),
);

// tsc will not add this reference itself, and `exports` points a consumer at
// `public.d.ts` alone, so the shim would never be loaded without it.
const publicTypes = resolve(outDir, 'public.d.ts');
writeFileSync(
  publicTypes,
  `/// <reference path="./globals.d.ts" />\n${readFileSync(publicTypes, 'utf8')}`,
);

// 7. The manifest.
//
//    `hash-wasm` is a real dependency rather than a peer: it is a leaf WASM
//    library reached through one dynamic import, and making the CLI declare it
//    would be asking a consumer to know which KDF this package uses.
const manifest = {
  name: '@hushjot/core',
  version: CORE_VERSION,
  description:
    "HushJot's encryption envelope, key records, note format and search index — " +
    'the format code shared by the web app and the CLI.',
  type: 'module',
  exports: {
    '.': { types: './public.d.ts', default: './public.js' },
    './contract/format-vectors.json': './contract/format-vectors.json',
    './contract/firestore.rules': './contract/firestore.rules',
  },
  // Node 22.6 is where the repo's `.ts` import style stopped needing a loader,
  // and 20 is where the WebCrypto globals this package assumes are stable.
  engines: { node: '>=20' },
  dependencies: { 'hash-wasm': '^4.12.0' },
  license: 'AGPL-3.0-only',
  author: "Nebulosa d'Ideias Unipessoal Lda.",
  homepage: 'https://hushjot.com',
  // The package is built from a subfolder of the app, so `directory` lets the
  // npm page link to the source rather than to the app's root.
  repository: {
    type: 'git',
    url: 'https://github.com/hushjot/hushjot-app.git',
    directory: 'src/core',
  },
  bugs: { url: 'https://github.com/hushjot/hushjot-app/issues' },
  // Publishing is deliberate. The built package is unpublishable unless a
  // release build explicitly asks for it, so a stray `npm publish` in
  // dist-core cannot reach the registry. See hushjot-cli/RELEASING.md.
  private: process.env.HUSHJOT_RELEASE !== '1',
  sideEffects: false,
};
writeFileSync(resolve(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

writeFileSync(
  resolve(outDir, 'README.md'),
  [
    '# @hushjot/core',
    '',
    "HushJot's stored-byte format, extracted so a second client can read and write",
    'a vault without reimplementing it: the AES-256-GCM envelope, Argon2id key',
    'records, the sealed note-meta JSON, title and excerpt derivation, and the',
    'search index.',
    '',
    'Built from the app repository. Do not edit these files — change',
    '`src/core/public.ts` there and republish.',
    '',
    '## Node only',
    '',
    'Key derivation uses `hash-wasm` on the calling thread. The browser build of',
    'HushJot runs the same code in a Web Worker; that worker is not shipped here,',
    'so this package should not be bundled for a browser.',
    '',
    '## The contract',
    '',
    '- `@hushjot/core/contract/format-vectors.json` — frozen ciphertext, key',
    '  records and derivations. Assert against these; a divergence means the two',
    '  clients no longer agree about what a note looks like on disk.',
    '- `@hushjot/core/contract/firestore.rules` — the live security rules, for',
    '  running an emulator against the real thing rather than a stale copy.',
    '',
  ].join('\n'),
);

// 8. Prove it loads and does the thing it exists to do.
const core = await import(resolve(outDir, 'public.js'));
const key = await core.generateDek(false);
const sealed = await core.sealText(key, '# smoke\nbody');
if ((await core.openText(key, sealed)) !== '# smoke\nbody') {
  throw new Error('build-core: emitted package failed to round-trip a sealed note');
}
if (sealed[0] !== core.ENVELOPE_VERSION || sealed[1] !== core.ALG_AES_256_GCM) {
  throw new Error('build-core: emitted package wrote an unexpected envelope header');
}

const vectors = JSON.parse(
  await (await import('node:fs/promises')).readFile(
    resolve(outDir, 'contract/format-vectors.json'),
    'utf8',
  ),
);
if (vectors.formatVersion !== core.FORMAT_VERSION) {
  throw new Error(
    `build-core: contract is format v${vectors.formatVersion} but the code speaks ` +
      `v${core.FORMAT_VERSION}. Run \`npm run vectors\`.`,
  );
}

console.log(
  `@hushjot/core ${CORE_VERSION} → dist-core/  (format v${core.FORMAT_VERSION}, ` +
    `${Object.keys(core).length} exports)`,
);
