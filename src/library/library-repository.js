/**
 * Repositorio de metadatos de la biblioteca (IndexedDB, almacén `library`).
 * Solo guarda metadatos: el vídeo y la miniatura viven en OPFS (library-files.js).
 */

import { STORES, asPromise, openDatabase, transaction } from '../shared/database.js';
import { sortRecordings } from './recording-meta.js';

export class RecordingNotFoundError extends Error {
  constructor(id) {
    super(`La grabación ${id} no existe.`);
    this.name = 'RecordingNotFoundError';
    this.id = id;
  }
}

/** @param {{ open?: () => Promise<IDBDatabase> }} [deps] */
export function createLibraryRepository({ open = () => openDatabase() } = {}) {
  const run = async (mode, work) => transaction(await open(), [STORES.LIBRARY], mode, ({ library }) => work(library));

  return {
    /** Inserta un registro nuevo (falla si el id ya existe). */
    add: (record) => run('readwrite', (store) => asPromise(store.add(record))).then(() => record),

    get: (id) => run('readonly', (store) => asPromise(store.get(id))).then((r) => r ?? null),

    /** Todas, más recientes primero. Solo metadatos: no carga vídeos ni miniaturas. */
    list: () => run('readonly', (store) => asPromise(store.getAll())).then(sortRecordings),

    /** Aplica `patch` y devuelve el registro actualizado. */
    async update(id, patch) {
      return run('readwrite', async (store) => {
        const current = await asPromise(store.get(id));
        if (!current) throw new RecordingNotFoundError(id);
        const next = { ...current, ...patch, id };
        await asPromise(store.put(next));
        return next;
      });
    },

    /** Borra el registro. Devuelve false si no existía. */
    async remove(id) {
      return run('readwrite', async (store) => {
        const existed = (await asPromise(store.count(id))) > 0;
        if (existed) await asPromise(store.delete(id));
        return existed;
      });
    },

    count: () => run('readonly', (store) => asPromise(store.count())),
  };
}
