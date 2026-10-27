/**
 * Reactive wrapper around the vault, so the UI can react to lock state.
 *
 * The DEK itself never becomes reactive state — it is reached through
 * `vault.key` only at the moment of use, so no Svelte proxy ever wraps it and
 * no component can accidentally hold a reference past a lock.
 */
import { Vault, type VaultState } from '../../core/crypto/vault.ts';
import { WrongSecretError } from '../../core/crypto/keyRecord.ts';
import { openVaultStorage, type VaultStorageHandle } from '../../core/repo/vaultStorage.ts';
import { looksLikeRecoveryCode } from '../../core/crypto/recoveryCode.ts';
import {
  serializeKeyRecord,
  deserializeKeyRecord,
} from '../../core/crypto/keyRecord.ts';
import {
  markResealed,
  migratePlaintextRecords,
  resealLegacyRecords,
} from '../../core/repo/migrateToEncrypted.ts';

export type UnlockError = 'wrong-secret' | 'unavailable' | 'unknown';

export class VaultStore {
  #vault: Vault | undefined;
  #storage: VaultStorageHandle | undefined;

  state = $state<VaultState | 'loading'>('loading');
  busy = $state(false);
  error = $state<UnlockError | null>(null);
  /** Shown exactly once after vault creation, then dropped from memory. */
  pendingRecoveryCode = $state<string | null>(null);
  /** The legacy re-seal has been started in this page's lifetime. */
  #resealStarted = false;

  get vault(): Vault {
    if (!this.#vault) throw new Error('vault not initialised');
    return this.#vault;
  }

  get isUnlocked(): boolean {
    return this.state === 'unlocked';
  }

  /** The key, fetched at point of use. Throws when locked, by design. */
  key(): CryptoKey {
    return this.vault.key;
  }

  async initialize(): Promise<VaultState | 'unavailable'> {
    try {
      this.#storage = await openVaultStorage();
    } catch {
      this.error = 'unavailable';
      this.state = 'empty';
      return 'unavailable';
    }

    this.#vault = new Vault(this.#storage);
    this.state = await this.#vault.initialize();
    return this.state;
  }

  async create(passphrase: string, rememberDevice: boolean): Promise<boolean> {
    return this.#run(async () => {
      const { recoveryCode } = await this.vault.create(passphrase, { rememberDevice });
      this.pendingRecoveryCode = recoveryCode;
      this.state = this.vault.state;

      // A database written before the vault existed holds readable records the
      // encrypted codec cannot open. Convert them now, while we have the key,
      // rather than leaving the user with a list of "Unreadable note".
      try {
        await migratePlaintextRecords(this.vault.key);
        // Everything this vault holds was just sealed bound, so its first
        // unlock has nothing to re-seal and need not read every body to learn
        // that.
        await markResealed();
      } catch {
        // The notes are still there and still readable by the old codec; a
        // failed migration must not block a vault that was created correctly.
      }
    });
  }

  /**
   * Re-seal this device's version-1 records as bound ones, once per database
   * (`core/repo/migrateToEncrypted.ts` explains what it does and does not
   * touch). Started by `App.svelte` once the workspace is up, in the
   * background: the notes read fine either way, so nothing waits on it.
   */
  async resealLegacy(): Promise<void> {
    if (this.#resealStarted || !this.isUnlocked) return;
    this.#resealStarted = true;
    try {
      await resealLegacyRecords(this.vault.key);
    } catch {
      // Untouched records are still readable; the next page load tries again.
    }
  }

  async unlock(passphrase: string, rememberDevice: boolean): Promise<boolean> {
    return this.#run(async () => {
      await this.vault.unlock(passphrase, { rememberDevice });
      this.state = this.vault.state;
    });
  }

  async unlockWithRecovery(code: string, rememberDevice: boolean): Promise<boolean> {
    return this.#run(async () => {
      await this.vault.unlockWithRecovery(code, { rememberDevice });
      this.state = this.vault.state;
    });
  }

  async lock(): Promise<void> {
    await this.vault.lock();
    this.state = this.vault.state;
    this.pendingRecoveryCode = null;
  }

  async reset(): Promise<void> {
    await this.vault.reset();
    this.state = 'empty';
    this.pendingRecoveryCode = null;
  }

  acknowledgeRecoveryCode(): void {
    this.pendingRecoveryCode = null;
  }

  /** True when this device already holds a wrapped key record. */
  get hasRecord(): boolean {
    return this.#vault?.record !== undefined;
  }

  /** The record to publish, in a form any backend can store. */
  exportRecord(): unknown | null {
    const record = this.#vault?.record;
    return record ? serializeKeyRecord(record) : null;
  }

  /**
   * Take a key record from the backend. Used on a device that has an account
   * but no local vault — §31's "log into another device and retrieve/decrypt
   * notes".
   */
  async adoptRecord(serialized: unknown): Promise<boolean> {
    if (!this.#vault || this.hasRecord) return false;
    try {
      this.state = await this.#vault.adoptRecord(deserializeKeyRecord(serialized));
      return true;
    } catch {
      // A malformed record must not strand the user on a blank screen; they
      // can still unlock locally or start again.
      return false;
    }
  }

  /**
   * Re-wrap the data key under a new passphrase.
   *
   * Nothing else in the app has to be told. The DEK does not change, so every
   * open note stays open, the device key saved under "stay unlocked" is still
   * the right key, and no note is re-encrypted — `core/crypto/keyRecord.ts`
   * has the reasoning. What *does* go stale is the account's copy of the
   * record, which this store cannot reach; `App.svelte` publishes it.
   */
  async changePassphrase(current: string, next: string): Promise<boolean> {
    return this.#run(() => this.vault.changePassphrase(current, next));
  }

  /**
   * Set a new passphrase from the recovery code, for someone who has lost the
   * passphrase. Leaves the vault locked — see `Vault`.
   */
  async setPassphraseWithRecoveryCode(code: string, next: string): Promise<boolean> {
    return this.#run(() => this.vault.setPassphraseWithRecoveryCode(code, next));
  }

  /**
   * Issue a new recovery code, invalidating the old one.
   *
   * Returns the code rather than parking it in `pendingRecoveryCode`, and that
   * is not a style choice. That field means "a vault was just created and the
   * app is not usable until this is acknowledged" — `App.svelte`'s `vaultReady`
   * reads it exactly that way — so writing it from a running app would blank
   * the screen and raise the unlock wizard behind the dialog. The new code
   * lives in the dialog's own state and dies with it, which is correct: a code
   * that can be shown twice is a code that was stored somewhere.
   *
   * `reissue` rather than the `rotate` of the layer below, because that is the
   * word on screen and this is where the two meet.
   */
  async reissueRecoveryCode(passphrase: string): Promise<string | null> {
    return this.#runValue(() => this.vault.rotateRecoveryCode(passphrase));
  }

  /**
   * Adopt the account's record in place of this device's, when a passphrase was
   * changed elsewhere. False means the two vaults are not the same one.
   */
  async replaceRecord(serialized: unknown, passphrase: string): Promise<boolean> {
    const ok = await this.#runValue(() =>
      this.vault.replaceRecord(deserializeKeyRecord(serialized), passphrase),
    );
    return ok === true;
  }

  /**
   * Shared plumbing: busy flag, error mapping, never leak the secret.
   *
   * Value-returning, because `reissueRecoveryCode` *mints* the code it returns
   * and a boolean would throw the only copy of it away. `null` is the failure
   * signal, so callers must pick a `T` that `null` is not a legitimate value of.
   */
  async #runValue<T>(action: () => Promise<T>): Promise<T | null> {
    this.busy = true;
    this.error = null;
    try {
      return await action();
    } catch (err) {
      const wrongSecret = err instanceof WrongSecretError;
      // A wrong passphrase is an expected outcome and says so on screen. Any
      // other failure collapses to one generic line, which is right for the
      // user and useless for diagnosis — an environment-specific fault (a CSP
      // that blocks the Argon2id WebAssembly, a browser that blocks IndexedDB)
      // otherwise leaves nothing at all behind. The error object never carries
      // the passphrase or the salt (§29), so logging it leaks nothing.
      if (!wrongSecret) console.error('[vault]', err);
      this.error = wrongSecret ? 'wrong-secret' : 'unknown';
      return null;
    } finally {
      this.busy = false;
    }
  }

  /**
   * The common case: an action with no result, reported as success or not.
   *
   * The `true as const` sentinel is load-bearing. Passing a `Promise<void>`
   * action straight through and testing `!== null` also works, because the
   * resolved value is `undefined` — for a reason no reader can see and
   * `strict` will never check. A success value that is structurally different
   * from the failure value is the narrowing TypeScript actually verifies.
   */
  async #run(action: () => Promise<void>): Promise<boolean> {
    const ok = await this.#runValue(async () => {
      await action();
      return true as const;
    });
    return ok === true;
  }
}

export const vaultStore = new VaultStore();
export { looksLikeRecoveryCode };
