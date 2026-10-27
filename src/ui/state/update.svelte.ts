/**
 * "A new version is ready" — and why it asks instead of just doing it.
 *
 * A web app is delivered by its server on every load, so the honest limit of
 * the encryption promise is not the cryptography but the code: a compromised
 * or coerced host could serve one user a backdoored build, and that build
 * could read the passphrase as it is typed. Nothing in a browser prevents
 * that outright (`docs/security.md` § "A malicious or coerced host").
 *
 * What it can do is make the swap **visible**. The service worker installs a
 * new build but does not take over until a client posts `skip-waiting`, and
 * this store is the only thing that sends it. A targeted build therefore
 * cannot arrive silently; it has to ask, on a day the user may remember.
 *
 * It is not a cryptographic defence — the worker enforcing the gate comes from
 * the same host — and it costs something real: a user who ignores the prompt
 * keeps running an old build, bug fixes included. Both are stated in
 * `docs/security.md` rather than hidden behind a reassuring banner.
 */
import { onUpdateWaiting } from './pwa.ts';

class UpdateStore {
  #waiting = $state<ServiceWorker | null>(null);
  #applying = $state(false);
  #dismissed = $state(false);

  /** A new build is installed and waiting for consent. */
  get available(): boolean {
    return this.#waiting !== null && !this.#dismissed;
  }

  get applying(): boolean {
    return this.#applying;
  }

  watch(): void {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    onUpdateWaiting((worker) => {
      this.#waiting = worker;
      // A build that arrives after the user waved the last one away is news
      // again; anything else would let one dismissal hide every future update.
      this.#dismissed = false;
    });

    // The page is now controlled by a worker it did not start with, which only
    // happens once `skipWaiting` has run. Reload so the document and its code
    // come from one build rather than two.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (this.#applying) window.location.reload();
    });
  }

  /** The user's consent. Nothing else in the app may call this. */
  apply(): void {
    if (!this.#waiting) return;
    this.#applying = true;
    this.#waiting.postMessage('skip-waiting');
  }

  /**
   * Hide it for this session only. Deliberately not persisted: a permanent
   * "never ask again" would turn the gate back into a silent update, which is
   * the thing it exists to prevent.
   */
  dismiss(): void {
    this.#dismissed = true;
  }
}

export const updateStore = new UpdateStore();
