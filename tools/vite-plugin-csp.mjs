/**
 * Inject a Content Security Policy into the built HTML.
 *
 * `docs/security.md` lists this as the main remaining mitigation for XSS.
 * The threat is specific: the vault key is deliberately kept *usable* by
 * same-origin JavaScript so the app can decrypt notes without a passphrase
 * prompt on every load. Non-extractability stops the key being stolen; it does
 * not stop injected script from using it. A CSP is what makes injection hard
 * in the first place.
 *
 * ## Why `style-src` allows inline
 *
 * CodeMirror builds its theme at runtime by inserting a stylesheet, and the
 * app's pre-hydration shell is an inline `<style>` so the first paint needs no
 * round trip. Neither is a script vector. `script-src` stays strict, which is
 * the part that matters.
 *
 * ## Why `script-src` allows `'wasm-unsafe-eval'`
 *
 * Passphrase stretching is Argon2id, which `hash-wasm` ships as WebAssembly
 * (`src/core/crypto/kdf.worker.ts`). Browsers refuse `WebAssembly.compile`
 * unless `script-src` names `'wasm-unsafe-eval'` — so without it, creating or
 * unlocking a vault fails outright. It is much narrower than `'unsafe-eval'`:
 * it permits WASM compilation and nothing else.
 *
 * Note this meta tag is *not* what governs the KDF worker. A worker fetched
 * over HTTP takes its policy from its own response headers, so what reaches
 * `/assets/kdf.worker-*.js` is the separate `/assets/**` block in
 * `firebase.json` — see "Two policies, not one" in `docs/security.md`, which
 * also explains why that block must not be edited casually (its headers are
 * cached immutably for a year alongside the bytes they were served with).
 *
 * The token is kept here as well so the `deriveInline` fallback in
 * `src/core/crypto/kdf.ts` — the path taken when no Worker is available — is
 * not blocked in the document instead.
 *
 * ## connect-src
 *
 * Production allows the Firebase endpoints and one more origin: the billing
 * API, which the app calls for exactly one thing — a vault reset for a user who
 * has lost both secrets (`src/adapters/firebase/vaultReset.ts`). It is the same
 * `VITE_HUSHJOT_API_URL` the adapter reads, handed in by `vite.config.ts`, and
 * the header in `firebase.json` names the default; change all three together.
 * Emulator hosts are added for development and test builds, so a permissive
 * localhost rule never ships.
 */

/** Kept in step with `DEFAULT_API_URL` in `src/adapters/firebase/config.ts`. */
export const DEFAULT_API_URL = 'https://api.hushjot.com';

const FIREBASE_ENDPOINTS = [
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://firestore.googleapis.com',
  'https://firebaseinstallations.googleapis.com',
  // Firestore's streaming transport upgrades to a websocket.
  'wss://firestore.googleapis.com',
];

const EMULATOR_ENDPOINTS = [
  'http://127.0.0.1:*',
  'http://localhost:*',
  'ws://127.0.0.1:*',
  'ws://localhost:*',
];

export function cspPlugin({ allowEmulators = false, apiUrl = DEFAULT_API_URL } = {}) {
  // Throws at build time on a malformed URL, which is the right time to find out.
  const apiOrigin = new URL(apiUrl).origin;
  return {
    name: 'hushjot-csp',
    apply: 'build',

    transformIndexHtml(html) {
      const connect = ["'self'", ...FIREBASE_ENDPOINTS, apiOrigin];
      if (allowEmulators) connect.push(...EMULATOR_ENDPOINTS);

      const policy = [
        "default-src 'self'",
        // No inline script, no third-party origins. This is the directive
        // doing the real work. `'wasm-unsafe-eval'` is the one concession: the
        // Argon2id implementation is WebAssembly, and `WebAssembly.compile` is
        // refused without it. It permits nothing else — `eval`, `new Function`
        // and inline script all stay blocked. See the note at the top.
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        // Firestore's long-poll transport probes connectivity by loading
        // `https://www.google.com/images/cleardot.gif`. Blocking it produced a
        // console error on every reconnect and interferes with the transport's
        // own network detection, so it is allowed explicitly rather than
        // broadly.
        "img-src 'self' data: https://www.google.com",
        "font-src 'self'",
        `connect-src ${connect.join(' ')}`,
        "worker-src 'self'",
        "manifest-src 'self'",
        // Nothing here is ever framed, and nothing here ever frames anything.
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'none'",
        // `frame-ancestors` is deliberately absent: it is ignored in a meta
        // tag and the browser logs a warning saying so. It is served as a
        // real header instead, from firebase.json.
      ].join('; ');

      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}
