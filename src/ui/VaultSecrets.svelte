<script lang="ts">
  /**
   * The vault's two secrets, and the four things a person can do to them.
   *
   * `Vault.changePassphrase` existed, correct and unit-tested, and nothing in
   * `src/ui` called it — so the only answer to "somebody may have seen my
   * passphrase" was "remove all data from this device and start again".
   * `private/viability-assessment.md` called that the most important item in the
   * document. This is it.
   *
   * ## Four modes, one file
   *
   * They are the same three screens with different words, a different secret
   * asked for and a different place they are reached from. A file each would
   * be a stylesheet each, and `bench/size.mjs` charges a *dynamically*
   * imported component's CSS to the eager budget regardless — a lazy import
   * saves the JavaScript and never the `<link>`. So: one file, and `mode` is a
   * prop set once rather than a switcher. A security dialog that lets you
   * change which secret it is asking for is how somebody ends up on the wrong
   * screen with something already typed into it. There is exactly one
   * transition, after a successful passphrase change, and it clears every
   * field on the way.
   *
   * ## Why none of `Unlock.svelte` is imported
   *
   * About seventy lines of the passphrase field are duplicated from there, on
   * purpose. `Unlock.svelte` is statically imported by `App.svelte`, so it is
   * eager; extracting a shared `PassphraseField.svelte` would make that file a
   * static import of the eager one and land its bytes *and* its stylesheet in
   * the 160 KB budget that stands between every returning user and their
   * notes. `Unlock.svelte`'s own module comment refuses the same trade for the
   * same reason. Only the dynamic `passphraseTools()` import is genuinely
   * shared — it resolves to the chunk that file already creates, so the ~17 KB
   * of wordlists are not paid twice.
   *
   * ## The copy
   *
   * Does most of the work here. Every one of these actions is irreversible in
   * some direction, three of them have a different true sentence depending on
   * whether the account was reachable, and one of them shows a secret exactly
   * once. `RemoveData.svelte` is the precedent for writing the branch out
   * rather than reaching for a generic phrase that is true of none of them.
   */
  import { untrack } from 'svelte';
  import { looksLikeRecoveryCode } from './state/vault.svelte.ts';
  import type { Strength } from '../core/crypto/passphrase.ts';
  import type {
    RepublishOutcome,
    VaultSecretAction,
    VaultSecretResult,
    VaultSecretsMode,
  } from './vaultSecrets.ts';

  /** The generator and the estimator; see `Unlock.svelte` for why it is lazy. */
  const passphraseTools = () => import('../core/crypto/passphrase.ts');

  interface Props {
    /**
     * Which flow this opened as. Set from the prop once, never bound: each
     * mode is reached from a different place with a different thing already
     * known about the user.
     */
    mode: VaultSecretsMode;
    /** An account exists and is signed in; decides what the copy may promise. */
    signedIn: boolean;
    /**
     * Re-wrap, then publish. Lives in `App.svelte` because it is two writes in
     * an order that has to survive this dialog being closed halfway through.
     */
    run: (action: VaultSecretAction) => Promise<VaultSecretResult>;
    /** One more publish attempt, for the Try again button. */
    republish: () => Promise<RepublishOutcome>;
    onClose: () => void;
  }

  let { mode, signedIn, run, republish, onClose }: Props = $props();

  /**
   * `untrack` because the capture is the point: `mode` is set by the opener
   * before this component exists and never changes under it, and the one
   * transition this dialog allows is a deliberate write below. Tracking it
   * would let a prop change undo that write.
   */
  let activeMode = $state<VaultSecretsMode>(untrack(() => mode));

  let currentPassphrase = $state('');
  let recoveryInput = $state('');
  let next = $state('');
  let confirmation = $state('');
  let showNext = $state(false);
  let strength = $state<Strength | null>(null);
  let localError = $state<string | null>(null);
  let busy = $state(false);
  let retrying = $state(false);

  /**
   * The new recovery code, held here and nowhere else.
   *
   * Deliberately not `vaultStore.pendingRecoveryCode`: `App.svelte`'s
   * `vaultReady` is `isUnlocked && pendingRecoveryCode === null`, so writing
   * that field from a running app tears the app down and raises the unlock
   * wizard behind this dialog. It means "a vault was just created"; this is
   * not that. Dying with the component is correct — a code that can be shown
   * twice is a code that was stored somewhere.
   */
  let newCode = $state<string | null>(null);
  let savedConfirmed = $state(false);

  let finished = $state(false);
  let publish = $state<RepublishOutcome>('no-account');

  let panelEl = $state<HTMLElement | null>(null);

  const MIN_LENGTH = 10;

  type Step = 'form' | 'code' | 'done';

  /**
   * `code` wins unconditionally, the same ordering and the same reason as
   * `Unlock.svelte`'s recovery step: this is the only time that code will ever
   * be on screen, the previous one is already dead, and nothing else this
   * dialog could show is worth more than it. Do not reorder for readability.
   */
  const step = $derived.by<Step>(() => {
    if (newCode !== null) return 'code';
    if (finished) return 'done';
    return 'form';
  });

  /** Modes that ask for a new passphrase as well as an existing secret. */
  const choosesPassphrase = $derived(
    activeMode === 'change-passphrase' || activeMode === 'reset-passphrase',
  );

  /**
   * The estimate is asynchronous and the field is not, so only the newest
   * request may write. Copied from `Unlock.svelte`.
   */
  let strengthSeq = 0;

  $effect(() => {
    const current = next;
    if (!choosesPassphrase) return;
    if (current === '') {
      strength = null;
      return;
    }

    const seq = ++strengthSeq;
    void passphraseTools()
      .then((tools) => tools.estimateStrength(current))
      .then((result) => {
        if (seq === strengthSeq) strength = result;
      })
      .catch(() => {
        // Advice. Losing it must never stop anyone changing a passphrase.
        if (seq === strengthSeq) strength = null;
      });
  });

  /**
   * Focus the first control of each step, and only when the step changes —
   * an error appearing or a strength verdict landing must not yank the caret
   * out of whatever is being typed. Everything but the key is untracked.
   */
  const focusKey = $derived(`${activeMode}:${step}`);
  let focusedKey: string | null = null;
  $effect(() => {
    const key = focusKey;
    const el = panelEl;
    if (!el || key === focusedKey) return;
    focusedKey = key;
    el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  });

  const strengthText = $derived.by(() => {
    if (!strength || next === '') return null;
    const bits = `about ${Math.round(strength.bits)} bits, at a conservative estimate`;

    switch (strength.verdict) {
      case 'common':
        return 'This is a well-known password with a decoration added to it. Pick another one.';
      case 'weak':
        return `Weak — ${bits}. A phrase of several real words beats a short jumble.`;
      case 'fair':
        return `Fair — ${bits}. Another word would help more than another symbol.`;
      case 'strong':
        return `Strong — ${bits}.`;
    }
  });

  const title = $derived.by(() => {
    if (step === 'code') return 'Save your new recovery code';
    switch (activeMode) {
      case 'change-passphrase':
        return step === 'done' ? 'Passphrase changed' : 'Change your passphrase';
      case 'reissue-code':
        return 'Re-issue your recovery code';
      case 'reset-passphrase':
        return step === 'done' ? 'Passphrase set' : 'Set a new passphrase';
      case 'adopt-record':
        return step === 'done' ? 'This device is up to date' : 'Catch this device up';
    }
  });

  const submitLabel = $derived.by(() => {
    switch (activeMode) {
      case 'change-passphrase':
        return busy ? 'Changing…' : 'Change passphrase';
      case 'reissue-code':
        return busy ? 'Issuing…' : 'Re-issue code';
      case 'reset-passphrase':
        return busy ? 'Setting…' : 'Set passphrase';
      case 'adopt-record':
        return busy ? 'Updating…' : 'Update this device';
    }
  });

  /** The wrong-secret line names the secret that was actually asked for. */
  const wrongSecretText = $derived(
    activeMode === 'reset-passphrase'
      ? 'That recovery code does not match this vault.'
      : activeMode === 'change-passphrase'
        ? 'That is not your current passphrase.'
        : 'That is not your passphrase.',
  );

  /**
   * The generic failure says what did *not* happen. A bare "something went
   * wrong" after a security action leaves the user unable to tell whether
   * their passphrase is now the old one, the new one, or neither.
   */
  const unknownErrorText = $derived(
    activeMode === 'reissue-code'
      ? 'Something went wrong and your recovery code has not changed. Please try again.'
      : activeMode === 'adopt-record'
        ? 'Something went wrong and this device has not been changed. Please try again.'
        : 'Something went wrong and your passphrase has not been changed. Please try again.',
  );

  async function looksCommon(candidate: string): Promise<boolean> {
    try {
      const { estimateStrength } = await passphraseTools();
      return (await estimateStrength(candidate)).verdict === 'common';
    } catch {
      // The wordlists failed to load. Refusing the change over a missing
      // advisory check would be the worse failure of the two.
      return false;
    }
  }

  /**
   * The confirmation field is deliberately left empty, as on the create
   * screen: retyping is the only evidence anyone gets that the phrase has
   * actually been saved somewhere.
   */
  async function generate(): Promise<void> {
    localError = null;
    try {
      const { generatePassphrase } = await passphraseTools();
      next = await generatePassphrase();
      confirmation = '';
      showNext = true;
    } catch {
      localError = 'The passphrase generator could not load. Please type one instead.';
    }
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard permission denied — it is on screen to copy by hand.
    }
  }

  /** The existing secret this mode authenticates with. */
  function secret(): string {
    return activeMode === 'reset-passphrase' ? recoveryInput : currentPassphrase;
  }

  function validate(): string | null {
    if (secret() === '') {
      return activeMode === 'reset-passphrase'
        ? 'Enter your recovery code.'
        : 'Enter your passphrase.';
    }
    if (!choosesPassphrase) return null;
    if (next.length < MIN_LENGTH) {
      return `Use at least ${MIN_LENGTH} characters. A short phrase of real words beats a short jumble.`;
    }
    if (activeMode === 'change-passphrase' && next === currentPassphrase) {
      // A no-op re-wrap that reports success is a user who believes they
      // rotated a secret and did not.
      return 'That is the passphrase you already have. Pick a different one.';
    }
    if (next !== confirmation) return 'The two passphrases do not match.';
    return null;
  }

  function action(): VaultSecretAction {
    switch (activeMode) {
      case 'change-passphrase':
        return { kind: 'change-passphrase', current: currentPassphrase, next };
      case 'reset-passphrase':
        return { kind: 'reset-passphrase', code: recoveryInput, next };
      case 'reissue-code':
        return { kind: 'reissue-code', passphrase: currentPassphrase };
      case 'adopt-record':
        return { kind: 'adopt-record', passphrase: currentPassphrase };
    }
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    localError = null;

    const invalid = validate();
    if (invalid) {
      localError = invalid;
      return;
    }
    if (choosesPassphrase && (await looksCommon(next))) {
      localError =
        'That is a well-known password with something added to it, so it is one of the first things an attacker would try. Choose another, or use Generate.';
      return;
    }

    busy = true;
    const result = await run(action());
    busy = false;

    if (!result.ok) {
      localError =
        result.error === 'wrong-secret'
          ? wrongSecretText
          : result.error === 'unavailable'
            ? 'This browser is blocking local storage, so the vault cannot be changed here.'
            : unknownErrorText;
      return;
    }

    publish = result.publish;
    currentPassphrase = '';
    recoveryInput = '';
    next = '';
    confirmation = '';
    showNext = false;
    strength = null;
    newCode = result.code;
    finished = true;
  }

  async function retryPublish(): Promise<void> {
    retrying = true;
    publish = await republish();
    retrying = false;
  }

  /** The one allowed mode transition; see the module comment. */
  function switchToReissue(): void {
    activeMode = 'reissue-code';
    finished = false;
    publish = 'no-account';
    localError = null;
    savedConfirmed = false;
  }

  /**
   * Escape closes the dialog — except on the code screen. That code was minted
   * a second ago, the previous one is already dead, and it is shown exactly
   * once: a stray Escape there is not a closed dialog, it is a recovery code
   * that no longer exists anywhere. `Unlock.svelte` has no Escape at all for
   * this reason; the other steps here need one.
   */
  const dismissable = $derived(!busy && step !== 'code');

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !event.defaultPrevented && dismissable) {
      event.preventDefault();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
  class="backdrop"
  role="presentation"
  onclick={(e) => e.target === e.currentTarget && dismissable && onClose()}
>
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="vault-secrets-title"
    tabindex="-1"
    bind:this={panelEl}
  >
    <h2 id="vault-secrets-title">{title}</h2>

    {#if step === 'form'}
      {#if activeMode === 'change-passphrase'}
        <p class="lede">
          Your notes are not re-encrypted. The key that opens them does not
          change — only the way you unlock it does — so this is instant however
          many notes you have.
        </p>
        <p class="note">
          Your recovery code keeps working. If you are doing this because
          somebody may have seen the old passphrase, re-issue the code as well.
        </p>
      {:else if activeMode === 'reissue-code'}
        <p class="lede">
          A new code replaces the one you have. The old code stops working the
          moment this succeeds, and it cannot be brought back.
        </p>
        <p class="note">Your passphrase does not change.</p>
      {:else if activeMode === 'reset-passphrase'}
        <p class="lede">
          Enter your recovery code and choose a new passphrase. Your notes are
          not re-encrypted — this changes how you unlock them and nothing else.
        </p>
        <p class="warn">
          This does not replace your recovery code. Once you are back in,
          re-issue it if somebody else may have seen it.
        </p>
      {:else}
        <p class="lede">
          Your passphrase was changed on another device. Enter the new one and
          this device will use it too.
        </p>
        <p class="note">
          Nothing here is deleted and nothing is re-encrypted. Your notes and
          your recovery code are unaffected.
        </p>
      {/if}

      <form onsubmit={submit}>
        {#if activeMode === 'reset-passphrase'}
          <label for="vs-code">Recovery code</label>
          <input
            id="vs-code"
            type="text"
            bind:value={recoveryInput}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            autocomplete="off"
            autocapitalize="characters"
            autocorrect="off"
            spellcheck="false"
            data-autofocus
            disabled={busy}
          />
          {#if recoveryInput && !looksLikeRecoveryCode(recoveryInput)}
            <p class="hint">That does not look like a complete recovery code yet.</p>
          {/if}
        {:else}
          <label for="vs-current">
            {activeMode === 'change-passphrase'
              ? 'Current passphrase'
              : activeMode === 'adopt-record'
                ? 'New passphrase'
                : 'Passphrase'}
          </label>
          <input
            id="vs-current"
            type="password"
            bind:value={currentPassphrase}
            autocomplete="current-password"
            data-autofocus
            disabled={busy}
          />
        {/if}

        {#if choosesPassphrase}
          <div class="field-head">
            <label for="vs-next">New passphrase</label>
            <div class="field-actions">
              <button type="button" class="link inline" onclick={() => (showNext = !showNext)}>
                {showNext ? 'Hide' : 'Show'}
              </button>
              <button type="button" class="link inline" onclick={generate} disabled={busy}>
                Generate
              </button>
            </div>
          </div>

          <!-- Two inputs rather than one with a bound `type`: Svelte refuses a
               dynamic type alongside `bind:value`. A generated phrase is
               unusable while masked — nobody can transcribe what they cannot
               read. -->
          {#if showNext}
            <input
              id="vs-next"
              type="text"
              bind:value={next}
              autocomplete="off"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              disabled={busy}
            />
          {:else}
            <input
              id="vs-next"
              type="password"
              bind:value={next}
              autocomplete="new-password"
              disabled={busy}
            />
          {/if}

          {#if strengthText}
            <p class="strength" class:bad={strength?.verdict === 'common'} role="status">
              {strengthText}
            </p>
          {/if}

          {#if showNext && next}
            <div class="row">
              <button type="button" class="ghost" onclick={() => copyText(next)}>
                Copy passphrase
              </button>
            </div>
            <p class="hint spaced">
              Save this in a password manager now. There is no reset, and your
              recovery code is the only other way in.
            </p>
          {/if}

          <label for="vs-confirm">Confirm new passphrase</label>
          <input
            id="vs-confirm"
            type="password"
            bind:value={confirmation}
            autocomplete="new-password"
            disabled={busy}
          />
        {/if}

        {#if localError}
          <p class="error" role="alert">{localError}</p>
        {/if}

        <button type="submit" class="primary" disabled={busy}>{submitLabel}</button>
      </form>

      <button type="button" class="link" onclick={onClose} disabled={busy}>Cancel</button>
    {:else if step === 'code'}
      <p class="lede">
        This is the only way back into your notes if you forget your
        passphrase. It is shown once and cannot be retrieved later.
        <strong>Your old code no longer works.</strong>
      </p>

      <output class="code">{newCode}</output>

      <div class="row">
        <button type="button" class="ghost" data-autofocus onclick={() => copyText(newCode ?? '')}>
          Copy
        </button>
      </div>

      <label class="check">
        <input type="checkbox" bind:checked={savedConfirmed} />
        <span>I have written this down somewhere safe</span>
      </label>

      <p class="warn">
        If you lose both your passphrase and this code, your notes cannot be
        recovered — not by us, and not by anyone. That is what keeps them
        private.
      </p>

      {#if publish === 'published'}
        <p class="hint spaced">Your account has the new key record.</p>
      {:else if publish === 'unreachable'}
        <p class="error">
          We could not reach your account, so a device signing in for the first
          time would still be given the old record. Write this code down
          anyway — it works here, and HushJot will try again the next time it
          syncs.
        </p>
        <div class="row">
          <button type="button" class="ghost" onclick={retryPublish} disabled={retrying}>
            {retrying ? 'Trying…' : 'Try again'}
          </button>
        </div>
      {/if}

      <button type="button" class="primary" disabled={!savedConfirmed} onclick={onClose}>
        Done
      </button>
    {:else}
      {#if activeMode === 'adopt-record'}
        <p class="lede">
          This device now opens with the same passphrase as the rest of your
          account. Nothing was deleted and no note was re-encrypted.
        </p>
      {:else if publish === 'published'}
        <p class="lede">
          Your new passphrase is in place here, and your account has the new
          key record. Your recovery code has not changed.
        </p>
        <p class="note">
          Devices already signed in on this account keep unlocking with their
          old passphrase until you change it there too — they will say so the
          next time they sync.
        </p>
      {:else if publish === 'no-account'}
        <p class="lede">
          Your new passphrase is in place. These notes are on this device only,
          so there is nothing else to update.{signedIn
            ? ''
            : ' Your recovery code has not changed.'}
        </p>
      {:else if publish === 'unreachable'}
        <p class="warn">
          Your new passphrase works on this device. We could not reach your
          account to store the new key record, so a device signing in for the
          first time would still be given the old one. HushJot will try again
          by itself the next time it syncs.
        </p>
        <div class="row">
          <button type="button" class="ghost" onclick={retryPublish} disabled={retrying}>
            {retrying ? 'Trying…' : 'Try again'}
          </button>
        </div>
      {:else}
        <p class="warn">
          Your new passphrase works on this device. This device's vault is not
          the one this account was set up with, so nothing was sent — the notes
          here stay here either way.
        </p>
      {/if}

      {#if activeMode === 'change-passphrase'}
        <!-- The only place in the product where this can be said at the moment
             it is true. The two are separate secrets, and changing one does
             nothing at all to the other. -->
        <p class="note">
          Changed this because somebody may have seen the old one? Re-issue
          your recovery code too — the old code still opens this vault.
          <button type="button" class="inline-link" onclick={switchToReissue}>
            Re-issue recovery code…
          </button>
        </p>
      {:else if activeMode === 'reset-passphrase'}
        <p class="note">Unlock with your new passphrase to open your notes.</p>
      {/if}

      <button type="button" class="primary" data-autofocus onclick={onClose}>
        {activeMode === 'reset-passphrase' ? 'Unlock' : 'Done'}
      </button>
    {/if}
  </div>
</div>

<style>
  /* Above `RemoveData`'s 70: both are reachable from the unlock screen. */
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 8vh 16px 16px;
    z-index: 75;
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
    margin: 0 0 16px;
    color: var(--text-dim);
    line-height: 1.5;
    font-size: 13px;
  }

  .note {
    margin: 0 0 16px;
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--bg-sunken);
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.5;
  }

  .warn {
    margin: 0 0 16px;
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--accent-soft);
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
  }

  form {
    display: flex;
    flex-direction: column;
  }

  label {
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 5px;
  }

  input[type='password'],
  input[type='text'] {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-sunken);
    color: var(--text);
    font: inherit;
    padding: 9px 10px;
    margin-bottom: 14px;
    /* 16px avoids iOS Safari zooming the page on focus (§19). */
    font-size: 16px;
  }

  input:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }

  /* The label and its actions share a line, so revealing or generating a
     passphrase never pushes the field itself around. */
  .field-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .field-actions {
    display: flex;
    gap: 4px;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 2px 0 16px;
    color: var(--text);
    font-size: 13px;
  }

  .check input {
    margin: 0;
    width: 16px;
    height: 16px;
  }

  .code {
    display: block;
    font-family: var(--mono);
    font-size: 14px;
    line-height: 1.7;
    letter-spacing: 0.04em;
    /* Wrap at the dashes, never mid-group: a group split across two lines is
       the easiest way to transcribe this wrongly. */
    word-break: normal;
    overflow-wrap: break-word;
    text-align: center;
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 12px;
    /* Selectable: users will copy this by hand as often as by button. */
    user-select: all;
  }

  .row {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
  }

  .primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--on-accent);
    font: inherit;
    font-weight: 600;
    border-radius: 6px;
    padding: 10px 14px;
    min-height: 42px;
    cursor: pointer;
  }

  .primary:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .ghost {
    border: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text);
    font: inherit;
    border-radius: 6px;
    padding: 6px 12px;
    min-height: 40px;
    cursor: pointer;
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

  .link.inline {
    display: inline;
    width: auto;
    margin: 0;
    padding: 0 4px;
    font-size: 12px;
  }

  .link.inline:disabled,
  .link:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .inline-link {
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    padding: 2px;
    cursor: pointer;
  }

  .hint {
    margin: -8px 0 12px;
    color: var(--text-faint);
    font-size: 12px;
  }

  .hint.spaced {
    margin-top: 0;
  }

  .strength {
    margin: -8px 0 12px;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.5;
  }

  /* Only the verdict that blocks submission is coloured as an error. The rest
     is advice, and advice dressed as a failure is how people learn to click
     past it. */
  .strength.bad {
    color: var(--danger);
  }

  .error {
    margin: 0 0 12px;
    color: var(--danger);
    font-size: 13px;
  }

  @media (max-width: 720px) {
    .backdrop {
      padding: 0;
      overflow-y: auto;
    }

    .panel {
      width: 100%;
      max-width: none;
      min-height: 100%;
      max-height: none;
      border-radius: 0;
      border: 0;
      padding-top: calc(22px + env(safe-area-inset-top));
      padding-bottom: calc(22px + env(safe-area-inset-bottom));
    }
  }
</style>
