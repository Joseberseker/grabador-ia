/**
 * Servicio de transcripción para la página de la biblioteca (hilo principal).
 *
 * - Lanza el Worker y PERSISTE lo que devuelve (bloque a bloque) en IndexedDB. Persistir
 *   aquí, y no en el worker, permite cancelar con terminate() sin escrituras huérfanas.
 * - Una sola transcripción a la vez en todo Chrome: Web Lock «transcription» (si hay otra
 *   pestaña de la biblioteca transcribiendo, no se arranca una segunda).
 * - Un Web Lock por grabación («transcription:<id>») distingue «procesando ahora» de
 *   «interrumpida» (Chrome o la pestaña se cerraron a mitad): los locks mueren con la página.
 * - Nunca arranca solo: solo start()/resume() invocados por un clic del usuario.
 */

import { createTranscriptRepository, TranscriptStatus } from './transcript-repository.js';
import { MODELS, MODEL_CACHE, isModelUrl, modelByKey } from './models.js';
import { ErrorCode, TranscriptionError, toErrorInfo } from './transcription-errors.js';

export const TRANSCRIPT_CHANNEL = 'recorder-transcripts';
const ENGINE_LOCK = 'transcription';
const jobLock = (id) => `transcription:${id}`;

export class BusyError extends Error {
  constructor() {
    super('Ya hay una transcripción en curso. Espera a que termine o cancélala.');
    this.name = 'BusyError';
  }
}

const broadcast = (event) => {
  try {
    const channel = new BroadcastChannel(TRANSCRIPT_CHANNEL);
    channel.postMessage(event);
    channel.close();
  } catch {
    // sin BroadcastChannel (tests)
  }
};

const defaultWorker = () => new Worker(new URL('./transcription-worker.js', import.meta.url), { type: 'module', name: 'transcripción' });

/**
 * @param {object} deps
 * @param {{ get: (id: string) => Promise<object|null>, getVideo: (id: string) => Promise<{ file: Blob }> }} deps.library
 */
export function createTranscriptionService({
  library,
  repo = createTranscriptRepository(),
  createWorker = defaultWorker,
  locks = globalThis.navigator?.locks,
  cacheStorage = globalThis.caches,
  notify = broadcast,
  now = () => Date.now(),
} = {}) {
  const listeners = new Set();
  /** Trabajo activo en ESTA página. */
  let job = null;

  const emit = () => {
    for (const fn of listeners) fn(snapshot());
  };
  const snapshot = () =>
    job && {
      id: job.id, phase: job.phase, model: job.model.key,
      download: { ...job.download }, processedMs: job.processedMs, durationMs: job.durationMs,
      startedAt: job.startedAt, phaseStartedAt: job.phaseStartedAt, phaseStartMs: job.phaseStartMs,
    };

  async function heldLocks() {
    const { held = [] } = (await locks?.query?.()) ?? {};
    return new Set(held.map((l) => l.name));
  }

  /** Transcripción guardada + si está corriendo (aquí o en otra pestaña) o se interrumpió. */
  async function get(id) {
    const transcript = await repo.get(id);
    if (!transcript) return null;
    let running = false;
    if (transcript.status === TranscriptStatus.PROCESSING) {
      running = job?.id === id || (await heldLocks()).has(jobLock(id));
    }
    return { ...transcript, running, interrupted: transcript.status === TranscriptStatus.PROCESSING && !running };
  }

  /** Mantiene un Web Lock mientras dure `release` (promesa que resolvemos al terminar). */
  function hold(name, { ifAvailable = false } = {}) {
    if (!locks) return Promise.resolve(() => {});
    return new Promise((resolve, reject) => {
      locks
        .request(name, { ifAvailable }, (lock) => {
          if (!lock) {
            resolve(null);
            return undefined;
          }
          return new Promise((release) => resolve(release));
        })
        .catch(reject);
    });
  }

  /**
   * Inicia (o reanuda) la transcripción de una grabación.
   * @param {string} id
   * @param {{ model?: string, resume?: boolean }} [options]
   */
  async function start(id, { model: modelKey, resume = false } = {}) {
    if (job) throw new BusyError();
    const releaseEngine = await hold(ENGINE_LOCK, { ifAvailable: true });
    if (!releaseEngine) throw new BusyError();
    let releaseJob = () => {};
    try {
      const record = await library.get(id);
      if (!record) throw new TranscriptionError(ErrorCode.NOT_FOUND);
      const previous = resume ? await repo.get(id) : null;
      const canResume = previous?.status === TranscriptStatus.PROCESSING && (!modelKey || modelKey === previous.model);
      const model = modelByKey(canResume ? previous.model : modelKey);
      const transcript = canResume
        ? await repo.resume(id)
        : await repo.start(id, { model: model.key, modelRevision: model.revision, durationMs: record.durationMs ?? null });
      const { file } = await library.getVideo(id);
      releaseJob = (await hold(jobLock(id))) ?? (() => {});
      job = {
        id, model, worker: createWorker(), writes: Promise.resolve(), cancelled: false,
        phase: 'loading', download: { loaded: 0, total: 0 },
        processedMs: transcript.processedMs, durationMs: record.durationMs ?? null,
        startedAt: now(), phaseStartedAt: now(), phaseStartMs: transcript.processedMs,
        release: () => {
          releaseJob();
          releaseEngine();
        },
      };
      const current = job;
      current.worker.onmessage = ({ data }) => handle(current, data);
      current.worker.onerror = (event) => {
        event.preventDefault?.();
        finishWithError(current, new Error(event.message || 'Error en el worker de transcripción'));
      };
      current.worker.postMessage({
        type: 'start', file, model: { id: model.id, revision: model.revision },
        startMs: transcript.processedMs, lastSegment: transcript.segments.at(-1) ?? null,
      });
      notify({ type: 'started', id });
      emit();
    } catch (error) {
      releaseJob();
      releaseEngine();
      if (job?.id === id) {
        job.worker.terminate();
        job = null;
      }
      throw error;
    }
  }

  function handle(current, data) {
    if (current !== job || current.cancelled) return;
    switch (data.type) {
      case 'download':
        current.phase = 'downloading';
        current.download = { loaded: data.loaded, total: data.total };
        emit();
        break;
      case 'ready':
        current.phase = 'transcribing';
        current.phaseStartedAt = now();
        current.phaseStartMs = current.processedMs;
        emit();
        break;
      case 'block':
        current.processedMs = data.processedMs;
        current.writes = current.writes.then(async () => {
          await repo.appendBlock(current.id, { segments: data.segments, processedMs: data.processedMs });
          notify({ type: 'progress', id: current.id });
        });
        emit();
        break;
      case 'done':
        finish(current, async () => {
          await repo.complete(current.id);
        });
        break;
      case 'error':
        finishWithError(current, new TranscriptionError(data.error.code, data.error.message));
        break;
      default:
    }
  }

  async function finishWithError(current, error) {
    if (current !== job || current.cancelled) return;
    const info = toErrorInfo(error);
    await finish(current, async () => {
      // Si la grabación desapareció a mitad (eliminada), no se deja rastro de la transcripción.
      if (!(await library.get(current.id).catch(() => null))) await repo.remove(current.id);
      else await repo.fail(current.id, info);
    });
  }

  async function finish(current, persist) {
    current.worker.terminate();
    current.phase = 'finishing';
    try {
      await current.writes.catch(() => {});
      await persist();
    } finally {
      if (job === current) job = null;
      current.release();
      notify({ type: 'finished', id: current.id });
      emit();
    }
  }

  /** Cancela: termina el worker al instante y borra lo parcial (vuelve a «pendiente»). */
  async function cancel(id) {
    const current = job;
    if (current?.id === id) {
      current.cancelled = true;
      current.worker.terminate();
      job = null;
      try {
        await current.writes.catch(() => {});
        await repo.remove(id);
      } finally {
        current.release();
        notify({ type: 'cancelled', id });
        emit();
      }
      return true;
    }
    // Interrumpida (sin worker vivo): descartar también es «cancelar».
    const saved = await get(id);
    if (saved?.interrupted) {
      await repo.remove(id);
      notify({ type: 'cancelled', id });
      return true;
    }
    return false;
  }

  /** Borra la transcripción guardada (p. ej. antes de «Volver a transcribir»). */
  async function remove(id) {
    if (job?.id === id) return cancel(id);
    const existed = await repo.remove(id);
    notify({ type: 'removed', id });
    return existed;
  }

  // --- modelos descargados (Cache Storage de la extensión) -------------------------

  async function cachedModels() {
    const result = Object.fromEntries(Object.keys(MODELS).map((k) => [k, false]));
    if (!cacheStorage || !(await cacheStorage.has(MODEL_CACHE))) return result;
    const cache = await cacheStorage.open(MODEL_CACHE);
    const urls = (await cache.keys()).map((r) => r.url);
    for (const model of Object.values(MODELS)) {
      result[model.key] = urls.filter((u) => isModelUrl(u, model) && u.endsWith('.onnx')).length >= 2;
    }
    return result;
  }

  async function deleteModels() {
    if (job) throw new BusyError();
    return cacheStorage ? cacheStorage.delete(MODEL_CACHE) : false;
  }

  return {
    get,
    statuses: () => repo.statuses(),
    start,
    resume: (id) => start(id, { resume: true }),
    cancel,
    remove,
    active: snapshot,
    cachedModels,
    deleteModels,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
