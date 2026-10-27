/**
 * Emit the service worker with a real precache manifest.
 *
 * A build plugin rather than `vite-plugin-pwa`: the only thing we need from
 * such a plugin is the list of built filenames, the service worker itself is
 * 120 lines we want full control over (particularly which hosts are never
 * cached), and §28 asks every dependency to justify itself. This is about
 * fifty lines and no new dependency.
 *
 * ## Two shells
 *
 * There are two HTML entries (`vite.config.ts`): the app and the share viewer
 * at `/s/`. Both are precached, both are named in `BUILD_SHELLS` so the worker
 * can answer a navigation with the right one, and — the part that is easy to
 * miss — **both go into `BUILD_VERSION`**. Neither shell is content-hashed, so
 * a change confined to one of them would otherwise produce a byte-identical
 * `sw.js`, the browser would see no update, and that shell would be stale
 * forever for everyone already running the app.
 *
 * ## And the extra assets, for exactly the same reason
 *
 * `extraAssets` names files in `public/`, which Vite copies through
 * unhashed — the manifest and the icons. They were listed by URL only, so the
 * same trap was open one door along: editing `manifest.webmanifest` changed no
 * filename, produced a byte-identical `sw.js`, and every existing install kept
 * the old manifest forever. That is not hypothetical — `share_target` lives in
 * that file now (for quick capture), so a change to what
 * the share sheet sends is a change nobody would receive. Their bytes go into
 * the version too, and a listed file that is not there is a build failure
 * rather than a silent omission.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = resolve(here, '../src/sw.js');

/**
 * Everything the app needs to *work* with no network.
 *
 * This is a different question from the bundle budget, and conflating them is
 * a trap. The budget asks "what blocks first paint", and deliberately excludes
 * the editor. Offline asks "what does the app need to be usable", and an
 * offline start that renders the shell and then cannot load the editor is not
 * usable at all (§17).
 *
 * So: the entry graph, plus the first level of dynamic imports and their
 * static dependencies. That covers the editor, the Markdown preview (a tile left
 * in preview mode must open offline) and the Argon2id wasm needed to unlock.
 * Not the twenty code grammars, which are a level deeper (the editor
 * imports them dynamically) and would have a user downloading Kotlin support
 * to install a notepad. Not the Firebase adapter either: it is only useful
 * when there is a network, which is the case this cache does not cover.
 *
 * The filename-pattern version of this precached fifteen files, because
 * Rollup names chunks after their module and almost every npm package has an
 * `index.js`.
 */
// Matches the Firebase SDK and the adapter module itself — deliberately NOT
// `adapters/firebase/config.ts`, which is a handful of strings the entry
// imports statically. Matching the whole directory excluded the entry chunk
// and left the precache with no application code in it at all.
const NETWORK_ONLY_MODULES = /adapters[/\\]firebase[/\\]adapter|node_modules[/\\]@?firebase[/\\]/;

function shellAssets(bundle) {
  const chunks = Object.values(bundle).filter((output) => output.type === 'chunk');
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));

  const isNetworkOnly = (chunk) =>
    (chunk.moduleIds ?? []).some((id) => NETWORK_ONLY_MODULES.test(id));

  /** Walk static imports only, from a set of starting chunks. */
  const walkStatic = (starts, into) => {
    const queue = [...starts];
    while (queue.length > 0) {
      const fileName = queue.pop();
      if (into.has(fileName)) continue;
      const chunk = byFile.get(fileName);
      if (chunk && isNetworkOnly(chunk)) continue;
      into.add(fileName);
      if (chunk) for (const imported of chunk.imports) queue.push(imported);
    }
  };

  const reachable = new Set();
  const entries = chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
  walkStatic(entries, reachable);

  // One level of dynamic imports: the editor and the KDF, not the grammars.
  const firstLevelDynamic = entries.flatMap((fileName) => byFile.get(fileName)?.dynamicImports ?? []);
  walkStatic(firstLevelDynamic, reachable);

  const styles = Object.keys(bundle).filter((fileName) => fileName.endsWith('.css'));

  return [...reachable, ...styles];
}

/**
 * Every HTML document in the build, as `[urlPrefix, documentUrl]`, longest
 * prefix first so the worker can pick by `startsWith`.
 *
 * `index.html` becomes `['/', '/index.html']` and is therefore always last —
 * the fallback that catches everything the app's client-side state routes
 * itself.
 */
function shells(bundle) {
  return Object.keys(bundle)
    .filter((fileName) => fileName.endsWith('.html'))
    .map((fileName) => [`/${fileName.replace(/index\.html$/, '')}`, `/${fileName}`])
    .sort((a, b) => b[0].length - a[0].length);
}

/**
 * The bytes of one `extraAssets` entry, read out of `public/`.
 *
 * Loud on a miss, like the shell check below and for the same reason: a
 * precache entry that does not exist fails at `cache.addAll` in the browser —
 * which aborts the whole install, leaving the user on the previous build with
 * nothing to say why.
 */
function readExtraAsset(publicDir, url) {
  const path = resolve(publicDir, url.replace(/^\/+/, ''));
  if (!publicDir || !existsSync(path)) {
    throw new Error(
      `service-worker plugin: extraAssets names "${url}", which is not in the public directory. ` +
        'It would be precached, fail cache.addAll, and abort every install.',
    );
  }
  return readFileSync(path);
}

export function serviceWorkerPlugin({ extraAssets = [] } = {}) {
  /** Where `extraAssets` are read from, for the version hash. Set by `configResolved`. */
  let publicDir = '';

  return {
    name: 'hushjot-service-worker',
    apply: 'build',
    // After Vite's own HTML plugin, so `index.html` is in the bundle by the
    // time `generateBundle` runs and its bytes can go into BUILD_VERSION.
    // Without this the shell is simply absent and the version silently omits
    // it — a fail-quiet that a two-build test caught and nothing else would.
    enforce: 'post',

    configResolved(config) {
      publicDir = config.publicDir;
    },

    generateBundle(_options, bundle) {
      const built = shellAssets(bundle).map((fileName) => `/${fileName}`);
      const documents = shells(bundle);
      // Both spellings of each document: the directory a link points at, and
      // the file the worker looks up. `cache.addAll` fetches each, and Hosting
      // serves the same bytes for both.
      const assets = [...documents.flat(), ...built, ...extraAssets];

      // The cache name changes whenever any precached file does, which is what
      // makes `activate` drop the previous cache at exactly the right moment.
      //
      // The asset *names* carry their own content hashes, so listing them is
      // enough for everything except `index.html`, which is never hashed. A
      // shell-only edit — the inline pre-hydration style, a meta tag, an
      // `integrity` attribute — would otherwise produce a byte-identical
      // `sw.js`, the browser would see no update, and the shell would never
      // reach anyone already running the app. That is a stale-forever bug now
      // the shell is served cache-first, so the shell's own bytes go into the
      // version too.
      const sources = documents.map(([, file]) => bundle[file.slice(1)]?.source);
      if (documents.length === 0 || sources.some((source) => typeof source !== 'string')) {
        // Loudly, because this failure is otherwise invisible: the version would
        // simply stop tracking a shell, updates would stop reaching anyone
        // already running the app, and every build would still look fine.
        // Reached only if Vite reorders plugins out from under `enforce: 'post'`.
        throw new Error(
          'service-worker plugin: an HTML entry is missing from the bundle, so BUILD_VERSION ' +
            'cannot cover every shell. Check the entries and plugin ordering in vite.config.ts.',
        );
      }

      const hash = createHash('sha256').update(assets.join('\n'));
      for (const source of sources) {
        // A separator no filename or markup can contain, so "assets then
        // shells" cannot collide with a different split of the same bytes.
        hash.update('\u0000').update(source);
      }
      for (const url of extraAssets) {
        hash.update('\u0000').update(readExtraAsset(publicDir, url));
      }
      const version = hash.digest('hex').slice(0, 12);

      const source = readFileSync(SW_SOURCE, 'utf8')
        .replace("'__BUILD_VERSION__'", JSON.stringify(version))
        .replace("['__BUILD_ASSETS__']", JSON.stringify(assets, null, 2))
        .replace("[['__BUILD_SHELLS__']]", JSON.stringify(documents, null, 2));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
