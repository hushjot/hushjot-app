/**
 * How this browser installs a web app, for the storage-durability banner.
 *
 * Installing is the one fix for eviction a local-only user can apply in a tap:
 * WebKit exempts Home Screen and Dock apps from the seven-day deletion of
 * script-writable storage, and grants `persist()` to little else.
 *
 * Only Chromium has an API for it (`beforeinstallprompt`). Safari has a menu
 * item and no event, so there the banner can only say where the item is.
 * Firefox desktop cannot install at all, and offering a button that leads
 * nowhere is worse than offering Export alone.
 *
 * But "cannot install" is not "cannot help", and Firefox was reading as the
 * latter because installing was the only fix this file knew about. Firefox is
 * the one browser that *asks* on `navigator.storage.persist()` — Chrome
 * decides by engagement heuristics and Safari by whether you installed — so
 * there the durable-storage permission is the fix, and it is a better one
 * than installing because it is the thing installing was a proxy for. Hence
 * `'firefox'` rather than `null`: a different action, not a dead button.
 *
 * User-agent sniffing, which is normally wrong, is tolerable here because the
 * answer is only wording: a misread browser gets directions for the wrong menu,
 * never a broken action. Pure, so it is testable without a browser.
 */

/**
 * What this browser can be offered.
 *
 * `'prompt'` shows the browser's own dialog; `'ios'` and `'mac-safari'` can
 * only be told where the menu item is; `'firefox'` cannot install at all and
 * is offered durable storage instead. `null` is a browser with neither.
 */
export type InstallHint = 'prompt' | 'ios' | 'mac-safari' | 'firefox' | null;

export interface InstallEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  /** A deferred `beforeinstallprompt` event is being held. */
  canPrompt: boolean;
  installed: boolean;
}

/**
 * An iPhone or an iPad.
 *
 * Extracted from `installHint` because quick capture needs the same answer for
 * a different question — which set of instructions to lead with — and the one
 * place that knows iPadOS lies about being a Mac should stay one place.
 * Unlike the hint, this stays true after the app is installed.
 */
export function isIosLike(userAgent: string, maxTouchPoints: number): boolean {
  // iPadOS reports itself as a Mac; touch points are what give it away.
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export function installHint(env: InstallEnvironment): InstallHint {
  if (env.installed) return null;
  if (env.canPrompt) return 'prompt';

  const ua = env.userAgent;
  // Every iOS browser is WebKit and has "Add to Home Screen" in its share sheet.
  if (isIosLike(ua, env.maxTouchPoints)) return 'ios';
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua)) {
    return 'mac-safari';
  }
  // Every desktop Firefox, on all three platforms: none of them can install,
  // and all of them prompt for persistent storage. iOS Firefox is WebKit and
  // was already answered above.
  if (/Firefox\//.test(ua)) return 'firefox';
  return null;
}

/**
 * Shown when the action cannot be taken for the reader.
 *
 * Safari's two have no API to call at all. Firefox's is different: its button
 * *does* something, and this is the fallback for the one case where it
 * silently cannot — a permission already refused is not re-prompted, so the
 * only way back is the one the browser puts behind the padlock.
 */
export const INSTALL_STEPS: Record<'ios' | 'mac-safari' | 'firefox', string> = {
  ios: 'Tap Share, then “Add to Home Screen”.',
  'mac-safari': 'In Safari, choose File → Add to Dock.',
  firefox:
    'Firefox cannot install web apps. Click the padlock in the address bar, ' +
    'then allow “Store data in persistent storage”.',
};
