/**
 * Transcripciones persistentes (IndexedDB, almacén `transcripts`, clave = id de la grabación).
 *
 *   { recordingId, status: 'processing' | 'completed' | 'error',
 *     model, modelRevision, language, createdAt, updatedAt, completedAt,
 *     durationMs, processedMs, segments: [{ start, end, text }], noSpeech,
 *     error: { code, message } | null }
 *
 * Los segmentos se guardan bloque a bloque (appendBlock): si Chrome se cierra a mitad,
 * `processedMs` indica desde dónde reanudar sin repetir trabajo.
 * «Pendiente» = no existe registro. Una cancelación borra el registro.
 */

import { STORES, asPromise, openDatabase, transaction } from '../shared/database.js';

export const TranscriptStatus = Object.freeze({
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  ERROR: 'error',
});

export function createTranscriptRepository({ open = () => openDatabase(), now = () => Date.now() } = {}) {
  const run = async (mode, work) =>
    transaction(await open(), [STORES.TRANSCRIPTS], mode, ({ transcripts }) => work(transcripts));

  const patch = (recordingId, fn) =>
    run('readwrite', async (store) => {
      const current = await asPromise(store.get(recordingId));
      if (!current) return null; // borrada (cancelada o grabación eliminada) mientras tanto
      const next = { ...fn(current), recordingId, updatedAt: now() };
      await asPromise(store.put(next));
      return next;
    });

  return {
    get: (recordingId) => run('readonly', (store) => asPromise(store.get(recordingId))).then((r) => r ?? null),

    /** Resumen ligero para la lista: id → estado (sin cargar los segmentos en la UI). */
    async statuses() {
      const all = await run('readonly', (store) => asPromise(store.getAll()));
      return new Map(all.map((t) => [t.recordingId, t.status]));
    },

    listIds: () => run('readonly', (store) => asPromise(store.getAllKeys())),

    /** Crea (o reinicia) una transcripción en estado «procesando». */
    async start(recordingId, { model, modelRevision, language = 'es', durationMs = null }) {
      const record = {
        recordingId, status: TranscriptStatus.PROCESSING, model, modelRevision, language,
        createdAt: now(), updatedAt: now(), completedAt: null,
        durationMs, processedMs: 0, segments: [], noSpeech: false, error: null,
      };
      await run('readwrite', (store) => asPromise(store.put(record)));
      return record;
    },

    /** Reanuda una transcripción interrumpida conservando lo ya procesado. */
    resume: (recordingId) => patch(recordingId, (t) => ({ ...t, status: TranscriptStatus.PROCESSING, error: null })),

    /** Añade los segmentos de un bloque y avanza el punto de reanudación (atómico). */
    appendBlock: (recordingId, { segments, processedMs }) =>
      patch(recordingId, (t) => ({ ...t, segments: [...t.segments, ...segments], processedMs: Math.max(t.processedMs, processedMs) })),

    complete: (recordingId) =>
      patch(recordingId, (t) => ({
        ...t, status: TranscriptStatus.COMPLETED, completedAt: now(), error: null,
        noSpeech: !t.segments.some((s) => s.text.trim()),
      })),

    fail: (recordingId, { code, message }) => patch(recordingId, (t) => ({ ...t, status: TranscriptStatus.ERROR, error: { code, message } })),

    /** Borra la transcripción. Devuelve false si no existía. */
    async remove(recordingId) {
      return run('readwrite', async (store) => {
        const existed = (await asPromise(store.count(recordingId))) > 0;
        if (existed) await asPromise(store.delete(recordingId));
        return existed;
      });
    },
  };
}
