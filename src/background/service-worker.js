/**
 * Service worker: coordinador y única fuente de verdad del estado.
 *
 * - Recibe comandos del popup, del controlador y de los atajos (chrome.commands).
 * - Crea/cierra el offscreen document que graba y le reenvía las órdenes.
 * - Guarda el estado en storage.session y actualiza el badge (REC / II).
 * - Abre la ventana del controlador y descarga el archivo con chrome.downloads.
 * - Si el formato es MP4, pide al offscreen la conversión (VideoConverter) y
 *   conserva el WebM como alternativa si se cancela o falla.
 * - Limpia los fragmentos de IndexedDB (al terminar, al cancelar y al arrancar).
 *
 * Puede ser suspendido en cualquier momento: no guarda nada en variables
 * globales que no pueda reconstruir desde storage.session.
 */

import { COMMANDS, Msg, Target, listen, sendToOffscreen } from '../shared/messages.js';
import {
  ExportPhase,
  Status,
  getState,
  setState,
  resetState,
  isActive,
} from '../shared/state.js';
import { getSettings } from '../shared/settings.js';
import { deleteAllRecordings, deleteRecording } from '../recording/chunk-store.js';
import { cleanupTempFiles } from '../conversion/temp-files.js';
import { lowFpsNote } from '../conversion/conversion-plan.js';
import { createLibrary } from '../library/library-service.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const CONTROLLER_PATH = 'src/controller/controller.html';
const LIBRARY_PATH = 'src/library/library.html';
const CONTROLLER_SIZE = { width: 340, height: 330 }; // tamaño exterior (incluye la barra de título)

const BADGE = {
  [Status.RECORDING]: { text: 'REC', color: '#d93025' },
  [Status.PAUSED]: { text: 'II', color: '#e37400' },
  [Status.SAVING]: { text: '…', color: '#5f6368' },
  [Status.EXPORTING]: { text: 'MP4', color: '#1a73e8' },
  [Status.EXPORT_FAILED]: { text: '!', color: '#e37400' },
};

// ---------------------------------------------------------------------------
// Serialización: los manejadores leen y escriben el estado; ejecutarlos de uno
// en uno evita carreras (p. ej. un STOP que llega mientras se procesa START).
// ---------------------------------------------------------------------------

let queue = Promise.resolve();
function serialized(fn) {
  return (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };
}

// ---------------------------------------------------------------------------
// Comandos (popup / controlador / atajos)
// ---------------------------------------------------------------------------

async function start() {
  const state = await getState();
  if (state.status === Status.SELECTING) return state; // el selector ya está abierto
  if (isActive(state.status)) throw new Error('Ya hay una grabación en curso.');

  const settings = await getSettings();
  const recordingId = crypto.randomUUID();
  // Ninguna grabación está activa: cualquier resto en IndexedDB es huérfano.
  await deleteAllRecordings().catch((error) => console.warn('[background] limpieza IndexedDB:', error));

  await setState({
    status: Status.SELECTING,
    recordingId,
    elapsedMs: 0,
    segmentStartedAt: null,
    countdownEndsAt: null,
    audio: null,
    video: null,
    exportFormat: settings.exportFormat,
    exportQuality: settings.quality,
    requestedFps: settings.fps,
    autoDownload: settings.autoDownload,
    webm: null,
    export: null,
    pendingDownload: null,
    notice: null,
  });
  try {
    await ensureOffscreen();
    await sendToOffscreen(Msg.OFFSCREEN_START, { recordingId, settings });
  } catch (error) {
    await closeOffscreen();
    await toIdle({ type: 'error', message: `No se pudo iniciar la grabación: ${error.message}` });
    throw error;
  }
  return getState();
}

async function pause() {
  const state = await getState();
  if (state.status !== Status.RECORDING) throw new Error('No hay ninguna grabación activa que pausar.');
  const clock = await sendToOffscreen(Msg.OFFSCREEN_PAUSE);
  return applyStatus(Status.PAUSED, clock);
}

async function resume() {
  const state = await getState();
  if (state.status !== Status.PAUSED) throw new Error('La grabación no está en pausa.');
  const clock = await sendToOffscreen(Msg.OFFSCREEN_RESUME);
  return applyStatus(Status.RECORDING, clock);
}

async function stop() {
  const state = await getState();
  if (state.status === Status.COUNTDOWN) return cancel();
  if (state.status !== Status.RECORDING && state.status !== Status.PAUSED) {
    throw new Error('No hay ninguna grabación que detener.');
  }
  // El offscreen responde enseguida y emite REC_SAVING y REC_FINISHED.
  await sendToOffscreen(Msg.OFFSCREEN_STOP);
  return getState();
}

async function cancel() {
  const state = await getState();
  if (state.status !== Status.SELECTING && state.status !== Status.COUNTDOWN) {
    throw new Error('No hay nada que cancelar.');
  }
  // Destruir el documento descarta la petición de captura (o para los tracks
  // durante la cuenta regresiva). Aún no se ha escrito nada en IndexedDB.
  await closeOffscreen();
  await deleteRecording(state.recordingId).catch(() => {});
  return toIdle({
    type: 'info',
    message:
      state.status === Status.COUNTDOWN
        ? 'Cuenta regresiva cancelada. No se ha grabado nada.'
        : 'Selección cancelada. No se ha grabado nada.',
  });
}

// --- exportación MP4 ---------------------------------------------------------

async function startExport() {
  const state = await getState();
  await setState({
    status: Status.EXPORTING,
    export: { phase: ExportPhase.PREPARING, progress: 0, etaMs: null },
    notice: null,
  });
  updateBadge(Status.EXPORTING, 0);
  try {
    await sendToOffscreen(Msg.OFFSCREEN_EXPORT, { quality: state.exportQuality ?? 'auto' });
  } catch (error) {
    await exportFailed({ cancelled: false, error: { message: `No se pudo iniciar la conversión: ${error.message}` } });
  }
  return getState();
}

async function cancelExport() {
  const state = await getState();
  if (state.status !== Status.EXPORTING) throw new Error('No hay ninguna conversión en curso.');
  if (state.export?.phase === ExportPhase.DOWNLOADING) {
    // La conversión ya terminó: cancelar la descarga deja el estado como «cancelado».
    if (state.pendingDownload) await chrome.downloads.cancel(state.pendingDownload.id).catch(() => {});
    return getState();
  }
  // El offscreen aborta el VideoConverter y responde con EXPORT_FAILED (cancelled).
  await sendToOffscreen(Msg.OFFSCREEN_CANCEL_EXPORT);
  return getState();
}

async function retryExport() {
  const state = await getState();
  if (state.status !== Status.EXPORT_FAILED) throw new Error('No hay ninguna exportación que reintentar.');
  return startExport();
}

/** Alternativa tras cancelar/fallar el MP4: el WebM original se guarda en la biblioteca (y se descarga). */
async function downloadWebm() {
  const state = await getState();
  if (state.status !== Status.EXPORT_FAILED || !state.webm) throw new Error('No hay ningún WebM disponible.');
  await setState({ status: Status.SAVING, notice: null });
  updateBadge(Status.SAVING);
  await saveToLibrary('webm');
  return getState();
}

/** Abre (o enfoca) la biblioteca; opcionalmente en una grabación y con una acción. */
async function openLibrary(message = {}) {
  const hash = message.recordingId
    ? `#/recording/${encodeURIComponent(message.recordingId)}${message.action === 'download' ? '/download' : ''}`
    : '';
  const url = chrome.runtime.getURL(LIBRARY_PATH) + hash;
  // getContexts (Chrome 116+) encuentra pestañas de la propia extensión sin el permiso «tabs».
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] }).catch(() => []);
  const existing = contexts.find((c) => c.documentUrl?.startsWith(chrome.runtime.getURL(LIBRARY_PATH)) && c.tabId >= 0);
  if (existing) {
    const tab = await chrome.tabs.update(existing.tabId, { active: true, ...(hash && { url }) });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url });
  }
  return null;
}

async function discard() {
  const state = await getState();
  if (state.status !== Status.EXPORT_FAILED) throw new Error('No hay nada que descartar.');
  await releaseRecording();
  return toIdle({ type: 'info', message: 'Grabación descartada. Se han borrado los archivos temporales.' });
}

async function toggleRecording() {
  const { status } = await getState();
  if (status === Status.IDLE || status === Status.FINISHED) return start();
  if (status === Status.RECORDING || status === Status.PAUSED) return stop();
  return getState();
}

async function togglePause() {
  const { status } = await getState();
  if (status === Status.RECORDING) return pause();
  if (status === Status.PAUSED) return resume();
  return getState();
}

async function showController() {
  await openController({ focused: true });
  return getState();
}

/**
 * Comprueba que el estado guardado coincide con la realidad: si dice que se
 * graba pero el offscreen ya no existe (crash, cierre por Chrome…), lo corrige.
 */
async function sync() {
  const state = await getState();
  if (isActive(state.status) && !(await chrome.offscreen.hasDocument())) {
    // No se ofrece recuperación: el último fragmento puede no haberse escrito y
    // no podemos garantizar un archivo válido. Se eliminan los restos.
    await deleteAllRecordings().catch(() => {});
    await cleanupTempFiles().catch(() => {});
    return toIdle({
      type: 'error',
      message: 'La grabación se interrumpió inesperadamente y no se pudo recuperar.',
    });
  }
  return state;
}

// ---------------------------------------------------------------------------
// Eventos del offscreen
// ---------------------------------------------------------------------------

async function onRecCountdown(message) {
  const state = await getState();
  if (state.status !== Status.SELECTING) return null;
  await setState({
    status: Status.COUNTDOWN,
    countdownEndsAt: message.endsAt,
    audio: message.audio,
    video: message.video,
  });
  showCountdownBadge(message.endsAt);
  await openController({ focused: false });
  return null;
}

async function onRecStarted(message) {
  const state = await getState();
  // p. ej. se canceló mientras tanto
  if (state.status !== Status.SELECTING && state.status !== Status.COUNTDOWN) return null;
  await setState({
    audio: message.audio,
    video: message.video,
    countdownEndsAt: null,
    notice: message.notice ? { type: 'error', message: message.notice } : null,
  });
  await applyStatus(Status.RECORDING, message);
  await openController({ focused: false });
  return null;
}

async function onRecWarning(message) {
  const state = await getState();
  if (!isActive(state.status)) return null;
  await setState({
    notice: { type: 'error', message: message.message },
    ...(message.micLost && state.audio && { audio: { ...state.audio, mic: 'error' } }),
  });
  return null;
}

async function onRecSaving(message) {
  await applyStatus(Status.SAVING, { elapsedMs: message.durationMs ?? 0, segmentStartedAt: null });
  return null;
}

async function onRecFinished(message) {
  const { blobUrl, fileName, size, mimeType, durationMs } = message;
  const webm = { blobUrl, fileName, size, mimeType, durationMs };
  await setState({ webm });
  const state = await getState();
  if (state.exportFormat === 'mp4') return startExport();
  await saveToLibrary('webm');
  return null;
}

async function onExportProgress(message) {
  const state = await getState();
  if (state.status !== Status.EXPORTING) return null; // p. ej. llega tarde tras cancelar
  await setState({ export: { ...state.export, phase: message.phase, progress: message.progress, etaMs: message.etaMs } });
  updateBadge(Status.EXPORTING, message.progress);
  return null;
}

async function onExportDone(message) {
  const state = await getState();
  if (state.status !== Status.EXPORTING) return null;
  await setState({ export: { ...state.export, phase: ExportPhase.SAVING, progress: 1, etaMs: null, stats: message.stats } });
  await saveToLibrary('mp4', message.stats);
  return null;
}

/**
 * Guarda la grabación terminada en la biblioteca (el offscreen mueve/escribe el
 * archivo en OPFS, genera la miniatura y escribe los metadatos) y, si el ajuste
 * está activo, la descarga desde ese archivo (sin duplicarla en la extensión).
 */
async function saveToLibrary(kind, stats = null) {
  const state = await getState();
  const meta = {
    durationMs: state.webm?.durationMs ?? (stats ? stats.durationS * 1000 : 0),
    width: stats?.width ?? state.video?.width,
    height: stats?.height ?? state.video?.height,
    fps: stats?.inputFps ?? state.video?.frameRate,
    hasTabAudio: state.audio?.tab === 'on',
    hasMicrophone: state.audio?.mic === 'on',
    sourceType: state.video?.displaySurface ?? null,
    videoCodec: stats?.videoCodecString ?? null,
  };
  let saved;
  try {
    saved = await sendToOffscreen(Msg.OFFSCREEN_SAVE, { kind, meta });
  } catch (error) {
    return exportFailed({ cancelled: false, error: { message: `No se pudo guardar en la biblioteca: ${error.message}` } });
  }
  const { record, blobUrl, downloadName } = saved;
  const lastRecording = {
    libraryId: record.id,
    title: record.title,
    fileName: downloadName,
    size: record.fileSize,
    mimeType: record.mimeType,
    durationMs: record.durationMs,
    format: record.format,
    width: record.width,
    height: record.height,
    fps: record.fps,
    hasThumbnail: !!record.thumbnailFileName,
    kind,
    note: kind === 'mp4' ? lowFpsNote(state.requestedFps, stats?.inputFps) : null,
  };
  if (!state.autoDownload) {
    await releaseRecording();
    await setState({ status: Status.FINISHED, lastRecording, pendingDownload: null, webm: null, notice: null });
    updateBadge(Status.IDLE);
    return null;
  }
  if (state.status === Status.EXPORTING) await setState({ export: { ...(await getState()).export, phase: ExportPhase.DOWNLOADING } });
  await downloadFile({ blobUrl, fileName: downloadName }, kind, lastRecording);
  return null;
}


async function onExportFailed(message) {
  const state = await getState();
  if (state.status !== Status.EXPORTING) return null;
  return exportFailed(message);
}

/** La conversión no terminó: el WebM sigue disponible (reintentar, descargar WebM o descartar). */
async function exportFailed({ cancelled, error }) {
  await setState({
    status: Status.EXPORT_FAILED,
    export: { phase: null, progress: null, etaMs: null, cancelled: !!cancelled, error: error?.message ?? null },
    pendingDownload: null,
    notice: cancelled
      ? { type: 'info', message: 'Conversión a MP4 cancelada. Puedes descargar el WebM original o reintentar.' }
      : { type: 'error', message: withWebmHint(error?.message ?? 'La conversión falló.') },
  });
  updateBadge(Status.EXPORT_FAILED);
  return null;
}

const withWebmHint = (message) => (/WebM/.test(message) ? message : `${message} Puedes descargar el WebM original.`);

async function downloadFile(file, kind, lastRecording) {
  try {
    const id = await chrome.downloads.download({ url: file.blobUrl, filename: file.fileName, conflictAction: 'uniquify' });
    await setState({ pendingDownload: { id, blobUrl: file.blobUrl, kind }, lastRecording });
  } catch (error) {
    // La grabación ya está en la biblioteca: no se pierde nada.
    await finishWithNotice(lastRecording, { type: 'error', message: `No se pudo descargar (${error.message}). La grabación está guardada en tu biblioteca.` });
  }
}

async function finishWithNotice(lastRecording, notice) {
  await releaseRecording();
  await setState({ status: Status.FINISHED, lastRecording, pendingDownload: null, segmentStartedAt: null, webm: null, notice });
  updateBadge(Status.IDLE);
}

async function onRecFailed(message) {
  const state = await getState();
  if (!isActive(state.status)) return null; // ya se gestionó (p. ej. cancelación)
  await closeOffscreen();
  await deleteRecording(state.recordingId).catch(() => {});
  await toIdle({
    type: message.cancelled ? 'info' : 'error',
    message: message.error?.message ?? 'Error desconocido.',
  });
  return null;
}

/**
 * La descarga terminó: se liberan los temporales (fragmentos del WebM) y el
 * offscreen. La grabación ya está en la biblioteca, así que si la descarga se
 * interrumpe (p. ej. se canceló «Guardar como») no se pierde nada.
 */
async function onDownloadChanged(delta) {
  const state = await getState();
  if (!state.pendingDownload || delta.id !== state.pendingDownload.id) return;
  const result = delta.state?.current;
  if (!result || result === 'in_progress') return;

  if (result === 'complete') {
    // Nombre final real (Chrome añade « (1)» si ya existía uno igual).
    const [item] = await chrome.downloads.search({ id: delta.id }).catch(() => []);
    const fileName = item?.filename?.split(/[\\/]/).pop() ?? state.lastRecording?.fileName;
    await releaseRecording();
    await setState({
      status: Status.FINISHED,
      lastRecording: { ...state.lastRecording, fileName },
      pendingDownload: null,
      segmentStartedAt: null,
      webm: null,
      notice: null,
    });
    updateBadge(Status.IDLE);
  } else {
    const reason = delta.error?.current === 'USER_CANCELED' ? 'se canceló' : `se interrumpió: ${delta.error?.current ?? 'error'}`;
    await finishWithNotice(state.lastRecording, { type: 'info', message: `La descarga ${reason}. La grabación está guardada en tu biblioteca.` });
  }
}

// ---------------------------------------------------------------------------
// Registro de listeners (síncrono, en el nivel superior: requisito de MV3)
// ---------------------------------------------------------------------------

const commandHandlers = {
  [Msg.START]: start,
  [Msg.PAUSE]: pause,
  [Msg.RESUME]: resume,
  [Msg.STOP]: stop,
  [Msg.CANCEL]: cancel,
  [Msg.TOGGLE_RECORDING]: toggleRecording,
  [Msg.TOGGLE_PAUSE]: togglePause,
  [Msg.SHOW_CONTROLLER]: showController,
  [Msg.SYNC]: sync,
  [Msg.CANCEL_EXPORT]: cancelExport,
  [Msg.RETRY_EXPORT]: retryExport,
  [Msg.DOWNLOAD_WEBM]: downloadWebm,
  [Msg.DISCARD]: discard,
  [Msg.OPEN_LIBRARY]: openLibrary,
};

const offscreenHandlers = {
  [Msg.REC_COUNTDOWN]: onRecCountdown,
  [Msg.REC_STARTED]: onRecStarted,
  [Msg.REC_WARNING]: onRecWarning,
  [Msg.REC_SAVING]: onRecSaving,
  [Msg.REC_FINISHED]: onRecFinished,
  [Msg.REC_FAILED]: onRecFailed,
  [Msg.EXPORT_PROGRESS]: onExportProgress,
  [Msg.EXPORT_DONE]: onExportDone,
  [Msg.EXPORT_FAILED]: onExportFailed,
};

const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
const handlers = {};
for (const [type, fn] of Object.entries(commandHandlers)) {
  handlers[type] = serialized(fn);
}
for (const [type, fn] of Object.entries(offscreenHandlers)) {
  // Los eventos REC_* solo se aceptan si vienen del documento offscreen.
  const run = serialized(fn);
  handlers[type] = (message, sender) => {
    if (sender.url !== offscreenUrl) throw new Error('Origen no autorizado.');
    return run(message);
  };
}
listen(Target.BACKGROUND, handlers, { log: 'background' });

chrome.commands.onCommand.addListener((command) => {
  const type = COMMANDS[command];
  if (type) handlers[type]().catch((error) => console.warn(`[background] atajo ${command}:`, error.message));
});

chrome.downloads.onChanged.addListener(serialized(onDownloadChanged));

chrome.windows.onRemoved.addListener(
  serialized(async (windowId) => {
    const state = await getState();
    // Cerrar el controlador NO detiene la grabación: el offscreen sigue grabando.
    if (state.controllerWindowId === windowId) await setState({ controllerWindowId: null });
  }),
);

chrome.runtime.onInstalled.addListener(serialized(initialize));
chrome.runtime.onStartup.addListener(serialized(initialize));

async function initialize() {
  await closeOffscreen();
  // Restos de una sesión anterior (p. ej. Chrome se cerró grabando): no se
  // recuperan, se eliminan.
  await deleteAllRecordings().catch(() => {});
  // MP4 temporales de conversiones interrumpidas (OPFS). Si el service worker no
  // tiene OPFS, el offscreen los limpia antes de cada conversión.
  await cleanupTempFiles().catch((error) => console.warn('[background] limpieza OPFS:', error.message));
  await chrome.storage.session.clear();
  updateBadge(Status.IDLE);
}

/**
 * Cada vez que arranca el service worker (también tras «recargar» la extensión, donde
 * onInstalled no está garantizado): si NO hay ninguna grabación ni conversión activa,
 * cualquier dato en IndexedDB u OPFS es un resto huérfano y se borra. Si hay una sesión
 * activa (el service worker solo se había dormido), no se toca nada.
 */
async function cleanupOrphansIfIdle() {
  const state = await getState();
  if (isActive(state.status)) return;
  if (await chrome.offscreen.hasDocument()) return;
  await deleteAllRecordings().catch(() => {});
  await cleanupTempFiles().catch(() => {});
  // Biblioteca: carpetas sin metadatos o metadatos sin vídeo (cuelgue a mitad de guardado).
  await createLibrary().reconcile().catch((error) => console.warn('[background] reconciliar biblioteca:', error.message));
}
serialized(cleanupOrphansIfIdle)().catch((error) => console.warn('[background] limpieza al arrancar:', error.message));

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function applyStatus(status, clock) {
  const next = await setState({
    status,
    elapsedMs: clock?.elapsedMs ?? 0,
    segmentStartedAt: clock?.segmentStartedAt ?? null,
  });
  updateBadge(status);
  return next;
}

async function toIdle(notice = null) {
  updateBadge(Status.IDLE);
  return resetState({ notice });
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA, chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Grabar la pantalla (getDisplayMedia) y, si el usuario lo activa, el micrófono, con MediaRecorder.',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

/**
 * Revoca la URL blob y borra los fragmentos de IndexedDB (en el offscreen),
 * cierra el offscreen y, como red de seguridad, borra la grabación desde aquí.
 */
async function releaseRecording() {
  const { recordingId } = await getState();
  try {
    await sendToOffscreen(Msg.OFFSCREEN_RELEASE);
  } catch {
    // el documento ya no existe
  }
  await closeOffscreen();
  if (recordingId) await deleteRecording(recordingId).catch(() => {});
}

/** Badge 3 → 2 → 1 durante la cuenta regresiva. */
function showCountdownBadge(endsAt) {
  const tick = async () => {
    const remaining = Math.ceil((endsAt - Date.now()) / 1000);
    const { status } = await getState();
    if (status !== Status.COUNTDOWN || remaining <= 0) return;
    chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
    chrome.action.setBadgeText({ text: String(remaining) });
    setTimeout(tick, Math.max(50, endsAt - Date.now() - (remaining - 1) * 1000));
  };
  tick();
}

/** Abre (o reutiliza) la ventana pequeña del controlador junto a la ventana activa. */
async function openController({ focused }) {
  const state = await getState();
  if (state.controllerWindowId != null) {
    try {
      await chrome.windows.update(state.controllerWindowId, {
        ...(focused && { focused: true }),
        state: 'normal',
      });
      return;
    } catch {
      // la ventana ya no existe: creamos otra
    }
  }

  const options = {
    url: chrome.runtime.getURL(CONTROLLER_PATH),
    type: 'popup',
    focused,
    ...CONTROLLER_SIZE,
  };
  let win;
  try {
    win = await chrome.windows.create({ ...options, ...(await controllerPosition()) });
  } catch {
    // Chrome rechaza límites que quedan mayoritariamente fuera de la pantalla
    // (p. ej. varios monitores): dejamos que elija la posición.
    win = await chrome.windows.create(options);
  }
  await setState({ controllerWindowId: win.id });
}

/** Esquina superior derecha de la última ventana normal enfocada (sin permisos extra). */
async function controllerPosition() {
  try {
    const anchor = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (anchor?.left == null || anchor.width == null) return {};
    return {
      left: Math.max(0, anchor.left + anchor.width - CONTROLLER_SIZE.width - 24),
      top: Math.max(0, anchor.top + 96),
    };
  } catch {
    return {};
  }
}

/** `progress` (0..1) sustituye el texto del badge durante la exportación: «45%». */
function updateBadge(status, progress = null) {
  const badge = BADGE[status];
  const text = status === Status.EXPORTING && progress > 0 ? `${Math.floor(progress * 100)}%` : badge?.text ?? '';
  chrome.action.setBadgeText({ text });
  if (badge) chrome.action.setBadgeBackgroundColor({ color: badge.color });
  chrome.action.setTitle({
    title: badge ? `Grabador de pantalla — ${badge.text}` : 'Grabador de pantalla',
  });
}
