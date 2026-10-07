/**
 * Almacén de fragmentos de grabación en IndexedDB (origen de la extensión).
 *
 *   recordings: { id, createdAt, mimeType }
 *   chunks:     { recordingId, seq, blob }   clave [recordingId, seq]
 *
 * Chrome guarda en disco los Blobs de IndexedDB, y los Blobs que se leen de
 * vuelta están respaldados por archivo. Así, ni la grabación en curso ni el
 * Blob final retienen el vídeo completo en RAM.
 *
 * Funciona en el offscreen (escritura) y en el service worker (limpieza).
 * La conexión y el versionado de la base de datos viven en shared/database.js.
 */

import { STORES, asPromise, openDatabase, transaction as runTransaction } from '../shared/database.js';

const RECORDINGS = STORES.SESSIONS;
const CHUNKS = STORES.CHUNKS;

async function transaction(storeNames, mode, work) {
  return runTransaction(await openDatabase(), storeNames, mode, work);
}

const chunkRange = (recordingId) => IDBKeyRange.bound([recordingId, 0], [recordingId, Infinity]);

export function createRecording(id, { mimeType }) {
  return transaction([RECORDINGS], 'readwrite', ({ recordings }) => {
    recordings.put({ id, mimeType, createdAt: Date.now() });
  });
}

export function appendChunk(recordingId, seq, blob) {
  return transaction([CHUNKS], 'readwrite', ({ chunks }) => {
    chunks.put({ recordingId, seq, blob });
  });
}

export function countChunks(recordingId) {
  return transaction([CHUNKS], 'readonly', ({ chunks }) => asPromise(chunks.count(chunkRange(recordingId))));
}

/** Une los fragmentos en orden en un único Blob (sin copiarlos a memoria). */
export async function assembleRecording(recordingId, type) {
  const rows = await transaction([CHUNKS], 'readonly', ({ chunks }) => asPromise(chunks.getAll(chunkRange(recordingId))));
  return new Blob(
    rows.map((row) => row.blob),
    { type },
  );
}

export function deleteRecording(recordingId) {
  return transaction([RECORDINGS, CHUNKS], 'readwrite', ({ recordings, chunks }) => {
    chunks.delete(chunkRange(recordingId));
    recordings.delete(recordingId);
  });
}

/** Borra todo excepto `keepId`. Elimina restos de grabaciones anteriores. */
export async function deleteAllRecordings({ keepId = null } = {}) {
  const ids = await transaction([RECORDINGS], 'readonly', ({ recordings }) => asPromise(recordings.getAllKeys()));
  await transaction([RECORDINGS, CHUNKS], 'readwrite', ({ recordings, chunks }) => {
    if (keepId == null) {
      recordings.clear();
      chunks.clear();
      return;
    }
    for (const id of ids) {
      if (id === keepId) continue;
      recordings.delete(id);
      chunks.delete(chunkRange(id));
    }
  });
}

export async function storageSummary() {
  return transaction([RECORDINGS, CHUNKS], 'readonly', async ({ recordings, chunks }) => ({
    recordings: await asPromise(recordings.count()),
    chunks: await asPromise(chunks.count()),
  }));
}
