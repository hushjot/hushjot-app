/**
 * The vault: where the data-encryption key lives while the app is unlocked,
 * and what happens to it when it is not.
 *
 * ## States
 *
 * ```
 * empty ──create(passphrase)──► unlocked
 * locked ──unlock(passphrase | recovery code)──► unlocked
 * unlocked ──lock()──► locked        (key dropped, device key kept)
 * unlocked ──reset()──► empty        (key, device key and all notes gone)
 * ```
 *
 * ## Stay unlocked on this device
 *
 * Requiring a passphrase — and ~100 ms of Argon2id — on every reload is
 * hostile for a notepad whose promise is "open instantly". So the DEK can be
 * stored in IndexedDB as a **non-extractable `CryptoKey`**: JavaScript on this
 * origin can use it to decrypt, but Web Crypto will not hand its raw bytes to
 * any script.
 *
 * What that trade buys and costs is spelled out in `docs/security.md`. In
 * short: it stops the key being read out and carried off, not code running in
 * the unlocked app from decrypting with it in place, and it is not device
 * binding — the browser's storage underneath is the OS's to protect. It is a
 * per-device choice, and `lock()` revokes it.
 */
import { seal, open } from './envelope.ts';
import {
  createKeyRecord,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  changePassphrase,
  rotateRecoveryCode,
  setPassphraseWithRecoveryCode,
  type KeyRecord,
} from './keyRecord.ts';
import { generateRecoveryCode } from './recoveryCode.ts';
import { disposeKdf, DEFAULT_ARGON2_PARAMS, type Argon2Params } from './kdf.ts';
import { randomBytes, timingSafeEqual } from './bytes.ts';
import { clearJournal } from '../repo/journal.ts';

export type VaultState = 'empty' | 'locked' | 'unlocked';

export interface VaultStorage {
  loadKeyRecord(): Promise<KeyRecord | undefined>;
  saveKeyRecord(record: KeyRecord): Promise<void>;
  loadDeviceKey(): Promise<CryptoKey | undefined>;
  saveDeviceKey(key: CryptoKey): Promise<void>;
  clearDeviceKey(): Promise<void>;
  clearAll(): Promise<void>;
}

export interface CreateResult {
  /** Shown to the user exactly once. Never persisted anywhere by us. */
  recoveryCode: string;
}

export interface VaultOptions {
  /**
   * Argon2id parameters for the *wrapping* side only — create, change, reset.
   * Unlocking always uses whatever the record itself stamped, so this can never
   * weaken an existing vault.
   *
   * A test seam, and a constructor argument rather than a per-call one for
   * exactly that reason: a record keeps the parameters it is given
   * permanently, so a value a caller could pass at the point of use is a
   * downgrade waiting for one template condition to get it wrong. The app has
   * a single construction site (`VaultStore.initialize()`) and it passes
   * nothing. Without the seam, a unit test of this class pays a dozen real
   * 64 MiB derivations on the calling thread; `keyRecord.test.ts` already
   * established the cheaper convention one layer down.
   */
  params?: Argon2Params;
}

export class Vault {
  #dek: CryptoKey | undefined;
  #record: KeyRecord | undefined;
  #state: VaultState = 'empty';

  constructor(
    private readonly storage: VaultStorage,
    private readonly options: VaultOptions = {},
  ) {}

  get #params(): Argon2Params {
    return this.options.params ?? DEFAULT_ARGON2_PARAMS;
  }

  get state(): VaultState {
    return this.#state;
  }

  get isUnlocked(): boolean {
    return this.#state === 'unlocked' && this.#dek !== undefined;
  }

  /** The wrapped key record, for publishing to a backend. Ciphertext only. */
  get record(): KeyRecord | undefined {
    return this.#record;
  }

  /**
   * Accept a key record fetched from the backend.
   *
   * This is what makes a second device work: it has an account but no local
   * vault, so it takes the wrapped record and the user's passphrase unwraps it
   * here. The record is ciphertext, so the backend never had a way in.
   *
   * Refuses to replace an existing local record — that would be a downgrade
   * path where a hostile or stale server could swap the vault out from under
   * a device that already has one.
   */
  async adoptRecord(record: KeyRecord): Promise<VaultState> {
    if (this.#record) return this.#state;
    await this.storage.saveKeyRecord(record);
    this.#record = record;
    this.#state = 'locked';
    return this.#state;
  }

  /**
   * The key used for note encryption. Throws rather than returning undefined:
   * every caller is a code path that must not silently write plaintext.
   */
  get key(): CryptoKey {
    if (!this.#dek) throw new Error('vault is locked');
    return this.#dek;
  }

  /** Determine the starting state, restoring a device key if one exists. */
  async initialize(): Promise<VaultState> {
    this.#record = await this.storage.loadKeyRecord();

    if (!this.#record) {
      this.#state = 'empty';
      return this.#state;
    }

    const deviceKey = await this.storage.loadDeviceKey();
    if (deviceKey) {
      this.#dek = deviceKey;
      this.#state = 'unlocked';
      return this.#state;
    }

    this.#state = 'locked';
    return this.#state;
  }

  /**
   * Create a new vault. Returns the recovery code for one-time display — it is
   * not stored, and cannot be recovered afterwards.
   */
  async create(passphrase: string, options: { rememberDevice?: boolean } = {}): Promise<CreateResult> {
    // The symmetric refusal to `adoptRecord`'s, and the more important of the
    // two. `create` mints a *fresh random* DEK — the passphrase wraps the key,
    // it never derives it — so creating over an existing record orphans every
    // note on the device and every note on the account, with the user's correct
    // passphrase now opening the wrong key. The UI is supposed to make this
    // unreachable; the invariant belongs here, where no template condition can
    // get it wrong.
    if (this.#record) throw new Error('vault already exists');
    const recoveryCode = generateRecoveryCode();
    const { record, dek } = await createKeyRecord(passphrase, recoveryCode, this.#params);

    await this.storage.saveKeyRecord(record);
    this.#record = record;
    this.#dek = dek;
    this.#state = 'unlocked';

    if (options.rememberDevice ?? true) await this.#rememberDevice();
    return { recoveryCode };
  }

  async unlock(passphrase: string, options: { rememberDevice?: boolean } = {}): Promise<void> {
    if (!this.#record) throw new Error('no vault to unlock');
    this.#dek = await unlockWithPassphrase(this.#record, passphrase);
    this.#state = 'unlocked';
    if (options.rememberDevice ?? true) await this.#rememberDevice();
  }

  async unlockWithRecovery(code: string, options: { rememberDevice?: boolean } = {}): Promise<void> {
    if (!this.#record) throw new Error('no vault to unlock');
    this.#dek = await unlockWithRecoveryCode(this.#record, code);
    this.#state = 'unlocked';
    if (options.rememberDevice ?? true) await this.#rememberDevice();
  }

  /**
   * Persist the DEK for this device.
   *
   * The key we already hold is non-extractable, and `CryptoKey` is
   * structured-cloneable, so IndexedDB stores it as-is. No re-derivation: an
   * earlier version of this re-ran Argon2id here and doubled every unlock for
   * nothing.
   */
  async #rememberDevice(): Promise<void> {
    if (!this.#dek) return;
    try {
      await this.storage.saveDeviceKey(this.#dek);
    } catch {
      // Failing to remember the device is an inconvenience, never a failure of
      // the unlock itself.
    }
  }

  /** Forget the key on this device. Notes stay encrypted on disk. */
  async lock(): Promise<void> {
    this.#dek = undefined;
    this.#state = this.#record ? 'locked' : 'empty';
    await this.storage.clearDeviceKey();
    // The journal holds ciphertext for a key we are dropping; leaving it would
    // be litter that a later replay could only fail on.
    clearJournal();
    disposeKdf();
  }

  /**
   * Destroy everything: key record, device key and every note. Used for
   * "log out and remove local data" and for the shared-computer case.
   */
  async reset(): Promise<void> {
    this.#dek = undefined;
    this.#record = undefined;
    this.#state = 'empty';
    await this.storage.clearAll();
    clearJournal();
    disposeKdf();
  }

  async changePassphrase(current: string, next: string): Promise<void> {
    if (!this.#record) throw new Error('no vault');
    const record = await changePassphrase(this.#record, current, next, this.#params);
    await this.storage.saveKeyRecord(record);
    this.#record = record;
  }

  /**
   * Set a new passphrase from the recovery code, for someone who has lost the
   * passphrase entirely.
   *
   * Leaves the vault **locked** on purpose. This re-wraps the record; it does
   * not open it — and typing the new passphrase once, immediately, is the only
   * evidence anybody ever gets that it was actually saved somewhere.
   */
  async setPassphraseWithRecoveryCode(code: string, next: string): Promise<void> {
    if (!this.#record) throw new Error('no vault');
    const record = await setPassphraseWithRecoveryCode(this.#record, code, next, this.#params);
    await this.storage.saveKeyRecord(record);
    this.#record = record;
  }

  /** Issue a new recovery code, invalidating the previous one. */
  async rotateRecoveryCode(passphrase: string): Promise<string> {
    if (!this.#record) throw new Error('no vault');
    const code = generateRecoveryCode();
    const record = await rotateRecoveryCode(this.#record, passphrase, code);
    await this.storage.saveKeyRecord(record);
    this.#record = record;
    return code;
  }

  /**
   * Take the account's record in place of this device's, once the two are
   * *proved* to wrap the same data key.
   *
   * `adoptRecord` above refuses to replace an existing record, and must: that
   * refusal is what stops a hostile or stale server swapping a vault out from
   * under a device that already has one. This is the single case where it can
   * be lifted with evidence instead of trust, and it exists because a
   * passphrase changed on another device otherwise reaches this one never —
   * the account gets the new wrap, this device keeps the old one, and the
   * passphrase the user was trying to retire goes on working here for good.
   *
   * The DEK is non-extractable, so the two keys cannot be compared as bytes.
   * They do not have to be: seal a random probe under the key we hold and ask
   * the candidate to open it. AES-GCM's tag answers exactly the question —
   * same key or not — without either key's material being readable, and a
   * wrong passphrase has already thrown `WrongSecretError` before we get here.
   *
   * Returns false rather than throwing when the proof fails, because "this is
   * a different vault" is a real answer the caller has to show the user, not
   * an error.
   */
  async replaceRecord(record: KeyRecord, passphrase: string): Promise<boolean> {
    if (!this.#dek) throw new Error('vault is locked');
    const candidate = await unlockWithPassphrase(record, passphrase);

    const probe = randomBytes(32);
    try {
      if (!timingSafeEqual(await open(candidate, await seal(this.#dek, probe)), probe)) {
        return false;
      }
    } catch {
      return false;
    }

    await this.storage.saveKeyRecord(record);
    this.#record = record;
    this.#dek = candidate;
    // The stored device key is the *same* key — the proof above is what says
    // so — but it was imported from the old record's wrap, and leaving the two
    // to diverge is a distinction nothing else in here would maintain.
    if (await this.storage.loadDeviceKey()) await this.#rememberDevice();
    return true;
  }
}

/** Exposed for tests: build a vault around an in-memory storage stub. */
export function memoryVaultStorage(): VaultStorage & { readonly record: KeyRecord | undefined } {
  let record: KeyRecord | undefined;
  let deviceKey: CryptoKey | undefined;

  return {
    get record() {
      return record;
    },
    async loadKeyRecord() {
      return record;
    },
    async saveKeyRecord(next) {
      record = next;
    },
    async loadDeviceKey() {
      return deviceKey;
    },
    async saveDeviceKey(key) {
      deviceKey = key;
    },
    async clearDeviceKey() {
      deviceKey = undefined;
    },
    async clearAll() {
      record = undefined;
      deviceKey = undefined;
    },
  };
}
