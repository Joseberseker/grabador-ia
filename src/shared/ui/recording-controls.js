/**
 * Componente de controles de grabación, compartido por el popup, la ventana del
 * controlador y su versión Picture-in-Picture.
 *
 * Se monta sobre un nodo raíz con elementos marcados con `data-role` (todos
 * opcionales):
 *   status, status-icon, status-label, timer, message,
 *   live (bloque visible solo durante una grabación), mic-status, tab-status,
 *   meter, meter-fill, video-info,
 *   export (bloque de progreso), export-fill, export-info,
 *   result (grabación lista), result-thumb, result-title, result-meta,
 *   botones view-recording | download-recording | open-library,
 *   botones start | pause | resume | stop | cancel |
 *           cancel-export | retry-export | download-webm | discard.
 *
 * No guarda estado propio: pinta lo que hay en chrome.storage.session, envía
 * comandos al service worker y escucha el nivel del micrófono por BroadcastChannel.
 */

import { AUDIO_LEVEL_CHANNEL, Msg, sendToBackground } from '../messages.js';
import { Status, getState, getElapsedMs, getCountdownRemaining, isActive, onStateChange } from '../state.js';
import { formatBytes, formatDuration, formatEta } from '../format.js';
import { createLibraryFiles } from '../../library/library-files.js';
import { formatSummary } from '../../library/recording-meta.js';
import { THUMBNAIL_FILE } from '../../library/thumbnail.js';
import { AUDIO_UI, VISIBLE_ACTIONS, statusUi } from './status-ui.js';

const ACTIONS = {
  start: Msg.START,
  pause: Msg.PAUSE,
  resume: Msg.RESUME,
  stop: Msg.STOP,
  cancel: Msg.CANCEL,
  'cancel-export': Msg.CANCEL_EXPORT,
  'retry-export': Msg.RETRY_EXPORT,
  'download-webm': Msg.DOWNLOAD_WEBM,
  discard: Msg.DISCARD,
};

const HINTS = {
  [Status.SELECTING]: 'Elige una pestaña, ventana o pantalla en el diálogo de Chrome.',
  [Status.COUNTDOWN]: 'La captura está lista. La grabación empieza al terminar la cuenta regresiva.',
  [Status.PAUSED]: 'Pausado: lo que ocurra ahora no se graba.',
  [Status.SAVING]: 'Guardando el vídeo…',
  [Status.EXPORTING]: 'Convirtiendo a MP4 en tu equipo. Puedes cerrar esta ventana: la conversión continúa.',
};

const TICKING = [Status.RECORDING, Status.COUNTDOWN];
const LIVE_STATUSES = [Status.COUNTDOWN, Status.RECORDING, Status.PAUSED];

export function mountRecordingControls(root, { onRender } = {}) {
  const q = (role) => root.querySelector(`[data-role="${role}"]`);
  const el = {
    status: q('status'),
    statusIcon: q('status-icon'),
    statusLabel: q('status-label'),
    timer: q('timer'),
    message: q('message'),
    live: q('live'),
    micStatus: q('mic-status'),
    tabStatus: q('tab-status'),
    meter: q('meter'),
    meterFill: q('meter-fill'),
    videoInfo: q('video-info'),
    export: q('export'),
    exportFill: q('export-fill'),
    exportInfo: q('export-info'),
    result: q('result'),
    resultThumb: q('result-thumb'),
    resultTitle: q('result-title'),
    resultMeta: q('result-meta'),
  };
  const buttons = Object.fromEntries(Object.keys(ACTIONS).map((role) => [role, q(role)]));

  let state = null;
  let ticker = null;
  let tickerWindow = null;
  let pending = false;
  let levelChannel = null;

  for (const [role, type] of Object.entries(ACTIONS)) {
    buttons[role]?.addEventListener('click', () => command(type));
  }
  // Acciones sobre la grabación terminada: abren la biblioteca (que mantiene vivo el archivo).
  const libraryAction = (action) => () =>
    sendToBackground(Msg.OPEN_LIBRARY, { recordingId: state?.lastRecording?.libraryId, action }).catch(() => {});
  q('view-recording')?.addEventListener('click', libraryAction('view'));
  q('download-recording')?.addEventListener('click', libraryAction('download'));
  q('open-library')?.addEventListener('click', () => sendToBackground(Msg.OPEN_LIBRARY, {}).catch(() => {}));
  let thumbFor = null;
  let thumbUrl = null;

  async function command(type) {
    pending = true;
    render(state);
    try {
      await sendToBackground(type);
      pending = false;
      render(state); // el cambio de estado pudo pintarse antes de la respuesta, aún deshabilitado
    } catch (error) {
      pending = false;
      render(await getState());
      showMessage({ type: 'error', message: error.message });
    }
  }

  function render(next) {
    if (!next) return;
    state = next;
    const ui = statusUi(state);
    root.dataset.status = state.status;
    if (el.status) el.status.dataset.status = state.status;
    if (el.statusIcon) el.statusIcon.textContent = ui.icon;
    if (el.statusLabel) el.statusLabel.textContent = ui.label;

    const visible = VISIBLE_ACTIONS[state.status] ?? [];
    for (const [role, button] of Object.entries(buttons)) {
      if (!button) continue;
      button.hidden = !visible.includes(role);
      button.disabled = pending;
    }

    renderLive();
    renderExport();
    renderResult();
    renderMessage();
    restartTicker();
    onRender?.(state);
  }

  /** Filas de audio, indicador de nivel y resolución efectiva. */
  function renderLive() {
    // Solo mientras se captura: durante la conversión estas filas ya no aportan nada.
    const live = LIVE_STATUSES.includes(state.status) && !!state.audio;
    if (el.live) el.live.hidden = !live;
    if (!live) {
      listenLevel(false);
      return;
    }
    const { mic, tab } = state.audio;
    if (el.micStatus) {
      el.micStatus.textContent = AUDIO_UI.mic[mic] ?? mic;
      el.micStatus.dataset.state = mic;
    }
    if (el.tabStatus) {
      el.tabStatus.textContent = AUDIO_UI.tab[tab] ?? tab;
      el.tabStatus.dataset.state = tab;
    }
    const micOn = mic === 'on';
    if (el.meter) el.meter.hidden = !micOn;
    listenLevel(micOn);
    if (el.videoInfo) {
      const v = state.video;
      el.videoInfo.textContent = v?.width ? `${v.width}×${v.height} · ${v.frameRate ?? '?'} fps` : '';
    }
  }

  /** «✓ Grabación lista»: miniatura, título y acciones de la grabación guardada en la biblioteca. */
  function renderResult() {
    const rec = state.status === Status.FINISHED ? state.lastRecording : null;
    if (el.result) el.result.hidden = !rec?.libraryId;
    if (!rec?.libraryId) return;
    if (el.resultTitle) el.resultTitle.textContent = rec.title ?? rec.fileName;
    if (el.resultMeta) el.resultMeta.textContent = [formatDuration(rec.durationMs), formatSummary(rec)].filter(Boolean).join(' · ');
    if (el.resultThumb && thumbFor !== rec.libraryId) {
      thumbFor = rec.libraryId;
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      thumbUrl = null;
      el.resultThumb.removeAttribute('src');
      if (rec.hasThumbnail) {
        createLibraryFiles().getFile(rec.libraryId, THUMBNAIL_FILE).then((file) => {
          if (!file || thumbFor !== rec.libraryId) return;
          thumbUrl = URL.createObjectURL(file);
          el.resultThumb.src = thumbUrl;
        }).catch(() => {});
      }
    }
  }

  /** Progreso de la conversión a MP4: barra, porcentaje y tiempo restante. */
  function renderExport() {
    const exporting = state.status === Status.EXPORTING;
    if (el.export) el.export.hidden = !exporting;
    if (!exporting) return;
    const { phase, progress, etaMs } = state.export ?? {};
    const percent = Math.round(Math.min(1, Math.max(0, progress ?? 0)) * 100);
    if (el.exportFill) el.exportFill.style.width = `${percent}%`;
    el.export?.setAttribute('aria-valuenow', String(percent));
    if (el.exportInfo) {
      const parts = [`${percent} %`];
      if (phase === 'converting' && etaMs != null) parts.push(`${formatEta(etaMs)} restantes`);
      if (phase === 'finalizing') parts.push('cerrando el archivo…');
      if (phase === 'downloading') parts.push('guardando en Descargas…');
      el.exportInfo.textContent = parts.join(' · ');
    }
  }

  function listenLevel(on) {
    if (on && !levelChannel) {
      levelChannel = new BroadcastChannel(AUDIO_LEVEL_CHANNEL);
      levelChannel.onmessage = ({ data }) => setLevel(data?.level ?? 0);
    } else if (!on && levelChannel) {
      levelChannel.close();
      levelChannel = null;
      setLevel(0);
    }
  }

  function setLevel(level) {
    if (!el.meterFill) return;
    const percent = Math.round(Math.min(1, Math.max(0, level)) * 100);
    el.meterFill.style.width = `${percent}%`;
    el.meter?.setAttribute('aria-valuenow', String(percent));
  }

  function renderMessage() {
    if (state.notice) {
      showMessage(state.notice);
    } else if (state.status === Status.FINISHED && state.lastRecording) {
      const { fileName, size, kind, fps, note, libraryId } = state.lastRecording;
      const format = kind === 'mp4' ? ` · MP4 H.264 + AAC${fps ? ` · ${Math.round(fps)} fps` : ''}` : '';
      const where = state.autoDownload === false ? 'Guardada en tu biblioteca' : `Descargado: ${fileName}`;
      showMessage({
        type: note ? 'info' : 'success',
        message: `${libraryId ? '✓ ' : ''}${where} (${formatBytes(size)}${format}).${note ? ` ${note}` : ''}`,
      });
    } else if (state.status === Status.RECORDING && state.audio?.plan === 'none') {
      showMessage({ type: 'info', message: 'Grabando solo vídeo (sin audio).' });
    } else if (HINTS[state.status]) {
      showMessage({ type: 'info', message: HINTS[state.status] });
    } else {
      showMessage(null);
    }
  }

  function showMessage(notice) {
    if (!el.message) return;
    el.message.hidden = !notice;
    el.message.textContent = notice?.message ?? '';
    el.message.dataset.type = notice?.type ?? '';
  }

  function tick() {
    if (!el.timer || !state) return;
    if (state.status === Status.COUNTDOWN) {
      el.timer.textContent = String(getCountdownRemaining(state) || '🔴');
      return;
    }
    const ms =
      state.status === Status.FINISHED
        ? state.lastRecording?.durationMs ?? state.elapsedMs
        : getElapsedMs(state);
    el.timer.textContent = formatDuration(ms);
  }

  /**
   * El intervalo se crea en la ventana que contiene el nodo (puede ser la de
   * Picture-in-Picture). Así no lo ralentiza Chrome si la ventana original
   * está minimizada.
   */
  function restartTicker() {
    tickerWindow?.clearInterval(ticker);
    ticker = null;
    tick();
    if (TICKING.includes(state?.status)) {
      tickerWindow = root.ownerDocument.defaultView;
      ticker = tickerWindow.setInterval(tick, 200);
    }
  }

  const unsubscribe = onStateChange(render);

  // SYNC corrige estados huérfanos (p. ej. si Chrome cerró el motor de grabación).
  sendToBackground(Msg.SYNC)
    .then(render)
    .catch(async () => render(await getState()));

  return {
    /** Llamar después de mover `root` a otro documento (Picture-in-Picture). */
    retarget: () => restartTicker(),
    destroy: () => {
      unsubscribe();
      listenLevel(false);
      tickerWindow?.clearInterval(ticker);
    },
  };
}
