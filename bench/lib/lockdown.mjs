/**
 * The two rulesets a lockdown drill switches between: the real rules, and the
 * cost kill switch's lockdown ruleset (`private/killswitch/lockdown.rules`).
 *
 * The lockdown file is not published, so a public checkout falls back to an
 * equivalent written here: refuse every request, except a `get` of the
 * sentinel (`src/core/sync/pause.ts`). The real file is preferred whenever it
 * exists, so the operator's runs drill the ruleset that would really be
 * released.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const privateLockdown = resolve(repoRoot, 'private/killswitch/lockdown.rules');

const FALLBACK = `rules_version = '2';
// HUSHJOT-LOCKDOWN (bench fallback; the real one is private/killswitch/lockdown.rules)
service cloud.firestore {
  match /databases/{database}/documents {
    match /status/lockdown {
      allow get: if true;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
`;

export const lockdownRules = () =>
  existsSync(privateLockdown) ? readFileSync(privateLockdown, 'utf8') : FALLBACK;

export const normalRules = () => readFileSync(resolve(repoRoot, 'firestore.rules'), 'utf8');
