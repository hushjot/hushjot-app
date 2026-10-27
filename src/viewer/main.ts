/**
 * Entry point for the share viewer, `s/index.html`.
 *
 * A second document rather than a route inside the app, and the reasons are
 * not only about bytes:
 *
 * - **It carries no vault.** No IndexedDB, no key record, no unlock form, no
 *   Firebase SDK. Someone following a link from a stranger cannot be shown a
 *   passphrase prompt on the real origin, and no code on this page can reach
 *   the data key even if it wanted to.
 * - **It is small.** A recipient did not ask for a notepad. What loads is a
 *   fetch, the AES-GCM envelope and the Markdown renderer — not the editor,
 *   the sync engine or the search worker.
 * - **A route could not do either.** `src/main.ts` imports `App.svelte`
 *   statically, on purpose (§7: nothing may sit between a returning user and
 *   their notes), so branching inside it would load the whole app first.
 *
 * `bench/size.mjs` budgets this entry separately from the app's for exactly
 * that reason; the two documents are downloaded by different people.
 */
import { mount } from 'svelte';
import Viewer from './Viewer.svelte';

const target = document.getElementById('viewer');
if (!target) throw new Error('#viewer mount point missing');

export default mount(Viewer, { target });
