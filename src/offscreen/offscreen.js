/**
 * Offscreen document: puente entre el service worker, RecordingSession y el
 * VideoConverter.
 *
 * Lo crea el service worker con la razón DISPLAY_MEDIA (más USER_MEDIA para el
 * micrófono) y vive mientras haya una grabación: captura, conversión a MP4 y
 * descarga. Al no estar ligado a ninguna ventana, sobrevive al cierre del popup
 * y del controlador y a los cambios de pestaña.
 *
 * El nivel del micrófono se publica por BroadcastChannel (~10 veces por
 * segundo): llega a popup y controlador sin despertar al service worker ni
 * escribir en storage.
 */

import { AUDIO_LEVEL_CHANNEL, Msg, Target, listen, sendToBackground } from '../shared/messages.js';
import { buildFileName } from '../shared/format.js';
import { deleteRecording } from '../recording/chunk-store.js';
import { RecordingSession } from '../recording/recording-session.js';
import { Mp4Converter, loadMediabunny } from '../conversion/mp4-converter.js';
import { cleanupTempFiles, getTempFileHandle, removeTempFile } from '../conversion/temp-files.js';
import { createLibrary } from '../library/library-service.js';
import { defaultTitle, sanitizeFileName } from '../library/recording-meta.js';

const EVENTS = {
  countdown: Msg.REC_COUNTDOWN,
  started: Msg.REC_STARTED,
  saving: Msg.REC_SAVING,
  warning: Msg.REC_WARNING,
  failed: Msg.REC_FAILED,
};
const PROGRESS_MESSAGE_INTERVAL_MS = 500;

const levelChannel = new BroadcastChannel(AUDIO_LEVEL_CHANNEL);
const converter = new Mp4Converter();
const library = createLibrary({ loadMediabunny });
let session = null;
let recordingId = null;
let webm = null; // { blob, url, fileName } — se conserva como alternativa al MP4
let mp4Url = null;
let libraryUrl = null; // URL del archivo YA guardado en la biblioteca (para la descarga)
let exportController = null;

listen(
  Target.OFFSCREEN,
  {
    [Msg.OFFSCREEN_START]: (message) => {
      if (session) throw new Error('El motor ya tiene una grabación en curso.');
      recordingId = message.recordingId;
      session = new RecordingSession({
        id: recordingId,
        settings: message.settings,
        emit: onSessionEvent,
        onLevel: (level) => levelChannel.postMessage({ level }),
      });
      // No esperamos al selector: el resultado llega como evento.
      session.run();
      return null;
    },
    [Msg.OFFSCREEN_PAUSE]: () => session.pause(),
    [Msg.OFFSCREEN_RESUME]: () => session.resume(),
    [Msg.OFFSCREEN_STOP]: () => {
      session?.stop();
      return null;
    },
    [Msg.OFFSCREEN_EXPORT]: (message) => {
      if (!webm) throw new Error('No hay ninguna grabación que convertir.');
      if (exportController) throw new Error('Ya hay una conversión en curso.');
      // No esperamos: el resultado llega como EXPORT_DONE / EXPORT_FAILED.
      runExport(message.quality);
      return null;
    },
    [Msg.OFFSCREEN_CANCEL_EXPORT]: () => {
      exportController?.abort();
      return null;
    },
    [Msg.OFFSCREEN_SAVE]: (message) => saveToLibrary(message),
    [Msg.OFFSCREEN_RELEASE]: async () => {
      await release();
      return null;
    },
  },
  { log: 'offscreen' },
);

function onSessionEvent(event, payload) {
  if (event === 'finished') {
    // El WebM (respaldado por IndexedDB) se conserva: es la entrada del conversor y
    // la alternativa si el MP4 falla. El background decide si se convierte o se descarga.
    const fileName = buildFileName(session.startedAt ?? new Date());
    webm = { blob: payload.blob, url: URL.createObjectURL(payload.blob), fileName };
    emit(Msg.REC_FINISHED, {
      blobUrl: webm.url,
      fileName,
      size: payload.blob.size,
      mimeType: payload.blob.type,
      durationMs: payload.durationMs,
    });
    return;
  }
  emit(EVENTS[event], payload);
}

async function runExport(quality) {
  exportController = new AbortController();
  let lastMessage = 0;
  let lastPhase = null;
  try {
    // Temporales de conversiones anteriores interrumpidas (p. ej. Chrome se cerró).
    await cleanupTempFiles({ keepIds: [] }).catch(() => {});
    const result = await converter.convert(webm.blob, {
      id: recordingId,
      quality,
      signal: exportController.signal,
      onProgress: (progress) => {
        // Los cambios de fase se envían siempre; el progreso dentro de una fase, como mucho cada 500 ms.
        const now = performance.now();
        if (progress.phase === lastPhase && now - lastMessage < PROGRESS_MESSAGE_INTERVAL_MS) return;
        lastMessage = now;
        lastPhase = progress.phase;
        emit(Msg.EXPORT_PROGRESS, progress);
      },
    });
    if (mp4Url) URL.revokeObjectURL(mp4Url);
    mp4Url = URL.createObjectURL(result.file);
    emit(Msg.EXPORT_DONE, {
      blobUrl: mp4Url,
      fileName: webm.fileName.replace(/\.webm$/, '.mp4'),
      size: result.file.size,
      mimeType: result.mimeType,
      stats: result.stats,
    });
  } catch (error) {
    emit(Msg.EXPORT_FAILED, {
      cancelled: error?.code === 'cancelled',
      error: { code: error?.code ?? 'failed', message: error?.message ?? String(error) },
    });
  } finally {
    exportController = null;
  }
}

/**
 * Guarda la grabación terminada en la biblioteca:
 *  - MP4: se MUEVE el temporal de conversión (OPFS → OPFS, sin copia).
 *  - WebM: se escribe por stream desde los fragmentos de IndexedDB.
 * Devuelve el registro y una URL del archivo de la biblioteca para descargarlo.
 */
async function saveToLibrary({ kind, meta }) {
  if (!webm) throw new Error('No hay ninguna grabación que guardar.');
  const startedAt = session?.startedAt ?? new Date();
  const video = kind === 'mp4' ? await getTempFileHandle(recordingId) : { blob: webm.blob };
  const { record, file } = await library.save({
    id: recordingId,
    format: kind,
    meta: { ...meta, createdAt: startedAt.getTime(), title: defaultTitle(startedAt) },
    video: kind === 'mp4' ? { handle: video.handle, sourceDir: video.dir } : video,
  });
  // El File del temporal ya no es válido (se movió): la descarga usa el de la biblioteca.
  if (mp4Url) URL.revokeObjectURL(mp4Url);
  mp4Url = null;
  if (libraryUrl) URL.revokeObjectURL(libraryUrl);
  libraryUrl = URL.createObjectURL(file);
  return { record, blobUrl: libraryUrl, downloadName: sanitizeFileName(record.title, kind) };
}

/** Libera todo: URLs, MP4 temporal (OPFS) y fragmentos del WebM (IndexedDB). La biblioteca no se toca. */
async function release() {
  exportController?.abort();
  for (const url of [webm?.url, mp4Url, libraryUrl]) if (url) URL.revokeObjectURL(url);
  webm = null;
  mp4Url = null;
  libraryUrl = null;
  if (recordingId) {
    await removeTempFile(recordingId).catch(() => {});
    await deleteRecording(recordingId);
    recordingId = null;
  }
}

async function emit(type, payload) {
  try {
    await sendToBackground(type, payload);
  } catch (error) {
    console.error(`[offscreen] No se pudo notificar ${type}:`, error);
  }
}

window.addEventListener('pagehide', () => {
  for (const url of [webm?.url, mp4Url, libraryUrl]) if (url) URL.revokeObjectURL(url);
});
