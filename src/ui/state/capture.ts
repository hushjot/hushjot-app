/**
 * Collecting a share the operating system handed to the service worker.
 *
 * Android's share sheet POSTs to `/capture`; `src/sw.js` reads the body, parks
 * it in memory and answers with the app shell. This is the other half: the
 * page asks for it, holds it, and hands it to `App.svelte` once the vault is
 * open.
 *
 * ## Why this runs before the app mounts
 *
 * The worker holds the text in memory and can be terminated at any moment
 * (`src/sw.js` says why it is memory and not the Cache API). So the claim must
 * not wait for the app to boot, and it certainly must not wait for someone to
 * type a passphrase — an unlock takes as long as it takes. `main.ts` calls
 * `claimSharedText()` beside `captureInstallPrompt()`, for the same reason
 * that one is there: the moment has passed by the time a component could ask.
 *
 * From the claim onwards the text lives in this module's memory, exactly as an
 * open note's text does, and goes to storage only through the vault.
 *
 * ## Why the path is checked first
 *
 * A normal load has a controller too, so an unconditional handshake would put
 * a message round trip on every cold start to be told "nothing". `/capture` is
 * reachable only as the share target, so the pathname is a free filter — and
 * it also means a browser running an *older* worker, one with no claim
 * handler, never waits on a reply that is not coming.
 *
 * Deliberately not a rune and deliberately small: it is eagerly imported, and
 * `bench/size.mjs` charges every byte of it to the 160 KB critical path.
 * Everything that decides what a captured note *looks like* is in
 * `core/capture/`, behind a dynamic import.
 */

import type { SharedText } from '../../core/capture/compose.ts';

/** Must match `CAPTURE_PATH` in `src/sw.js` and `share_target.action` in the manifest. */
const CAPTURE_PATH = '/capture';

/**
 * How long to wait for the worker's reply.
 *
 * The worker answers from memory, so a reply is immediate or it is never
 * coming — an old worker with no claim handler, or one that was replaced
 * between the response and this call. Waiting longer only delays the app.
 */
const CLAIM_TIMEOUT_MS = 2_000;

let claim: Promise<SharedText | null> | null = null;

export function claimSharedText(): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname !== CAPTURE_PATH) return;

  claim = ask();
  // Clear the URL as soon as there is something to clear it for. Reloading a
  // POST navigation re-submits the form — the browser asks first, but a page
  // that offers to send someone's note again is not a page we want to have.
  void claim.then((shared) => {
    if (shared) clearCaptureUrl();
  });
}

function ask(): Promise<SharedText | null> {
  const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
  const controller = container?.controller;
  if (!container || !controller) return Promise.resolve(null);

  return new Promise((resolve) => {
    const finish = (shared: SharedText | null): void => {
      clearTimeout(timer);
      container.removeEventListener('message', onMessage);
      resolve(shared);
    };

    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: string; shared?: SharedText | null } | null;
      if (data?.type === 'capture') finish(data.shared ?? null);
    };

    const timer = setTimeout(() => finish(null), CLAIM_TIMEOUT_MS);
    container.addEventListener('message', onMessage);
    // Without this the events are queued and never delivered: the container
    // only starts dispatching once `onmessage` is assigned or this is called,
    // and `addEventListener` is used here rather than `onmessage` so as not to
    // trample anything else that listens. Optional-called because a browser
    // without it would also be one that dispatches without being asked.
    container.startMessages?.();
    controller.postMessage({ type: 'capture-claim' });
  });
}

/**
 * The share, once. Resolves to `null` when this load was not a share target,
 * when the worker had nothing, or when it never answered.
 *
 * A promise rather than a value because the claim is a round trip and the
 * caller — `startWorkspace()` — can easily win the race on a device that
 * unlocks itself.
 */
export async function takeSharedText(): Promise<SharedText | null> {
  const pending = claim;
  claim = null;
  return pending ? await pending : null;
}

/**
 * Put the address bar back to `/`, dropping the share-target path and any
 * capture fragment.
 *
 * `replaceState`, not `pushState`: there is nothing here worth a back-button
 * entry, and the whole point is that the text stops being in the URL.
 */
export function clearCaptureUrl(): void {
  if (typeof window === 'undefined') return;
  history.replaceState(null, '', '/');
}
