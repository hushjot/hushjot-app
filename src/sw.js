/// <reference lib="webworker" />
/**
 * Service worker: the app shell, cached so HushJot opens with no network.
 *
 * §17 requires the app to be usable offline once loaded, and §7 wants the
 * shell visible almost immediately on repeat visits. Both come from the same
 * mechanism: precache everything the shell needs at install, then serve it
 * from the cache first.
 *
 * ## What is never cached
 *
 * Firebase Auth and Firestore, and anything that is not a GET. Caching auth
 * responses breaks sign-in in ways that are extremely hard to diagnose — a
 * stale token served from a cache looks like a backend fault, not a cache one
 * (plan issue #12). Those requests go to the network or they fail honestly.
 *
 * ## Freshness, and why a new build waits for the user
 *
 * Asset filenames are content-hashed, so a cache hit is always the right
 * bytes. The shell is served **cache-first**, and a new build does not take
 * over until the user accepts it. That is a deliberate reversal of the
 * obvious design, for a reason set out in `docs/security.md` § "A malicious or
 * coerced host": the server composes and delivers this client on every load,
 * so a host that wanted to read someone's notes would not attack the
 * cryptography — it would serve that one user a backdoored build. Nothing in
 * a web app can prevent that outright. What it can do is refuse to let the
 * swap happen *silently*, which is the difference between an attack nobody can
 * see and one that announces itself.
 *
 * That is why the three pieces below have to agree, and why changing one of
 * them alone re-opens the hole:
 *
 * - `install` does **not** call `skipWaiting()`, so a new worker sits in
 *   `waiting` until a client posts `skip-waiting`.
 * - navigations are answered from **this worker's own precache**, so the code
 *   that runs is the code this worker installed. Network-first here would
 *   defeat the whole thing: the browser would fetch the new `index.html`, and
 *   its new hashed asset URLs would simply miss the cache and be fetched from
 *   the network, so the new build would run while the new worker was still
 *   politely waiting.
 * - `activate` claims clients, so accepting an update takes effect at once.
 *
 * The cost is real and deliberate: a user who ignores the prompt keeps running
 * an old build, bug fixes included.
 *
 * ## Two shells
 *
 * There are two HTML documents: the app, and the share viewer at `/s/`. This
 * worker's scope is the whole origin, so without `BUILD_SHELLS` every
 * navigation — a share link included — would be answered with the app's
 * precached `index.html`, and a recipient following a link on a device that
 * has HushJot installed would be shown a notepad instead of the note. Picking
 * the document by longest matching prefix keeps that from happening *and*
 * keeps the rule above intact: both come from this worker's own precache.
 *
 * ## Quick capture
 *
 * Android's share sheet posts to `/capture`, and this worker is the only
 * thing that ever sees the body (`private/viability-assessment.md` item 16,
 * `docs/security.md` § "Quick capture"). Three deliberate choices:
 *
 * - **POST, not GET.** A `GET` share target would put the user's text in a
 *   query string — in the address bar, in session history, and in Hosting's
 *   access log the moment anything fails to intercept it. For a product whose
 *   claim is that the host cannot read the notes, that is not a detail. A POST
 *   body reaches this worker and stops here.
 * - **Memory, not storage.** The share is held in `pendingCaptures` until the
 *   page that the response creates claims it. It is never written to the Cache
 *   API or IndexedDB, because the vault may be locked and there would be
 *   nothing to encrypt it with — the same reason the crash journal holds
 *   ciphertext only. The cost is real: if this worker is terminated before the
 *   claim, the capture is gone. Losing a capture is recoverable by sharing
 *   again; plaintext on disk is not recoverable at all.
 * - **`waitUntil` until claimed or expired.** That is what keeps the worker
 *   alive across the page load, and what guarantees the entry is dropped even
 *   if the page never arrives.
 *
 * The response is the app shell from this worker's own precache, exactly as a
 * navigation is — the rule above is not relaxed for this path.
 *
 * `BUILD_ASSETS`, `BUILD_VERSION` and `BUILD_SHELLS` are injected at build
 * time by `tools/vite-plugin-sw.mjs`. Editing them here has no effect.
 */

const BUILD_VERSION = '__BUILD_VERSION__';
const BUILD_ASSETS = ['__BUILD_ASSETS__'];
/** `[urlPrefix, documentUrl]`, longest prefix first; `['/', '/index.html']` is last. */
const BUILD_SHELLS = [['__BUILD_SHELLS__']];

// Frozen at the original name: see docs/security.md § "Frozen identifiers".
const CACHE = `teksto-shell-${BUILD_VERSION}`;

/** Hosts whose responses must never be cached. */
const NEVER_CACHE = [
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firestore.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'www.googleapis.com',
];

/** Emulator ports, so local development behaves like production. */
const EMULATOR_PORTS = ['8085', '9098', '9099', '8080'];

/** The manifest's `share_target` action. Must stay in step with the manifest. */
const CAPTURE_PATH = '/capture';

/**
 * How long a share waits for the page that will claim it.
 *
 * Long enough to cover a cold start on a slow phone, short enough that a page
 * that never arrives does not hold plaintext in memory for the life of the
 * worker. The unlock screen does *not* need to fit inside this: the page
 * claims the share as soon as it boots, before any passphrase is typed, and
 * holds it itself from there.
 */
const CAPTURE_TIMEOUT_MS = 60_000;

/**
 * Shares waiting to be claimed, keyed by the client the response creates.
 *
 * Memory only, deliberately — see the note at the top of this file. `'*'` is
 * the key used when a browser gives no `resultingClientId`; a claim that
 * cannot find its own id falls back to it.
 */
const pendingCaptures = new Map();

/** `clientId` -> the function that resolves that share's `waitUntil`. */
const captureWaiters = new Map();

const ANY_CLIENT = '*';

/**
 * Hold the worker open until this share is claimed or gives up.
 *
 * `done` is the only way this promise settles, and it deletes the share before
 * resolving — so there is no path out of here that leaves the text in memory,
 * including the one where the page never arrives at all.
 */
function holdCapture(id) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      captureWaiters.delete(id);
      pendingCaptures.delete(id);
      resolve();
    };
    const timer = setTimeout(done, CAPTURE_TIMEOUT_MS);
    captureWaiters.set(id, done);
  });
}

/**
 * Read the shared fields off the POST body and park them.
 *
 * A body that cannot be read is dropped rather than surfaced: the page still
 * gets the shell, finds no share, and behaves like an ordinary cold start.
 * There is no useful error to show someone who tapped a share sheet.
 */
async function receiveCapture(request, id) {
  try {
    const form = await request.formData();
    const read = (name) => {
      const value = form.get(name);
      return typeof value === 'string' ? value : '';
    };
    pendingCaptures.set(id, { title: read('title'), text: read('text'), url: read('url') });
  } catch {
    // Not a form, or a truncated one. Nothing to hand over.
  }
}

function isBackendRequest(url) {
  if (NEVER_CACHE.some((host) => url.hostname.endsWith(host))) return true;
  if (EMULATOR_PORTS.includes(url.port)) return true;
  // Firestore's streaming endpoints live under these paths.
  return url.pathname.startsWith('/google.firestore') || url.pathname.startsWith('/v1/projects');
}

/**
 * Look a request up in the cache, ignoring `Vary`.
 *
 * Without `ignoreVary` this misses in a way that is very hard to see: a
 * `fetch()` for a URL hits, while the browser's own `<script src>` request for
 * the *same* URL misses, because the stored response carries a `Vary` header
 * and the two requests differ in a header it names. The miss then falls
 * through to `fetch()`, which fails offline, and `respondWith` rejects — so
 * the page loads its shell and then dies on ERR_FAILED for every asset.
 *
 * Ignoring `Vary` is safe here because every entry is either content-hashed or
 * the single shell document; there is no content negotiation to respect.
 */
async function matchCache(request) {
  const direct = await caches.match(request, { ignoreVary: true });
  if (direct) return direct;

  // Last resort: match on path alone, in case the entry was stored under a
  // slightly different Request than the one now being asked for.
  const url = typeof request === 'string' ? request : new URL(request.url).pathname;
  return caches.match(url, { ignoreVary: true });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `reload` bypasses the HTTP cache so a reinstall cannot precache a
      // stale copy of an asset it is about to serve for the next year.
      await cache.addAll(BUILD_ASSETS.map((url) => new Request(url, { cache: 'reload' })));
      // Deliberately no `skipWaiting()` here. This worker stays in `waiting`
      // until a client posts `skip-waiting` — that message is the user's
      // consent to run a build they have not been running until now. See the
      // note at the top of this file; taking over here silently is exactly
      // what the gate exists to prevent.
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith('teksto-shell-') && name !== CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * The precached document for a URL, by longest matching prefix.
 *
 * `fallback` is the request to go to the network for in the one case the cache
 * cannot cover — a worker somehow active without its own shell. The response is
 * not written back, because writing a *newer* shell into *this* version's cache
 * is precisely the silent swap the gate refuses.
 */
async function shellFor(url, fallback) {
  const shell = BUILD_SHELLS.find(([prefix]) => url.pathname.startsWith(prefix));
  const cached = shell ? await matchCache(shell[1]) : undefined;
  if (cached) return cached;
  return fetch(fallback);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Quick capture, and the reason `url` is parsed before the method check:
  // this is the one request on the whole origin that is not a GET and must not
  // be ignored. Without this branch the share sheet's POST falls through to
  // the network, where static Hosting has nothing to answer it with.
  //
  // `waitUntil` is armed synchronously, before anything is awaited, so the
  // worker's lifetime is extended while the body is still being read.
  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname === CAPTURE_PATH) {
    const id = event.resultingClientId || event.clientId || ANY_CLIENT;
    event.waitUntil(holdCapture(id));
    event.respondWith(receiveCapture(request, id).then(() => shellFor(url, request)));
    return;
  }

  if (request.method !== 'GET') return;

  // Cross-origin and backend traffic is left entirely alone: not cached, not
  // intercepted, not transformed.
  if (url.origin !== self.location.origin || isBackendRequest(url)) return;

  // Navigations: the shell this worker precached, and only that. Every asset
  // it references is in the same cache under the same BUILD_VERSION, so the
  // page and its code are always one coherent build.
  //
  // Which shell is decided by the longest matching prefix, so `/s/anything`
  // gets the share viewer and everything else gets the app. Getting this wrong
  // is invisible in development — where no worker is installed — and shows up
  // only as a share link opening the notepad on a device that has the app.
  // `shellFor` above has the rest, including why its network fallback is not
  // written back.
  if (request.mode === 'navigate') {
    event.respondWith(shellFor(url, request));
    return;
  }

  // Everything else on our origin: cache-first. Filenames are content-hashed,
  // so a hit is always correct, and this is what makes a repeat visit paint
  // before the network is consulted at all.
  event.respondWith(
    (async () => {
      const cached = await matchCache(request);
      if (cached) return cached;

      const response = await fetch(request);
      // Only cache complete, same-origin successes. An opaque or partial
      // response cached here would be served forever.
      if (response.ok && response.status === 200 && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});

/**
 * The user's consent to run a new build.
 *
 * Until this arrives, a freshly installed worker stays in `waiting` and the
 * page keeps running the build it started with. `src/ui/state/update.svelte.ts`
 * is the only sender.
 */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') {
    void self.skipWaiting();
    return;
  }

  // The page collecting a share the OS handed us. It replies once — with the
  // share or with null — and the entry is dropped either way, so a second ask
  // cannot produce a second note.
  if (event.data && event.data.type === 'capture-claim') {
    const id = event.source?.id;
    // The client's own key first, then the no-`resultingClientId` fallback.
    // Only the key actually served is released, or a claim from one page would
    // discard a share parked for another.
    const key = id && pendingCaptures.has(id) ? id : ANY_CLIENT;
    event.source?.postMessage({ type: 'capture', shared: pendingCaptures.get(key) ?? null });
    captureWaiters.get(key)?.();
  }
});
