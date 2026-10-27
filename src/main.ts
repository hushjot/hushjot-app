import { mount } from 'svelte';
import App from './ui/App.svelte';
import { registerServiceWorker } from './ui/state/pwa.ts';
import { captureInstallPrompt } from './ui/state/install.svelte.ts';
import { claimSharedText } from './ui/state/capture.ts';
import { updateStore } from './ui/state/update.svelte.ts';

// Remove the inline pre-hydration skeleton the moment the real UI is ready.
document.getElementById('shell')?.remove();

// Before mount: Chromium fires `beforeinstallprompt` once, and early.
captureInstallPrompt();

// Also before mount, and for a related reason: a share from the OS is held in
// the service worker's memory, which can be reclaimed at any moment. Ask for
// it now rather than after the app — or, worse, after an unlock.
claimSharedText();

const target = document.getElementById('app');
if (!target) throw new Error('#app mount point missing');

const app = mount(App, { target });

// Before registering, so the handler exists by the time the registration
// resolves — a worker can already be waiting from an earlier visit, and that
// announcement fires immediately.
updateStore.watch();

// After mount, so registration never competes with the first paint (§7).
registerServiceWorker();

export default app;
