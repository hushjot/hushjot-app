/**
 * Service worker registration.
 *
 * Registered after the app has painted, not before. Registration competes for
 * the same network and main thread as the first render, and §7 is explicit
 * that nothing may be in front of useful UI.
 *
 * Only in production builds: a service worker in front of the dev server
 * serves stale modules and produces bugs that look like the app's fault.
 */

const SW_URL = '/sw.js';

/**
 * Called when a new build has finished installing and is waiting for the user
 * to accept it. Set by `update.svelte.ts`; left undefined in builds that never
 * register a worker.
 */
let onWaiting: ((worker: ServiceWorker) => void) | undefined;

export function onUpdateWaiting(handler: (worker: ServiceWorker) => void): void {
  onWaiting = handler;
}

/**
 * Watch one registration for a build that has installed but not taken over.
 *
 * Three ways to arrive at the same state, and all three are needed: the
 * worker may already be waiting when this page loads (installed during an
 * earlier visit and never accepted), one may be mid-install right now, or one
 * may start installing later while the tab stays open.
 */
function watchForUpdate(registration: ServiceWorkerRegistration): void {
  const announce = (worker: ServiceWorker | null): void => {
    // `controller` is null on the very first load, before any worker has
    // claimed the page. There is no previous build to be swapped out from
    // under anyone, so that install is not an update and must not prompt.
    if (worker && navigator.serviceWorker.controller) onWaiting?.(worker);
  };

  announce(registration.waiting);

  const watchInstalling = (worker: ServiceWorker | null): void => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') announce(worker);
    });
  };

  watchInstalling(registration.installing);
  registration.addEventListener('updatefound', () => watchInstalling(registration.installing));
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const register = () => {
    void navigator.serviceWorker
      .register(SW_URL, { scope: '/' })
      .then(watchForUpdate)
      .catch(() => {
        // A failed registration costs offline support, nothing else. The app is
        // fully functional without it, so this is not worth surfacing.
      });
  };

  // `load` has already fired by the time the app mounts in most cases; handle
  // both so registration is never skipped.
  if (document.readyState === 'complete') {
    // A task, not a microtask: let the first frame finish first.
    setTimeout(register, 0);
  } else {
    window.addEventListener('load', register, { once: true });
  }
}

/**
 * True when the app is running as an installed PWA rather than in a browser
 * tab. Used to decide whether local storage is likely to be evicted: iOS
 * exempts installed sites from the seven-day cap that would otherwise delete
 * an unsynced note (plan issue #6).
 */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari predates the standard property.
    (navigator as { standalone?: boolean }).standalone === true
  );
}
