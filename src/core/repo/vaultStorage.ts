/**
 * IndexedDB-backed storage for the vault.
 *
 * The key record and the device key live in the `kv` store beside the notes.
 * That is deliberate: "delete the database" must remove the notes *and* the
 * means to read them, with no chance of one outliving the other.
 *
 * `CryptoKey` is structured-cloneable, so a non-extractable key round-trips
 * through IndexedDB with its non-extractability intact — the browser stores an
 * opaque handle, not the bytes.
 */
import { openDb, req, txDone, deleteDb } from './idb.ts';
import { DB_NAME, DB_VERSION, STORE_KV, upgrade } from './schema.ts';
import { HISTORY_DB_NAME } from '../history/names.ts';
import type { VaultStorage } from '../crypto/vault.ts';
import type { KeyRecord } from '../crypto/keyRecord.ts';

const KEY_RECORD = 'vault:keyRecord';
const DEVICE_KEY = 'vault:deviceKey';

export interface VaultStorageHandle extends VaultStorage {
  close(): void;
}

export async function openVaultStorage(dbName = DB_NAME): Promise<VaultStorageHandle> {
  const db = await openDb({ name: dbName, version: DB_VERSION, upgrade });

  const get = async <T>(key: string): Promise<T | undefined> =>
    (await req(db.transaction(STORE_KV).objectStore(STORE_KV).get(key))) as T | undefined;

  const put = async (key: string, value: unknown): Promise<void> => {
    const tx = db.transaction(STORE_KV, 'readwrite');
    tx.objectStore(STORE_KV).put(value, key);
    await txDone(tx);
  };

  const del = async (key: string): Promise<void> => {
    const tx = db.transaction(STORE_KV, 'readwrite');
    tx.objectStore(STORE_KV).delete(key);
    await txDone(tx);
  };

  return {
    loadKeyRecord: () => get<KeyRecord>(KEY_RECORD),
    saveKeyRecord: (record) => put(KEY_RECORD, record),
    loadDeviceKey: () => get<CryptoKey>(DEVICE_KEY),
    saveDeviceKey: (key) => put(DEVICE_KEY, key),
    clearDeviceKey: () => del(DEVICE_KEY),

    async clearAll() {
      // Drop the whole database rather than emptying stores one by one: it is
      // the only way to be sure nothing — including a store added by a future
      // schema version — survives a "remove local data".
      db.close();
      await deleteDb(dbName);
      // Note history is its own database (`core/history/names.ts`), and it
      // holds the same notes' text: it goes with them.
      if (dbName === DB_NAME) await deleteDb(HISTORY_DB_NAME);
    },

    close() {
      db.close();
    },
  };
}
