/**
 * Account provisioning for the benchmarks.
 *
 * Syncing is invite-only: `firestore.rules` refuses every byte to an address
 * that is not on the allowlist, and the app no longer has a registration form
 * at all. So a benchmark that wants a syncing account has to do what the
 * operator does — create the account, then issue the invitation — before
 * driving the UI.
 *
 * Both calls go straight at the emulators. The Auth emulator accepts any API
 * key, and the Firestore emulator treats `Bearer owner` as an admin
 * credential, which is the same seam `dumpFirestore` already uses to read
 * around the rules.
 */

const PROJECT = process.env.GCLOUD_PROJECT ?? 'teksto-dev';
const AUTH_HOST = '127.0.0.1:9098';
const FIRESTORE_HOST = '127.0.0.1:8085';

/** Create an account the way the console would, bypassing the removed signup form. */
async function createAccount(email, password) {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (!res.ok) throw new Error(`could not create ${email}: HTTP ${res.status} ${await res.text()}`);
}

/** Put an address on the allowlist, as the operator would in the console. */
export async function invite(email) {
  const res = await fetch(
    `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/allowlist?documentId=${encodeURIComponent(email.toLowerCase())}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({
        fields: {
          active: { booleanValue: true },
          note: { stringValue: 'benchmark fixture' },
          addedAt: { integerValue: '1700000000000' },
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`could not invite ${email}: HTTP ${res.status} ${await res.text()}`);
}

/**
 * Flip an existing invitation's `active` flag — revocation, and restoring it.
 *
 * A PATCH rather than a fresh POST so the rest of the record survives, which
 * is the point of revoking by flag instead of by deletion.
 */
export async function setInviteActive(email, active) {
  const res = await fetch(
    `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/allowlist/${encodeURIComponent(email.toLowerCase())}?updateMask.fieldPaths=active`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ fields: { active: { booleanValue: active } } }),
    },
  );
  if (!res.ok) throw new Error(`could not update ${email}: HTTP ${res.status} ${await res.text()}`);
}

/**
 * Everything a benchmark needs before it can sign in: an account that exists
 * and, unless the caller is deliberately testing the uninvited case, an
 * invitation that lets it sync.
 */
export async function provisionAccount(email, password, { invite: shouldInvite = true } = {}) {
  await createAccount(email, password);
  if (shouldInvite) await invite(email);
}

/**
 * Swap the emulator's Firestore rules, as a deploy would — the cost kill
 * switch's lockdown and its restore are both just a new ruleset. The
 * emulator applies it to the next request; open listeners are cut over too.
 */
export async function setRules(content) {
  const res = await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }),
  });
  if (!res.ok) throw new Error(`could not set rules: HTTP ${res.status} ${await res.text()}`);
}
