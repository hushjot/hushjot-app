/**
 * The history database's name, on its own so that `vaultStorage.ts` — which is
 * on the critical path and deletes this database with the notes — can import
 * it without pulling the history store into the eager bundle.
 */

// Frozen from day one: see docs/security.md § "Frozen identifiers".
export const HISTORY_DB_NAME = 'teksto-history';
