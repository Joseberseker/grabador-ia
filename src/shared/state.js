/**
 * Estado global de la grabación en chrome.storage.session: sobrevive a que el
 * service worker se suspenda, al cierre del popup y del controlador, y se borra
 * al cerrar Chrome.
 *
 * Solo el service worker escribe; popup y controlador leen y se suscriben.
 */

export const Status = Object.freeze({
  IDLE: 'idle', // ● LISTO
  SELECTING: 'selecting', // selector de Chrome abierto
  COUNTDOWN: 'countdown', // 3, 2, 1… (captura activa, aún sin grabar)
  RECORDING: 'recording', // 🔴 GRABANDO
  PAUSED: 'paused', // ⏸ PAUSADO
  SAVING: 'saving', // generando y descargando el archivo
  EXPORTING: 'exporting', // convirtiendo a MP4 (fases en state.export.phase)
  EXPORT_FAILED: 'export-failed', // conversión cancelada o fallida: el WebM sigue disponible
  FINISHED: 'finished', // ✓ FINALIZADO
});

/** Fases de la exportación visibles en la UI. */
export const ExportPhase = Object.freeze({
  PREPARING: 'preparing',
  CONVERTING: 'converting',
  FINALIZING: 'finalizing',
  SAVING: 'saving', // guardando en la biblioteca (OPFS + miniatura + metadatos)
  DOWNLOADING: 'downloading',
});

/** Estados en los que existe un documento offscreen con una captura viva. */
export const ACTIVE_STATUSES = Object.freeze([
  Status.SELECTING,
  Status.COUNTDOWN,
  Status.RECORDING,
  Status.PAUSED,
  Status.SAVING,
  Status.EXPORTING,
  Status.EXPORT_FAILED, // el offscreen conserva el WebM hasta que el usuario decida
]);

export const INITIAL_STATE = Object.freeze({
  status: Status.IDLE,
  recordingId: null, // UUID de la grabación (clave de sus fragmentos en IndexedDB)
  elapsedMs: 0, // tiempo grabado acumulado hasta el último pause
  segmentStartedAt: null, // epoch ms del tramo en curso (solo en RECORDING)
  countdownEndsAt: null, // epoch ms (solo en COUNTDOWN)
  audio: null, // { tab: 'off'|'on'|'unavailable', mic: 'off'|'on'|'error', plan }
  video: null, // { width, height, frameRate, ... } efectivos
  exportFormat: 'webm', // formato elegido al empezar la grabación
  webm: null, // { blobUrl, fileName, size, durationMs } WebM listo (fallback)
  export: null, // { phase, progress, etaMs, cancelled, error, stats }
  controllerWindowId: null,
  pendingDownload: null, // { id, blobUrl, kind: 'webm' | 'mp4' } mientras se descarga
  autoDownload: true, // ajuste «Descargar al terminar» al empezar la grabación
  lastRecording: null, // { libraryId, title, fileName, size, durationMs, format, width, height, fps, kind, note }
  notice: null, // { type: 'info' | 'error', message }
});

const STORAGE_KEY = 'recordingState';

export const isActive = (status) => ACTIVE_STATUSES.includes(status);

/** Segundos que quedan de cuenta regresiva (3, 2, 1) o 0. */
export function getCountdownRemaining(state, now = Date.now()) {
  if (state?.status !== Status.COUNTDOWN || state.countdownEndsAt == null) return 0;
  return Math.max(0, Math.ceil((state.countdownEndsAt - now) / 1000));
}

/** Duración grabada en `now`, excluyendo pausas. Pura: sirve en cualquier contexto. */
export function getElapsedMs(state, now = Date.now()) {
  const base = Number(state?.elapsedMs) || 0;
  if (state?.status === Status.RECORDING && state.segmentStartedAt != null) {
    return base + Math.max(0, now - state.segmentStartedAt);
  }
  return base;
}

export async function getState() {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  return { ...INITIAL_STATE, ...stored[STORAGE_KEY] };
}

export async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ [STORAGE_KEY]: next });
  return next;
}

/** Vuelve a LISTO conservando la ventana del controlador y la última grabación. */
export async function resetState(patch = {}) {
  const { controllerWindowId, lastRecording } = await getState();
  const next = { ...INITIAL_STATE, controllerWindowId, lastRecording, ...patch };
  await chrome.storage.session.set({ [STORAGE_KEY]: next });
  return next;
}

/** Llama a `callback(state)` en cada cambio. Devuelve la función para desuscribirse. */
export function onStateChange(callback) {
  const listener = (changes, areaName) => {
    if (areaName === 'session' && changes[STORAGE_KEY]) {
      callback({ ...INITIAL_STATE, ...changes[STORAGE_KEY].newValue });
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
