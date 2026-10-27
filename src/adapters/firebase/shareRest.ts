/**
 * Read one shared link, over the Firestore REST API, with no SDK.
 *
 * ## Why not the SDK
 *
 * This is the only code path in the product that runs for someone who is not
 * the owner of anything: a recipient with no account, no vault and, usually,
 * no intention of installing a notepad. Loading `firebase/app` +
 * `firebase/firestore` to perform a single unauthenticated `GET` would be tens
 * of kilobytes to do what one `fetch` does, and it is exactly the trade §28
 * asks every dependency to justify. It cannot.
 *
 * The rules are enforced identically either way — the REST endpoint is the
 * same Firestore, and `allow get: if resource.data.expireAt > request.time` is
 * what answers this request. The API key in the URL identifies the project and
 * authorises nothing (`config.ts`); it is already public in the bundle.
 *
 * ## Why every failure looks the same
 *
 * A revoked share answers 404 and an expired one 403, and both are reported to
 * the caller as `null`. Telling them apart would say whether a guessed id was
 * ever a real share, which is the one thing an id is supposed to keep to
 * itself. A wrong *key* is separate and is not this module's business: that
 * fails later, on the GCM tag, exactly as a wrong passphrase does.
 *
 * ## Except a pause
 *
 * A cost lockdown (`core/sync/pause.ts`) refuses every read, so every link
 * answers 403 and would read as expired. After a 403 this asks one more
 * question — a `GET` of the lockdown sentinel, allowed only by the lockdown
 * ruleset — and reports a pause as `SharePausedError`. It leaks nothing about
 * the share: the sentinel's answer is the same whatever id was asked for.
 *
 * ## The fragment never comes here
 *
 * The id goes in the path because Firestore has to be told which document to
 * serve. The key does not, and must never be added to a query string, a
 * header, or an error message — it exists in `location.hash` and in memory and
 * nowhere else.
 */
import { fromBase64, type Bytes } from '../../core/crypto/bytes.ts';
import { firebaseSettings } from './config.ts';
import { LOCKDOWN_SENTINEL } from '../../core/sync/pause.ts';

export interface FetchedShare {
  payload: Bytes;
  expireAt: number;
}

function documentUrl(relative: string): string {
  const { useEmulators, emulatorHost, firestoreEmulatorPort, projectId, apiKey } = firebaseSettings;
  const origin = useEmulators
    ? `http://${emulatorHost}:${firestoreEmulatorPort}`
    : 'https://firestore.googleapis.com';
  const path = `/v1/projects/${projectId}/databases/(default)/documents/${relative}`;
  return `${origin}${path}?key=${encodeURIComponent(apiKey)}`;
}

/** Shared notes cannot be read right now; the link itself may well be fine. */
export class SharePausedError extends Error {}

const plain = { credentials: 'omit', referrerPolicy: 'no-referrer' } as const;

/** Raised when the network failed, as distinct from the share being gone. */
export class ShareUnreachableError extends Error {
  constructor() {
    super('could not reach the sync service');
    this.name = 'ShareUnreachableError';
  }
}

/**
 * The share, or null when the backend will not serve it — revoked, expired, or
 * never there.
 *
 * @throws ShareUnreachableError when the request itself failed, so the viewer
 *   can say "you appear to be offline" rather than "this link is gone".
 */
export async function fetchShare(id: string, signal?: AbortSignal): Promise<FetchedShare | null> {
  let response: Response;
  try {
    // Nothing about this request is authenticated, and attaching an ambient
    // credential to a link a stranger sent would be a way to be tricked into one.
    response = await fetch(documentUrl(`shares/${id}`), { ...plain, ...(signal ? { signal } : {}) });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw new ShareUnreachableError();
  }

  // 404 (gone) and 403 (expired, so the read rule refused it) are the same
  // answer on purpose. See the note at the top.
  // A 404 from the sentinel is the lockdown ruleset allowing the `get`.
  if (
    response.status === 403 &&
    (await fetch(documentUrl(LOCKDOWN_SENTINEL), plain).then((r) => r.status === 404, () => false))
  ) {
    throw new SharePausedError();
  }
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new ShareUnreachableError();

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ShareUnreachableError();
  }

  const fields = (body as { fields?: Record<string, { bytesValue?: string; timestampValue?: string }> }).fields;
  const encoded = fields?.payload?.bytesValue;
  if (typeof encoded !== 'string') return null;

  const expire = fields?.expireAt?.timestampValue;
  return {
    // REST renders `bytes` as standard base64 with padding, not base64url.
    payload: fromBase64(encoded),
    expireAt: expire ? Date.parse(expire) : 0,
  };
}
