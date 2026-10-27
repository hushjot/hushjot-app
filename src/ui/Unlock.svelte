<script lang="ts">
  /**
   * Vault setup and unlock: the first thing anyone sees.
   *
   * One card, one question at a time — a wizard, not a choice of boxes.
   *
   * It used to be two equal boxes side by side, "this device" and "sign in".
   * That shape had two faults and they were the same fault twice. Nothing on
   * screen said the boxes were alternatives, so a first-time visitor could not
   * tell whether to fill in one, the other or both. And signing in on the right
   * did not finish anything: the passphrase that actually opens the notes
   * appeared in the *left* box, which silently changed from "Use on this
   * device" into "Unlock" while the user was looking somewhere else. The step
   * they had to take next was never where they had just been typing.
   *
   * So the screen asks the question first — sign in, or this device only — and
   * then stays in the same card for whatever follows. A sign-in flows straight
   * on to the passphrase step in place; nothing moves anywhere else.
   *
   * Asking first is also a safety property, not only a nicety. Both boxes being
   * live at once meant someone with an account could choose a passphrase
   * seconds before signing in, and `Vault.create()` mints a *fresh random* DEK
   * — the passphrase wraps the key, it never derives it — so that is a forked
   * vault, permanently. `creationHeld` below closes the last of that window.
   *
   * The recovery code screen is its own step, because there is no choice to
   * make on it (§18: "keep authentication screens extremely lightweight").
   *
   * All four steps live in this one file on purpose. A `ChooseStep.svelte` and
   * a `PassphraseStep.svelte` would be *static* imports from here, so every
   * byte of them would land in the eager graph that `bench:size` budgets — and
   * this component is what stands between every returning user and their notes.
   * One long file is the cheaper answer; §28 is the reason.
   *
   * The copy does the hardest job here. There is no password reset, and saying
   * so vaguely would be worse than not saying it at all — a user who discovers
   * that fact after losing their passphrase has lost their notes.
   */
  import { untrack } from 'svelte';
  import { vaultStore, looksLikeRecoveryCode } from './state/vault.svelte.ts';
  import { syncStore } from './state/sync.svelte.ts';
  import SignInForm from './SignInForm.svelte';
  import type { Strength } from '../core/crypto/passphrase.ts';
  import type { AccountVault } from './accountVault.ts';

  /**
   * The generator and the strength estimate, behind a dynamic import.
   *
   * They are ~17 KB of wordlists and only ever wanted on the *create* path,
   * while this component is the first thing every returning user loads. A
   * static import would put all of it between someone and their notes for the
   * rest of the vault's life, to answer a question asked once. `bench:size` is
   * the gate — a type-only import above erases, this does not.
   */
  const passphraseTools = () => import('../core/crypto/passphrase.ts');

  type Step = 'choose' | 'signin' | 'passphrase' | 'recovery';

  interface Props {
    mode: 'create' | 'unlock';
    /**
     * Signed in with no vault here yet, and what the *account* holds decides
     * what this screen may offer. `'checking'` holds the create form shut
     * while the answer is in flight, because creating during that window mints
     * a fresh random key and forks the vault for good.
     */
    accountVault?: AccountVault;
    onReady: () => void;
    /** A sign-in from the sign-in step succeeded. */
    onSignedIn: () => void;
    /** True when an account is signed in on this device. */
    signedIn: boolean;
    /** True when sync is configured in this build at all. */
    syncAvailable: boolean;
    /**
     * Open the "remove all data from this device" confirmation.
     *
     * This screen is the only exit for someone who has lost both the
     * passphrase and the recovery code. Without it they are stranded here
     * permanently — the vault cannot be opened, and nothing else in the app is
     * reachable while it is shut. The dialog itself is mounted by `App.svelte`
     * so it can render over this screen and over the app alike.
     */
    onRemoveData: () => void;
    /**
     * Open "start over": erase the account's synced data, then this device's.
     *
     * Offered instead of `onRemoveData` when an account is signed in, because
     * for that user removing the device's data alone is a loop — the next
     * sign-in adopts the same unopenable vault from the account. The dialog
     * still offers the device-only removal as a secondary choice.
     */
    onStartOver: () => void;
    /**
     * Open "set a new passphrase from the recovery code".
     *
     * The other half of what the recovery code is for, and the half that was
     * never built: `docs/security.md` has promised "unlock, then set a new
     * passphrase" since Phase 3, and `changePassphrase` asks for the one thing
     * that user does not have. The dialog is mounted by `App.svelte` so it can
     * render over this screen.
     */
    onResetPassphrase: () => void;
    /**
     * Bumped by `App.svelte` each time a passphrase is set from the recovery
     * code. That flow re-wraps the record and leaves the vault *locked*, so
     * the user comes back to this screen — and must come back to the
     * passphrase field, not to the recovery field they were last in with a
     * dead code still in it. `usingRecovery` is this component's own state, so
     * a counter is how the caller reaches it.
     */
    resetSeq: number;
  }

  let {
    mode,
    onReady,
    onSignedIn,
    signedIn,
    syncAvailable,
    onRemoveData,
    onStartOver,
    onResetPassphrase,
    resetSeq,
    accountVault = 'idle',
  }: Props = $props();

  let passphrase = $state('');
  let confirmation = $state('');
  let recoveryInput = $state('');
  let rememberDevice = $state(true);
  let usingRecovery = $state(false);
  let savedConfirmed = $state(false);
  let localError = $state<string | null>(null);
  let showPassphrase = $state(false);
  let strength = $state<Strength | null>(null);

  /** The only genuinely new state: which branch was picked on `choose`. */
  let chosen = $state<'device' | 'account' | null>(null);

  let screenEl = $state<HTMLElement | null>(null);

  const MIN_LENGTH = 10;

  const code = $derived(vaultStore.pendingRecoveryCode);
  const showingRecovery = $derived(code !== null);

  /**
   * A returning user never sees the question: `mode` is already `'unlock'`, so
   * there is nothing to decide. Neither does a build with no sync, nor anyone
   * already signed in — for them the account has answered it.
   */
  const needsChoice = $derived(
    mode === 'create' && syncAvailable && !signedIn && chosen === null,
  );

  const step = $derived.by<Step>(() => {
    // Wins unconditionally. `vaultReady` in `App.svelte` keeps this component
    // mounted until the code is acknowledged, so there is nothing else this
    // screen could usefully be while one is pending — and note `mode` has
    // already flipped to 'unlock' by then. Do not reorder for readability.
    if (showingRecovery) return 'recovery';
    if (needsChoice) return 'choose';
    if (syncAvailable && chosen === 'account' && !signedIn) return 'signin';
    return 'passphrase';
  });

  /**
   * Creating a vault is only safe when we can prove it will not fork one.
   * `'none'` is such a proof (the account holds no key record) and so is
   * `'idle'` (there is no account to fork). `'checking'` is the absence of one
   * — see `accountVault.ts` for everything it covers. `'failed'` is also not a
   * proof, and is the one case that still lets the user through, on purpose.
   * `'paused'` is held like `'checking'`: sync is paused for everyone, so the
   * refusal says nothing about this account, and the wait ends by itself.
   */
  const creationHeld = $derived(
    mode === 'create' && (accountVault === 'checking' || accountVault === 'paused'),
  );

  const canGoBack = $derived(
    step === 'signin' || (step === 'passphrase' && chosen === 'device' && !signedIn),
  );

  /**
   * The estimate is asynchronous and the field is not, so a slow first load
   * could otherwise let an early keystroke's verdict land after a later one's.
   * Only the newest request is allowed to write.
   */
  let strengthSeq = 0;

  $effect(() => {
    const current = passphrase;
    if (mode !== 'create') return;
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
        // A strength readout is advice. Losing it must never stop anyone
        // creating a vault, so this failure is silent by design.
        if (seq === strengthSeq) strength = null;
      });
  });

  /**
   * Move focus to each step's first control, and only when the step changes.
   *
   * The key is not `step` alone, because the create field can be *present but
   * disabled* while `creationHeld`, and `.focus()` on a disabled element is a
   * silent no-op. Focus would be stranded on `<body>` — the button that got us
   * here has been unmounted — with no second chance, since `step` never changes
   * again. Folding "held" into the key means the field takes focus the moment
   * it becomes usable instead.
   *
   * Everything else is deliberately untracked. An error appearing, a strength
   * verdict landing or a `'none'` verdict arriving must not yank the caret out
   * of whatever is being typed. `focusedKey` is a plain `let` for the same
   * reason: writing it must not re-run this.
   *
   * No `tick()`: a Svelte 5 `$effect` already runs after the DOM flush. The
   * panel effect in `Portability.svelte` is the same shape.
   */
  const focusKey = $derived(step === 'passphrase' && creationHeld ? 'held' : step);

  let focusedKey: string | null = null;
  $effect(() => {
    const key = focusKey;
    // Tracked, unlike everything else here: it flips null to element once, on
    // mount, and never again while anyone is typing. Recording the key before
    // the node exists would spend the first — and only — chance to focus it.
    const el = screenEl;
    if (!el || key === focusedKey) return;
    focusedKey = key;
    if (key === 'held') return;
    el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  });

  /**
   * A vault adopted from the account turns Create into Unlock underneath the
   * user. Anything typed into the create fields was for a vault that no longer
   * needs creating, and carrying it across submits a passphrase nobody chose —
   * which comes back as "That passphrase is not correct" and reads as our bug.
   */
  let lastMode: Props['mode'] | null = null;
  $effect(() => {
    const now = mode;
    // First run only records where we started; there is nothing to clear yet.
    if (lastMode === null || now === lastMode) {
      lastMode = now;
      return;
    }
    lastMode = now;
    untrack(() => {
      passphrase = '';
      confirmation = '';
      localError = null;
    });
  });

  /**
   * A passphrase set from the recovery code, in the dialog over this screen.
   * It does not unlock — it re-wraps the record — so the user lands back here
   * and needs the passphrase field, with the spent code cleared out.
   */
  let lastResetSeq: number | null = null;
  $effect(() => {
    const now = resetSeq;
    // First run only records where we started, as `lastMode` above does.
    if (lastResetSeq === null || now === lastResetSeq) {
      lastResetSeq = now;
      return;
    }
    lastResetSeq = now;
    untrack(() => {
      usingRecovery = false;
      recoveryInput = '';
      passphrase = '';
      confirmation = '';
      localError = null;
    });
  });

  const strengthText = $derived.by(() => {
    if (!strength || passphrase === '') return null;
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

  /**
   * Said differently depending on who is waiting. "Checking your account" is
   * right after a sign-in and nonsense for someone who just said they have no
   * account, which is the other way into this wait.
   */
  const statusText = $derived.by(() => {
    if (mode !== 'create') return null;
    if (accountVault === 'paused') {
      return 'Sync is paused for maintenance, so your account cannot be checked for an existing vault yet. This continues by itself when sync resumes.';
    }
    if (accountVault !== 'checking') return null;
    // "Checking your account" is right after a sign-in and nonsense for
    // someone who just said they have no account, which is the other way into
    // this wait — the window before auth has reported at all.
    return signedIn ? 'Checking your account for an existing vault…' : 'Just a moment…';
  });

  const createLede = $derived(
    accountVault === 'paused'
      ? 'If this account already has a vault, this device fetches it as soon as sync resumes, and its passphrase unlocks it here. Nothing needs doing in the meantime.'
      : accountVault === 'none'
      ? "This account does not have a vault yet. The passphrase you choose here becomes its passphrase on every device you sign in on."
      : 'Pick a passphrase to encrypt your notes. It never leaves this device, and it cannot be reset.',
  );

  const unlockLede = $derived(
    accountVault === 'adopted'
      ? 'This account already has a vault. Enter its passphrase to open your notes on this device.'
      : 'Welcome back. Enter your passphrase to open your notes.',
  );

  const errorText = $derived.by(() => {
    if (localError) return localError;
    switch (vaultStore.error) {
      case 'wrong-secret':
        return usingRecovery
          ? 'That recovery code does not match this vault.'
          : 'That passphrase is not correct.';
      case 'unavailable':
        return 'This browser is blocking local storage, so a vault cannot be opened here.';
      case 'unknown':
        return 'Something went wrong. Please try again.';
      default:
        return null;
    }
  });

  function pick(which: 'device' | 'account'): void {
    chosen = which;
    localError = null;
  }

  function back(): void {
    chosen = null;
    localError = null;
  }

  /**
   * Signing out returns to the question. With a vault already here — adopted
   * from the account and saved locally — `mode` is `'unlock'`, `needsChoice`
   * is false, and this correctly stays on the unlock form instead of asking
   * something that has already been settled.
   */
  async function signOut(): Promise<void> {
    // Best-effort, like every other sign-out path: a backend that refuses to
    // answer must not strand someone on a screen with no way back to the
    // question. `chosen = null` is the load-bearing half and always runs —
    // without it, `chosen === 'account'` sends a user who just asked to leave
    // straight back to the sign-in step, in a loop they cannot escape.
    try {
      await syncStore.signOut();
    } catch {
      // Nothing useful to do here; the screen still returns to the question.
    }
    chosen = null;
    localError = null;
  }

  async function submitCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    localError = null;
    // The button is disabled while held; Enter in a field is not.
    if (creationHeld) return;

    if (passphrase.length < MIN_LENGTH) {
      localError = `Use at least ${MIN_LENGTH} characters. A short phrase of real words beats a short jumble.`;
      return;
    }

    // Re-checked here rather than trusting the readout: that one is debounced
    // behind a dynamic import, and a fast typist can submit before it lands.
    // This is the only verdict that blocks — everything else advises.
    if (await looksCommon(passphrase)) {
      localError =
        'That is a well-known password with something added to it, so it is one of the first things an attacker would try. Choose another, or use Generate.';
      return;
    }

    if (passphrase !== confirmation) {
      localError = 'The two passphrases do not match.';
      return;
    }

    await vaultStore.create(passphrase, rememberDevice);
    passphrase = '';
    confirmation = '';
    showPassphrase = false;
  }

  async function looksCommon(candidate: string): Promise<boolean> {
    try {
      const { estimateStrength } = await passphraseTools();
      return (await estimateStrength(candidate)).verdict === 'common';
    } catch {
      // The wordlists failed to load. Refusing to create a vault over a
      // missing advisory check would be the worse failure of the two.
      return false;
    }
  }

  /**
   * The best outcome on this screen is that the user never chooses a
   * passphrase at all: six words from a 1296-word list is ~62 bits, which is
   * beyond argument in a way no hand-picked phrase is.
   *
   * The confirmation field is deliberately left empty. Retyping it is the only
   * evidence we get that the phrase has actually been saved somewhere, and
   * this is a vault with no password reset.
   */
  async function generate(): Promise<void> {
    localError = null;
    try {
      const { generatePassphrase } = await passphraseTools();
      passphrase = await generatePassphrase();
      confirmation = '';
      showPassphrase = true;
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

  async function submitUnlock(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    localError = null;

    const ok = usingRecovery
      ? await vaultStore.unlockWithRecovery(recoveryInput, rememberDevice)
      : await vaultStore.unlock(passphrase, rememberDevice);

    if (ok) {
      passphrase = '';
      recoveryInput = '';
      onReady();
    }
  }

  function finishRecovery(): void {
    vaultStore.acknowledgeRecoveryCode();
    onReady();
  }

  async function copyCode(): Promise<void> {
    if (code) await copyText(code);
  }
</script>

<div class="screen" bind:this={screenEl}>
  <!-- The logo lockup from hushjot.com's og.jpg, drawn inline rather than
       loaded: no request, crisp at any density, and it follows the theme. The
       mark is public/icons/icon.svg. -->
  <header>
    <div class="lockup">
      <svg class="mark" viewBox="0 0 1024 1024" aria-hidden="true">
        <rect width="1024" height="1024" rx="230" fill="#16181A" />
        <path
          d="M290 548 Q512 596 734 548"
          fill="none"
          stroke="#F2F3F5"
          stroke-width="80"
          stroke-linecap="round"
        />
        <rect x="472" y="252" width="80" height="476" rx="8" fill="#FF5A1F" />
      </svg>
      <h1>HushJot</h1>
    </div>
    <p class="tagline">A private, instant notepad for the web.</p>
  </header>

  {#if step === 'recovery'}
    <section class="card" role="group" aria-labelledby="step-title">
      <h2 id="step-title">Save your recovery code</h2>
      <p class="lede">
        This is the only way back into your notes if you forget your passphrase.
        It is shown once and cannot be retrieved later.
      </p>

      <output class="code">{code}</output>

      <div class="row">
        <button type="button" class="ghost" data-autofocus onclick={copyCode}>Copy</button>
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

      <button type="button" class="primary" disabled={!savedConfirmed} onclick={finishRecovery}>
        Continue
      </button>
    </section>
  {:else if step === 'choose'}
    <!-- Asked before anything else because this is the moment the user decides
         what HushJot is to them. Someone who assumes a "cloud notepad" is
         backing them up, and only finds out otherwise when they open their
         other laptop, has been misled by omission. -->
    <section class="card choose" role="group" aria-labelledby="step-title">
      <h2 id="step-title">Get started</h2>
      <p class="lede">Your notes are encrypted on this device either way.</p>

      <button
        type="button"
        class="pick"
        id="choose-account"
        data-autofocus
        onclick={() => pick('account')}
      >
        <strong>Sign in to sync</strong>
        <span>
          Keep your notes in step across your devices. Your account never sees
          what you write.
        </span>
      </button>

      <button type="button" class="pick" id="choose-device" onclick={() => pick('device')}>
        <strong>Use this device only</strong>
        <span>
          No account needed. Notes live only in this browser, and clearing
          browser data deletes them. Export to keep a copy.
        </span>
      </button>
    </section>
  {:else if step === 'signin'}
    <section class="card account" role="group" aria-labelledby="step-title">
      <button type="button" class="back" onclick={back}>Back</button>
      <h2 id="step-title">Sign in to sync</h2>
      <p class="lede">
        Use your HushJot account, then choose or enter the passphrase that
        opens your notes. Accounts and plans are set up at hushjot.com.
      </p>
      <SignInForm {onSignedIn} />
    </section>
  {:else}
    <section class="card local" role="group" aria-labelledby="step-title">
      {#if canGoBack}
        <button type="button" class="back" onclick={back}>Back</button>
      {/if}

      {#if syncAvailable && signedIn}
        <!-- The account is stated here, in the same card as the passphrase,
             rather than in a box of its own. What follows a sign-in is this
             field, and the user should not have to look elsewhere to see that
             the sign-in worked. -->
        <p class="signed-in">
          Signed in as <strong>{syncStore.user?.email}</strong>
          <span aria-hidden="true">·</span>
          <button type="button" class="link inline" onclick={() => void signOut()}>
            Sign out
          </button>
        </p>
      {/if}

      {#if mode === 'create'}
        <h2 id="step-title">
          {accountVault === 'paused' ? 'Sync is paused' : signedIn ? 'Choose a passphrase' : 'Use on this device'}
        </h2>
        <p class="lede">{createLede}</p>

        {#if statusText}
          <!-- The account may already have a vault, in which case this device
               adopts it and this step becomes "Unlock" by itself. Offering
               "Create" before that answer arrives is how a user with the right
               passphrase ends up with the wrong key: `Vault.create` mints a
               fresh random one. `creationHeld` is what holds the form shut, and
               `accountVault.ts` lists everything that counts as not knowing
               yet — the window before auth has reported at all included. -->
          <p class="status" role="status">{statusText}</p>
        {:else if accountVault === 'failed'}
          <p class="error" role="alert">
            We could not reach your account to look for an existing vault.
            Creating a passphrase now makes a second, separate vault that your
            other devices will not be able to read.
          </p>
        {/if}

        <form onsubmit={submitCreate}>
          <div class="field-head">
            <label for="new-pass">Passphrase</label>
            <div class="field-actions">
              <button
                type="button"
                class="link inline"
                onclick={() => (showPassphrase = !showPassphrase)}
              >
                {showPassphrase ? 'Hide' : 'Show'}
              </button>
              <button
                type="button"
                class="link inline"
                onclick={generate}
                disabled={vaultStore.busy || creationHeld}
              >
                Generate
              </button>
            </div>
          </div>

          <!-- Two inputs rather than one with a bound `type`: Svelte refuses
               a dynamic type alongside `bind:value`. A generated phrase is
               unusable while masked — nobody can transcribe what they cannot
               read — so revealing it is not a convenience here. -->
          {#if showPassphrase}
            <input
              id="new-pass"
              type="text"
              bind:value={passphrase}
              autocomplete="off"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              data-autofocus
              disabled={vaultStore.busy || creationHeld}
            />
          {:else}
            <input
              id="new-pass"
              type="password"
              bind:value={passphrase}
              autocomplete="new-password"
              data-autofocus
              disabled={vaultStore.busy || creationHeld}
            />
          {/if}

          {#if strengthText}
            <p class="strength" class:bad={strength?.verdict === 'common'} role="status">
              {strengthText}
            </p>
          {/if}

          {#if showPassphrase && passphrase}
            <div class="row">
              <button type="button" class="ghost" onclick={() => copyText(passphrase)}>
                Copy passphrase
              </button>
            </div>
            <p class="hint spaced">
              Save this in a password manager now. There is no reset, and the
              recovery code on the next screen is the only other way in.
            </p>
          {/if}

          <label for="confirm-pass">Confirm passphrase</label>
          <input
            id="confirm-pass"
            type="password"
            bind:value={confirmation}
            autocomplete="new-password"
            disabled={vaultStore.busy || creationHeld}
          />

          <label class="check">
            <input type="checkbox" bind:checked={rememberDevice} />
            <span>Stay unlocked on this device</span>
          </label>

          {#if errorText}<p class="error" role="alert">{errorText}</p>{/if}

          <button type="submit" class="primary" disabled={vaultStore.busy || creationHeld}>
            {vaultStore.busy ? 'Creating…' : 'Get started'}
          </button>
        </form>
      {:else}
        <h2 id="step-title">Unlock</h2>
        <p class="lede">{unlockLede}</p>

        <form onsubmit={submitUnlock}>
          {#if usingRecovery}
            <label for="recovery">Recovery code</label>
            <input
              id="recovery"
              type="text"
              bind:value={recoveryInput}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              data-autofocus
              disabled={vaultStore.busy}
            />
            {#if recoveryInput && !looksLikeRecoveryCode(recoveryInput)}
              <p class="hint">That does not look like a complete recovery code yet.</p>
            {/if}
          {:else}
            <label for="pass">Passphrase</label>
            <input
              id="pass"
              type="password"
              bind:value={passphrase}
              autocomplete="current-password"
              data-autofocus
              disabled={vaultStore.busy}
            />
          {/if}

          <label class="check">
            <input type="checkbox" bind:checked={rememberDevice} />
            <span>Stay unlocked on this device</span>
          </label>

          {#if errorText}<p class="error" role="alert">{errorText}</p>{/if}

          <button type="submit" class="primary" disabled={vaultStore.busy}>
            {vaultStore.busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>

        <button
          type="button"
          class="link"
          onclick={() => {
            usingRecovery = !usingRecovery;
            localError = null;
          }}
        >
          {usingRecovery ? 'Use passphrase instead' : 'Use recovery code instead'}
        </button>

        {#if usingRecovery}
          <!-- Offered only on the recovery branch: somebody typing a
               passphrase has not lost it. It is also not an unlock — it
               re-wraps the record and leaves the vault shut — so it sits under
               the toggle rather than beside the Unlock button, where it would
               read as a second way through the same door. -->
          <button type="button" class="link" onclick={onResetPassphrase}>
            Lost your passphrase? Use this code to set a new one
          </button>
        {/if}

        {#if syncAvailable && !signedIn}
          <!-- The wizard's opening question is only asked of a device with no
               vault, so without this a returning user could no longer reach
               sign-in from here at all. The step machine already allows it:
               the `signin` branch tests `chosen`, never `mode`. -->
          <button type="button" class="link" onclick={() => pick('account')}>
            Sign in to sync
          </button>
        {/if}

        <!-- The last resort, and the only one. Both secrets gone means the
             ciphertext here can never be read again by anybody, so the choice
             left is to start over — and until this existed there was no way
             to, from the one screen a user in that position can reach. -->
        {#if signedIn}
          <!-- Signed in, the account holds the vault too, and removing this
               device's copy alone would only bring it back on the next
               sign-in. See `StartOver.svelte`. -->
          <button type="button" class="link quiet" onclick={onStartOver}>
            Lost both? Start over with a new vault
          </button>
        {:else}
          <button type="button" class="link quiet" onclick={onRemoveData}>
            Lost both? Remove all data from this device
          </button>
        {/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100%;
    /* The notch and the home indicator are `.app`'s problem everywhere else,
       but this screen renders *outside* `.app` — it replaces it — so it has to
       respect them itself. `viewport-fit=cover` makes the insets real. */
    padding: max(32px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
      max(32px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    background: var(--bg-sunken);
  }

  header {
    text-align: center;
    margin-bottom: 28px;
    max-width: 640px;
  }

  .lockup {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    margin-bottom: 10px;
  }

  .mark {
    width: 56px;
    height: 56px;
    flex: none;
    /* The mark's square is ink in both themes, so on the dark palette it
       needs an edge to read as a tile, as it does in the og image. */
    border-radius: 13px;
    box-shadow: 0 0 0 1px var(--border);
  }

  h1 {
    margin: 0;
    font-family: var(--mono);
    font-size: 40px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1;
    color: var(--text);
  }

  /* The lit caret after the wordmark. */
  h1::after {
    content: '';
    display: inline-block;
    width: 0.12em;
    height: 1.05em;
    margin-left: 0.08em;
    vertical-align: -0.15em;
    border-radius: 1px;
    background: var(--signal);
  }

  .tagline {
    margin: 0;
    color: var(--text-dim);
    font-size: 15px;
    line-height: 1.5;
  }

  /* One card at a time, so the width lives here rather than on a grid. The
     old two-column rule above 720px went with the second box. */
  .card {
    width: min(420px, 100%);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 24px;
    min-width: 0;
  }

  h2 {
    margin: 0 0 6px;
    font-size: 17px;
    font-weight: 600;
  }

  .lede {
    margin: 0 0 18px;
    color: var(--text-dim);
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
    cursor: pointer;
  }

  .link {
    display: block;
    width: 100%;
    margin-top: 14px;
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    padding: 6px;
  }

  /* Quieter than the other links, and that is the whole styling decision:
     it is a destructive escape hatch sitting under a form people use every
     day, so it must be findable when looked for and never competing with
     Unlock. It only turns red on hover, once the pointer is already on it. */
  .link.quiet {
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .link.quiet:hover {
    color: var(--danger);
  }

  /* The two branches of the opening question. Deliberately large targets with
     their consequence written underneath: the difference between them is what
     happens to the notes, not which one is the button. */
  .pick {
    display: block;
    width: 100%;
    text-align: left;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-sunken);
    color: var(--text);
    font: inherit;
    padding: 14px 16px;
    margin-bottom: 10px;
    /* §19: a comfortable target on a phone, where this is the first thing
       anyone touches. */
    min-height: 44px;
    cursor: pointer;
  }

  .pick:last-child {
    margin-bottom: 0;
  }

  .pick:hover {
    border-color: var(--accent);
  }

  .pick:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .pick strong {
    display: block;
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 3px;
  }

  .pick strong::after {
    content: '›';
    float: right;
    color: var(--text-faint);
    font-weight: 400;
  }

  .pick span {
    display: block;
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.45;
  }

  /* The smallest target on the screen, and it is on the phone path, so it
     carries the §19 minimum too. */
  .back {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    border: 0;
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    padding: 0 8px 0 0;
    margin: -10px 0 2px;
  }

  .back::before {
    content: '‹';
    margin-right: 5px;
    font-size: 15px;
  }

  .back:hover {
    color: var(--text);
  }

  /* `.signed-in` is a bench contract: `bench/phase5.mjs` waits on it to know a
     vault-screen sign-in landed, now that there is no separate "Syncing" card
     to look for. */
  .signed-in {
    margin: 0 0 18px;
    padding: 9px 12px;
    border-radius: 6px;
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.5;
  }

  .signed-in strong {
    color: var(--text);
    font-weight: 600;
    /* Long addresses must wrap rather than widen the card. */
    overflow-wrap: anywhere;
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

  .warn {
    margin: 0 0 16px;
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--accent-soft);
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
  }

  .error {
    margin: 0 0 12px;
    color: var(--danger);
    font-size: 13px;
  }

  .status {
    margin: 0 0 14px;
    color: var(--text-dim);
    font-size: 13px;
  }

  .hint {
    margin: -8px 0 12px;
    color: var(--text-faint);
    font-size: 12px;
  }

  .hint.spaced {
    margin-top: 0;
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

  .link.inline {
    display: inline;
    width: auto;
    margin: 0;
    padding: 0 4px;
    font-size: 12px;
  }

  .link.inline:disabled {
    opacity: 0.55;
    cursor: not-allowed;
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
</style>
