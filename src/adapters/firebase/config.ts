/**
 * Firebase configuration.
 *
 * These values are public by design — Firebase config identifies a project, it
 * does not authorise anything. Access control lives entirely in
 * `firestore.rules`, which is why §15 insists those be tested.
 *
 * Point at the emulators by setting `VITE_FIREBASE_EMULATORS=true`, which the
 * benchmark harnesses do.
 */

export interface FirebaseSettings {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  useEmulators: boolean;
  emulatorHost: string;
  authEmulatorPort: number;
  firestoreEmulatorPort: number;
  /**
   * The billing API, which also performs a vault reset (`vaultReset.ts`) — the
   * one thing a client cannot do itself, because the rules refuse deletes.
   * Its origin must also be in `connect-src`: `vite.config.ts` hands the same
   * variable to the CSP plugin, and `firebase.json` names the default.
   */
  apiUrl: string;
}

/** Kept in step with `DEFAULT_API_URL` in `tools/vite-plugin-csp.mjs`. */
export const DEFAULT_API_URL = 'https://api.hushjot.com';

const env = import.meta.env as Record<string, string | undefined>;

export const firebaseSettings: FirebaseSettings = {
  apiKey: env.VITE_FIREBASE_API_KEY ?? 'emulator-api-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? 'localhost',
  // Frozen at the original name: see docs/security.md § "Frozen identifiers".
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? 'teksto-dev',
  appId: env.VITE_FIREBASE_APP_ID ?? 'teksto-dev-app',
  useEmulators: env.VITE_FIREBASE_EMULATORS === 'true',
  emulatorHost: env.VITE_FIREBASE_EMULATOR_HOST ?? '127.0.0.1',
  authEmulatorPort: Number(env.VITE_FIREBASE_AUTH_PORT ?? 9098),
  firestoreEmulatorPort: Number(env.VITE_FIREBASE_FIRESTORE_PORT ?? 8085),
  apiUrl: (env.VITE_HUSHJOT_API_URL ?? DEFAULT_API_URL).replace(/\/$/, ''),
};

/** True when the app has been given a real project to talk to. */
export const firebaseConfigured =
  firebaseSettings.useEmulators || Boolean(env.VITE_FIREBASE_API_KEY);
