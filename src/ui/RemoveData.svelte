<script lang="ts">
  /**
   * "Remove all data from this device" — the confirmation, and the only place
   * `Vault.reset()` is reachable from.
   *
   * Two people need this and neither had it. Someone on a borrowed machine had
   * no way to take their notes off it: sign-out severed the account and left
   * the vault open, and Lock left the ciphertext and the key record exactly
   * where they were. And someone who lost both the passphrase and the recovery
   * code was stranded on the unlock screen for good, because nothing on that
   * screen could delete a vault it could not open.
   *
   * ## The copy is three different sentences, not one
   *
   * What is honest here depends entirely on where the notes also exist, and
   * getting that wrong is either a false promise or a false alarm:
   *
   * - **Synced.** The account keeps its copy; this is a device being cleaned,
   *   not data being destroyed. Say so — otherwise the warning is theatre and
   *   users learn to click through warnings.
   * - **Local-only.** The notes exist nowhere else. This is the destructive
   *   case, and the export offer is the point of the dialog rather than a
   *   courtesy.
   * - **Locked.** Reached from the unlock screen. Export is *impossible* —
   *   exporting means decrypting, and there is no key — so the button is not
   *   shown at all and the dialog says why rather than offering something that
   *   would fail.
   *
   * ## Export is never chained to the delete
   *
   * `exportZip` resolves when the download is handed to the browser, not when
   * the file is on disk. Wiring "export then remove" to one button would be
   * claiming a guarantee we do not have, so the export is its own press and the
   * destructive button stays behind its own checkbox afterwards.
   *
   * Lazy-loaded (`App.svelte`), like the other dialogs: this is reachable from
   * the unlock screen, which is the critical path `bench:size` budgets.
   */
  import { syncStore } from './state/sync.svelte.ts';

  interface Props {
    /** False on the unlock screen: no key, so nothing can be exported. */
    unlocked: boolean;
    onClose: () => void;
    onConfirm: () => void;
  }

  let { unlocked, onClose, onConfirm }: Props = $props();

  let understood = $state(false);
  let exporting = $state(false);
  let exported = $state(false);
  let error = $state<string | null>(null);
  let removing = $state(false);

  /**
   * Whether the account is known to hold a copy. `firstSyncDone` rather than
   * `signedIn`: a device that has signed in but never completed a cycle has
   * uploaded nothing, and promising it has is the one mistake here that costs
   * somebody their notes.
   */
  const backedUp = $derived(syncStore.signedIn && syncStore.firstSyncDone);
  const pending = $derived(syncStore.pending);

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !event.defaultPrevented && !removing) {
      event.preventDefault();
      onClose();
    }
  }

  async function exportFirst(): Promise<void> {
    if (exporting) return;
    exporting = true;
    error = null;
    try {
      // The dialogless entry point, the same one the ⌘J ⇧A command uses. The
      // whole export chunk is behind this import so it costs nothing until
      // somebody asks for a backup.
      const portability = await import('./portability.ts');
      await portability.exportZip(null);
      exported = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'The export failed.';
    } finally {
      exporting = false;
    }
  }

  function confirm(): void {
    if (!understood || removing) return;
    removing = true;
    onConfirm();
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
  class="backdrop"
  role="presentation"
  onclick={(e) => e.target === e.currentTarget && !removing && onClose()}
>
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="remove-title" tabindex="-1">
    <h2 id="remove-title">Remove all data from this device?</h2>

    <p class="lede">
      Everything HushJot has stored in this browser is deleted. Nothing is sent
      anywhere, and no other device is touched.
    </p>

    <ul class="what">
      <li>All notes and folders</li>
      <li>Note history and recently deleted notes</li>
      <li>Your key record, and the passphrase saved on this device</li>
      <li>Layout, theme and other preferences</li>
    </ul>

    {#if backedUp}
      <p class="outcome kept">
        Your account keeps its copy. Signing in and unlocking — here or on
        another device — brings these notes back.
        {#if pending > 0}
          <strong
            >{pending} change{pending === 1 ? '' : 's'} {pending === 1
              ? 'has'
              : 'have'} not reached your account yet, and that one will be lost.</strong
          >
        {/if}
      </p>
    {:else if unlocked}
      <p class="outcome danger">
        These notes are on this device only. Once removed they cannot be
        recovered — not by us, not by your passphrase, not by signing in.
        Export a copy first if you want to keep them.
      </p>
    {:else}
      <p class="outcome danger">
        The notes on this device are locked, so they cannot be exported from
        here. If you still have your passphrase or your recovery code, go back
        and unlock first — then export. Otherwise there is no way to read them,
        and this is how you start again.
      </p>
    {/if}

    {#if unlocked}
      <button type="button" class="secondary" onclick={() => void exportFirst()} disabled={exporting || removing}>
        {#if exporting}
          Preparing export…
        {:else if exported}
          Export downloaded — export again
        {:else}
          Export a backup first…
        {/if}
      </button>
    {/if}

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <label class="confirm">
      <input type="checkbox" bind:checked={understood} disabled={removing} />
      <span>I understand this cannot be undone</span>
    </label>

    <button type="button" class="destructive" disabled={!understood || removing} onclick={confirm}>
      {removing ? 'Removing…' : 'Remove everything'}
    </button>
    <button type="button" class="link" onclick={onClose} disabled={removing}>Cancel</button>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 8vh 16px 16px;
    z-index: 70;
  }

  .panel {
    width: min(440px, 100%);
    max-height: 84vh;
    overflow-y: auto;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 22px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
  }

  h2 {
    margin: 0 0 8px;
    font-size: 18px;
    font-weight: 600;
  }

  .lede {
    margin: 0 0 12px;
    color: var(--text-dim);
    line-height: 1.5;
    font-size: 13px;
  }

  .what {
    margin: 0 0 14px;
    padding: 10px 12px 10px 28px;
    border-radius: 6px;
    background: var(--bg-sunken);
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.7;
  }

  .outcome {
    margin: 0 0 14px;
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.5;
  }

  .outcome.kept {
    background: var(--bg-sunken);
    color: var(--text-dim);
  }

  .outcome.danger {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--text);
  }

  .outcome strong {
    display: block;
    margin-top: 6px;
    color: var(--text);
  }

  .error {
    margin: 0 0 12px;
    font-size: 12px;
    color: var(--danger);
  }

  .confirm {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 12px;
    font-size: 13px;
    cursor: pointer;
  }

  .confirm input {
    /* A destructive confirmation the thumb can actually hit. */
    width: 18px;
    height: 18px;
    flex: none;
  }

  .secondary {
    width: 100%;
    margin-bottom: 14px;
    border: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text);
    font: inherit;
    border-radius: 6px;
    padding: 9px 14px;
    min-height: 40px;
    cursor: pointer;
  }

  .destructive {
    width: 100%;
    border: 1px solid var(--danger);
    background: var(--danger);
    color: #fff;
    font: inherit;
    font-weight: 600;
    border-radius: 6px;
    padding: 9px 14px;
    min-height: 40px;
    cursor: pointer;
  }

  .destructive:disabled,
  .secondary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .link {
    display: block;
    width: 100%;
    margin-top: 10px;
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    padding: 6px;
  }
  @media (max-width: 720px) {
    .backdrop {
      padding: 0;
      overflow-y: auto;
    }

    .panel {
      width: 100%;
      max-width: none;
      max-height: none;
      min-height: 100%;
      border-radius: 0;
      border: 0;
      padding-top: calc(22px + env(safe-area-inset-top));
      padding-bottom: calc(22px + env(safe-area-inset-bottom));
    }
  }
</style>
