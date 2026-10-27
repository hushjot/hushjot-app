/**
 * Starting over: the client half of `POST /hushjot/vault/reset`.
 *
 * For a signed-in user who has lost both the passphrase and the recovery code.
 * Their synced notes are ciphertext nobody can open, and the rules refuse any
 * client a delete of them or of the key record, so every device keeps adopting
 * a vault nobody can unlock. Only a service account can clear that, so the
 * billing API (a separate, closed-source service) does it: it puts a
 * tombstone where the key record was, then deletes notes, versions, folders and
 * shares, then zeroes the storage meter.
 *
 * Two things happen here and the order matters. **Re-authenticate first**: the
 * API refuses an ID token whose `auth_time` is more than a few minutes old, so a
 * session token lifted from a device that was left signed in cannot empty the
 * account on its own. Sign-in is email and password only, so the password is the
 * credential. **Then a forced token refresh**, so the token sent carries the new
 * `auth_time` rather than a cached one minted before it.
 *
 * Everything that can go wrong becomes one `VaultResetFailure`. The mapping is
 * pure and lives apart from the SDK calls so it can be tested without either.
 */
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  type Auth,
} from 'firebase/auth';
import { VaultResetError, type VaultResetFailure } from '../../core/sync/adapter.ts';

/** The word the API wants in the body. Not a secret, a guard against a misfire. */
export const RESET_CONFIRM_WORD = 'erase';

/** What a Firebase Auth error code means for a reset. */
export function failureFromAuthError(error: unknown): VaultResetFailure {
  const code = (error as { code?: string } | null)?.code ?? '';
  if (
    code === 'auth/wrong-password' ||
    code === 'auth/invalid-credential' ||
    code === 'auth/invalid-login-credentials' ||
    code === 'auth/missing-password'
  ) {
    return 'wrong-password';
  }
  if (code === 'auth/too-many-requests') return 'rate-limited';
  if (code === 'auth/network-request-failed') return 'unreachable';
  if (
    code === 'auth/user-token-expired' ||
    code === 'auth/user-mismatch' ||
    code === 'auth/user-not-found' ||
    code === 'auth/user-disabled'
  ) {
    return 'signed-out';
  }
  return 'failed';
}

/** What the API's answer means. `null` is success. */
export function failureFromResponse(status: number, body: unknown): VaultResetFailure | null {
  if (status >= 200 && status < 300) return null;
  const code = (body as { error?: unknown } | null)?.error;
  if (code === 'reauth_required') return 'reauth-required';
  if (status === 401) return 'signed-out';
  // A gateway that never reached the API, or the API's own "Firestore failed
  // part-way": either way the same request again is the repair.
  if (status === 502 || status === 503 || status === 504) return 'unreachable';
  return 'failed';
}

export async function resetVault(auth: Auth, apiUrl: string, password: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.email) throw new VaultResetError('signed-out');

  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  } catch (error) {
    throw new VaultResetError(failureFromAuthError(error));
  }

  let token: string;
  try {
    token = await user.getIdToken(true);
  } catch (error) {
    throw new VaultResetError(failureFromAuthError(error));
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/hushjot/vault/reset`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: RESET_CONFIRM_WORD }),
    });
  } catch {
    throw new VaultResetError('unreachable');
  }

  const body: unknown = await response.json().catch(() => null);
  const failure = failureFromResponse(response.status, body);
  if (failure) throw new VaultResetError(failure);
}
