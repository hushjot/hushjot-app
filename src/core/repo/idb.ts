/**
 * Minimal promise wrapper over IndexedDB. No dependency — the platform is
 * enough here, and §28 asks every dependency to justify itself.
 *
 * Prototyped in Phase 0 (`bench/lib/idb.ts`) and promoted unchanged apart from
 * the added `blocked`/`versionchange` handling that a long-lived app needs and
 * a benchmark did not.
 */

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export interface OpenOptions {
  name: string;
  version: number;
  upgrade: (db: IDBDatabase, tx: IDBTransaction, fromVersion: number) => void;
  /**
   * Called when another tab opens a newer schema version. The connection must
   * be closed or that tab's upgrade blocks forever.
   */
  onVersionChange?: () => void;
}

export function openDb(options: OpenOptions): Promise<IDBDatabase> {
  const { name, version, upgrade, onVersionChange } = options;

  return new Promise((resolve, reject) => {
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open(name, version);
    } catch (err) {
      // Safari in private mode and some embedded webviews throw here.
      reject(err);
      return;
    }

    open.onupgradeneeded = (event) => upgrade(open.result, open.transaction!, event.oldVersion);

    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => {
        db.close();
        onVersionChange?.();
      };
      resolve(db);
    };

    open.onerror = () => reject(open.error);
    open.onblocked = () =>
      reject(new Error(`IndexedDB upgrade for "${name}" is blocked by another tab`));
  });
}

export function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    // A blocked delete still completes once other connections close.
    r.onblocked = () => resolve();
  });
}
