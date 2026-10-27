/**
 * Install state: the held `beforeinstallprompt` event and whether the app is
 * already installed.
 *
 * Chromium fires `beforeinstallprompt` once, early, and only a listener that
 * exists at that moment can keep it — so `captureInstallPrompt()` runs from
 * `main.ts` before the app mounts, not from the component that shows the
 * button. `preventDefault()` suppresses Chrome's own mini-infobar: the
 * durability banner is the one place that asks.
 */

import { isInstalled } from './pwa.ts';
import { installHint, type InstallHint } from '../install.ts';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

class InstallStore {
  #event = $state<InstallPromptEvent | null>(null);
  #installed = $state(false);

  capture(): void {
    if (typeof window === 'undefined') return;
    this.#installed = isInstalled();
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.#event = event as InstallPromptEvent;
    });
    window.addEventListener('appinstalled', () => {
      this.#event = null;
      this.#installed = true;
    });
  }

  get hint(): InstallHint {
    if (typeof navigator === 'undefined') return null;
    return installHint({
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      canPrompt: this.#event !== null,
      installed: this.#installed,
    });
  }

  /** Shows the browser's install dialog. An event can be used only once. */
  async prompt(): Promise<void> {
    const event = this.#event;
    if (!event) return;
    this.#event = null;
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === 'accepted') this.#installed = true;
  }
}

export const install = new InstallStore();

export function captureInstallPrompt(): void {
  install.capture();
}
