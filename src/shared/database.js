/**
 * Base de datos IndexedDB de la extensión, con versionado y migraciones.
 *
 *   v1 (fases 3-4): almacenes TEMPORALES de grabación
 *       recordings  { id, createdAt, mimeType }          sesiones en curso
 *       chunks      { recordingId, seq, blob }           fragmentos de MediaRecorder
 *   v2 (fase 5): biblioteca PERSISTENTE
 *       library     metadatos de grabaciones terminadas (índice createdAt)
 *   v3 (fase 6): transcripciones
 *       transcripts { recordingId, status, segments, … }  una por grabación
 *
 * Las migraciones son incrementales y solo AÑADEN: nunca borran almacenes ni datos
 * de versiones anteriores.
 */

export const DB_NAME = 'screen-recorder';
export const DB_VERSION = 3;

export const STORES = Object.freeze({
  SESSIONS: 'recordings',
  CHUNKS: 'chunks',
  LIBRARY: 'library',
  TRANSCRIPTS: 'transcripts',
});

/** Aplica las migraciones desde `oldVersion`. Exportada para los tests. */
export function upgradeDatabase(db, oldVersion) {
  if (oldVersion < 1) {
    if (!db.objectStoreNames.contains(STORES.SESSIONS)) db.createObjectStore(STORES.SESSIONS, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STORES.CHUNKS)) db.createObjectStore(STORES.CHUNKS, { keyPath: ['recordingId', 'seq'] });
  }
  if (oldVersion < 2) {
    if (!db.objectStoreNames.contains(STORES.LIBRARY)) {
      const library = db.createObjectStore(STORES.LIBRARY, { keyPath: 'id' });
      library.createIndex('createdAt', 'createdAt');
    }
  }
  if (oldVersion < 3) {
    if (!db.objectStoreNames.contains(STORES.TRANSCRIPTS)) db.createObjectStore(STORES.TRANSCRIPTS, { keyPath: 'recordingId' });
  }
}

const connections = new WeakMap(); // factory de IndexedDB → Promise<IDBDatabase>

/** Abre (una vez por contexto) la base de datos. `idb` es inyectable para los tests. */
export function openDatabase(idb = globalThis.indexedDB, { name = DB_NAME } = {}) {
  let cache = connections.get(idb);
  if (!cache) {
    cache = new Map();
    connections.set(idb, cache);
  }
  if (!cache.has(name)) {
    cache.set(name, new Promise((resolve, reject) => {
      const request = idb.open(name, DB_VERSION);
      request.onupgradeneeded = (event) => upgradeDatabase(request.result, event.oldVersion);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          cache.delete(name);
        };
        resolve(db);
      };
      request.onerror = () => {
        cache.delete(name);
        reject(request.error);
      };
      request.onblocked = () => console.warn('[database] apertura bloqueada por otra pestaña con una versión anterior');
    }));
  }
  return cache.get(name);
}

/** Ejecuta `work(stores)` en una transacción y resuelve cuando se ha confirmado. */
export async function transaction(db, storeNames, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]));
    let result;
    Promise.resolve(work(stores)).then((value) => {
      result = value;
    }, reject);
    tx.oncomplete = () => resolve(result);
    // En el evento error, tx.error aún es null: el error real está en la petición que falló.
    tx.onerror = (event) => reject(event.target?.error ?? tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transacción abortada', 'AbortError'));
  });
}

export const asPromise = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
