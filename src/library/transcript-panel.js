/**
 * Panel «Transcripción» de la vista de detalle de la biblioteca.
 *
 * Estados (ver transcription-service.js):
 *   pendiente (sin registro) · procesando (aquí / en otra pestaña) · interrumpida
 *   · completada · error. Cancelar devuelve a «pendiente».
 *
 * Solo se transcribe cuando el usuario pulsa «Transcribir» (y, la primera vez, acepta
 * descargar el modelo). Los segmentos son botones: un clic lleva el vídeo a ese instante.
 */

import { formatBytes, formatDuration } from '../shared/format.js';
import { MODELS, DEFAULT_MODEL } from '../transcription/models.js';
import { ERROR_MESSAGES, ErrorCode } from '../transcription/transcription-errors.js';
import { BusyError } from '../transcription/transcription-service.js';
import { buildTxt, formatTimestamp, segmentAt, transcriptToText, transcriptToTimestampedText, txtFileName } from '../transcription/transcript-format.js';

const MODEL_KEY_STORAGE = 'transcription.model';

/**
 * @param {object} deps
 * @param {ReturnType<import('../transcription/transcription-service.js').createTranscriptionService>} deps.service
 * @param {HTMLVideoElement} deps.player
 * @param {() => boolean} deps.isRecordingActive
 * @param {(text: string, type?: string) => void} deps.showMessage
 * @param {(blob: Blob, filename: string) => Promise<void>} deps.downloadBlob
 */
export function createTranscriptPanel({ service, player, isRecordingActive, showMessage, downloadBlob }) {
  const $ = (id) => document.getElementById(id);
  const ui = {
    badge: $('tr-badge'),
    start: $('tr-start'), startNote: $('tr-start-note'), models: $('tr-models'), startWarning: $('tr-start-warning'),
    startBtn: $('tr-start-btn'), startBack: $('tr-start-back'),
    progress: $('tr-progress'), progressLabel: $('tr-progress-label'), progressBar: $('tr-progress-bar'), progressDetail: $('tr-progress-detail'),
    cancel: $('tr-cancel'),
    interrupted: $('tr-interrupted'), interruptedText: $('tr-interrupted-text'), resume: $('tr-resume'), discard: $('tr-discard'),
    error: $('tr-error'), errorText: $('tr-error-text'), retry: $('tr-retry'),
    done: $('tr-done'), copy: $('tr-copy'), download: $('tr-download'), timestamps: $('tr-timestamps'), doneMeta: $('tr-done-meta'),
    empty: $('tr-empty'), segments: $('tr-segments'),
    footer: $('tr-footer'), redo: $('tr-redo'), deleteModels: $('tr-delete-models'),
    dialog: $('model-dialog'), dialogName: $('model-dialog-name'), dialogSize: $('model-dialog-size'), dialogReqs: $('model-dialog-reqs'),
  };

  let record = null;
  let transcript = null; // último estado leído de IndexedDB (+ running/interrupted)
  let cached = {}; // modelo → descargado
  let choosing = false; // «Volver a transcribir»: mostrar el selector sobre una completada
  let renderedSegments = null;
  let currentSegment = -1;
  let lastUserScroll = 0;
  let ticker = null;
  let loadToken = 0;

  const selectedModel = () => ui.models.querySelector('input:checked')?.value ?? DEFAULT_MODEL;
  const rememberModel = (key) => {
    try {
      localStorage.setItem(MODEL_KEY_STORAGE, key);
    } catch {
      // preferencia no esencial
    }
  };
  const preferredModel = () => {
    try {
      return MODELS[localStorage.getItem(MODEL_KEY_STORAGE)] ? localStorage.getItem(MODEL_KEY_STORAGE) : DEFAULT_MODEL;
    } catch {
      return DEFAULT_MODEL;
    }
  };

  function renderModelOptions() {
    const preferred = preferredModel();
    const options = Object.values(MODELS).map((m) => {
      const label = document.createElement('label');
      label.className = 'tr-model';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'tr-model';
      input.value = m.key;
      input.checked = m.key === preferred;
      input.addEventListener('change', () => rememberModel(m.key));
      const text = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = m.label;
      const small = document.createElement('small');
      small.textContent = `${cached[m.key] ? 'Descargado' : `Descarga única de ${m.downloadMb} MB`} · ${m.speed}`;
      text.append(strong, small);
      label.append(input, text);
      return label;
    });
    ui.models.replaceChildren(ui.models.querySelector('legend'), ...options);
  }

  // --- carga y render ------------------------------------------------------------

  async function show(next) {
    const changed = record?.id !== next.id;
    record = next;
    if (changed) {
      choosing = false;
      renderedSegments = null;
      currentSegment = -1;
      ui.segments.replaceChildren();
    }
    await reload();
  }

  function hide() {
    record = null;
    transcript = null;
    stopTicker();
  }

  async function reload() {
    if (!record) return;
    const token = ++loadToken;
    const [t, models] = await Promise.all([service.get(record.id), service.cachedModels().catch(() => ({}))]);
    if (token !== loadToken || !record) return; // llegó otra navegación mientras tanto
    transcript = t;
    cached = models;
    render();
  }

  function setBadge(text, status) {
    ui.badge.hidden = !text;
    ui.badge.textContent = text ?? '';
    ui.badge.dataset.status = status ?? '';
  }

  function render() {
    const active = service.active();
    const mine = active?.id === record.id;
    const t = transcript;
    const state = mine || t?.running ? 'processing'
      : !t ? 'none'
      : t.interrupted ? 'interrupted'
      : t.status;
    const view = choosing && (state === 'completed' || state === 'error') ? 'none' : state;

    ui.start.hidden = view !== 'none';
    ui.progress.hidden = view !== 'processing';
    ui.interrupted.hidden = view !== 'interrupted';
    ui.error.hidden = view !== 'error';
    ui.done.hidden = view !== 'completed';
    ui.empty.hidden = !(view === 'completed' && t?.noSpeech);
    const anyCached = Object.values(cached).some(Boolean);
    ui.redo.hidden = !(state === 'completed' || state === 'error') || choosing;
    ui.deleteModels.hidden = !anyCached || !!active;
    ui.footer.hidden = ui.redo.hidden && ui.deleteModels.hidden;

    setBadge(
      { processing: 'Procesando', interrupted: 'Interrumpida', completed: 'Completada', error: 'Error' }[state] ?? 'Pendiente',
      state,
    );

    if (view === 'none') renderStart(state);
    if (view === 'processing') renderProgress(mine ? active : null);
    if (view === 'interrupted') {
      const pct = t.durationMs ? Math.round((100 * t.processedMs) / t.durationMs) : null;
      ui.interruptedText.textContent = `La transcripción se interrumpió (se cerró Chrome o la pestaña)${pct !== null ? ` al ${Math.min(pct, 99)} %` : ''}. Puedes reanudarla donde se quedó.`;
      ui.resume.disabled = isRecordingActive() || !!active;
    }
    if (view === 'error') {
      ui.errorText.textContent = t.error?.message ?? ERROR_MESSAGES[ErrorCode.UNKNOWN];
      ui.retry.hidden = t.error?.code === ErrorCode.NO_AUDIO;
      ui.retry.disabled = isRecordingActive() || !!active;
    }
    if (view === 'completed') {
      const model = MODELS[t.model];
      const date = new Date(t.completedAt ?? t.updatedAt).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
      ui.doneMeta.textContent = `${t.segments.length} fragmentos · modelo ${model?.label ?? t.model} · ${date}`;
      ui.copy.disabled = ui.download.disabled = !!t.noSpeech;
    }
    // Texto: completo, o parcial mientras se procesa / tras una interrupción.
    const segments = view === 'none' ? [] : (t?.segments ?? []);
    renderSegments(segments);
    if (view === 'processing') startTicker();
    else stopTicker();
  }

  function renderStart(state) {
    renderModelOptions();
    const noAudio = record && !record.hasTabAudio && !record.hasMicrophone;
    const recording = isRecordingActive();
    const busy = !!service.active();
    let warning = '';
    if (noAudio) warning = 'Esta grabación se hizo sin audio: no hay nada que transcribir.';
    else if (recording) warning = 'Disponible cuando termine la grabación en curso.';
    else if (busy) warning = 'Hay otra transcripción en curso. Espera a que termine.';
    ui.startWarning.textContent = warning;
    ui.startWarning.hidden = !warning;
    ui.startBtn.disabled = !!warning;
    ui.startBack.hidden = !choosing;
    ui.startNote.textContent = choosing
      ? 'Se sustituirá la transcripción actual. El audio se procesa en tu equipo.'
      : 'Convierte el audio en texto con marcas de tiempo. Se procesa en tu equipo: el audio nunca sale de tu ordenador.';
    if (state === 'error' && choosing) ui.startBack.hidden = false;
  }

  function renderProgress(active) {
    const t = transcript;
    ui.cancel.hidden = !active;
    if (!active) {
      // Procesándose en otra pestaña de la biblioteca: solo lo guardado.
      ui.progressLabel.textContent = 'Transcribiendo en otra pestaña…';
      const ratio = t?.durationMs ? Math.min(1, t.processedMs / t.durationMs) : null;
      setProgress(ratio);
      ui.progressDetail.textContent = ratio !== null ? `${formatDuration(t.processedMs)} de ${formatDuration(t.durationMs)}` : '';
      return;
    }
    if (active.phase === 'loading' || active.phase === 'finishing') {
      ui.progressLabel.textContent = active.phase === 'loading' ? 'Preparando el modelo…' : 'Guardando…';
      setProgress(null);
      ui.progressDetail.textContent = active.phase === 'loading' ? 'La primera vez en cada sesión tarda unos segundos.' : '';
    } else if (active.phase === 'downloading') {
      const { loaded, total } = active.download;
      // transformers.js también informa al leer de la caché: solo es «descarga» si no estaba.
      ui.progressLabel.textContent = cached[active.model] ? 'Cargando el modelo…' : 'Descargando el modelo (solo la primera vez)…';
      setProgress(total ? loaded / total : null);
      ui.progressDetail.textContent = total ? `${formatBytes(loaded)} de ${formatBytes(total)}` : '';
    } else {
      const { processedMs, durationMs, phaseStartMs, phaseStartedAt } = active;
      ui.progressLabel.textContent = 'Transcribiendo…';
      setProgress(durationMs ? Math.min(1, processedMs / durationMs) : null);
      const elapsed = Date.now() - phaseStartedAt;
      const done = processedMs - phaseStartMs;
      let eta = 'calculando el tiempo restante';
      if (done > 0 && durationMs) {
        const remaining = Math.max(0, ((durationMs - processedMs) * elapsed) / done);
        eta = remaining < 60_000 ? 'menos de un minuto' : `quedan ~${Math.round(remaining / 60_000)} min`;
      }
      ui.progressDetail.textContent = `${formatDuration(processedMs)}${durationMs ? ` de ${formatDuration(durationMs)}` : ''} · ${eta}. Puedes seguir usando la biblioteca; no cierres esta pestaña.`;
    }
  }

  function setProgress(ratio) {
    if (ratio === null) ui.progressBar.removeAttribute('value');
    else ui.progressBar.value = ratio;
  }

  function startTicker() {
    ticker ??= setInterval(() => {
      const active = service.active();
      if (record && active?.id === record.id) renderProgress(active);
    }, 1000);
  }

  function stopTicker() {
    clearInterval(ticker);
    ticker = null;
  }

  function renderSegments(segments) {
    if (renderedSegments === segments) return;
    const previousCount = renderedSegments?.length ?? 0;
    const sameRecord = renderedSegments && segments.length >= previousCount;
    // Solo se añaden los nuevos (procesando): no se reconstruye la lista entera.
    const start = sameRecord ? previousCount : 0;
    if (!sameRecord) ui.segments.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (let i = start; i < segments.length; i++) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'seg';
      button.dataset.index = String(i);
      button.title = `Ir a ${formatTimestamp(segments[i].start)}`;
      const time = document.createElement('span');
      time.className = 'seg-time';
      time.textContent = formatTimestamp(segments[i].start);
      const text = document.createElement('span');
      text.className = 'seg-text';
      text.textContent = segments[i].text;
      button.append(time, text);
      li.append(button);
      fragment.append(li);
    }
    ui.segments.append(fragment);
    renderedSegments = segments;
    currentSegment = -1;
    highlight();
  }

  function highlight() {
    const segments = renderedSegments ?? [];
    const index = segmentAt(segments, player.currentTime);
    if (index === currentSegment) return;
    ui.segments.querySelector('[aria-current="true"]')?.removeAttribute('aria-current');
    currentSegment = index;
    if (index < 0) return;
    const button = ui.segments.querySelector(`[data-index="${index}"]`);
    button?.setAttribute('aria-current', 'true');
    // Seguir la reproducción salvo que el usuario esté desplazando la lista.
    if (button && !player.paused && Date.now() - lastUserScroll > 3000) button.scrollIntoView({ block: 'nearest' });
  }

  // --- acciones ------------------------------------------------------------------

  async function startTranscription() {
    if (!record) return;
    const key = selectedModel();
    const model = MODELS[key];
    if (!cached[key]) {
      ui.dialogName.textContent = `${model.label} (Whisper ${key})`;
      ui.dialogSize.textContent = `${model.downloadMb} MB`;
      ui.dialogReqs.textContent = `Necesita ~${model.ramMb >= 1000 ? `${(model.ramMb / 1000).toFixed(1)} GB` : `${model.ramMb} MB`} de memoria libre mientras transcribe. Velocidad: ${model.speed}.`;
      ui.dialog.returnValue = '';
      ui.dialog.showModal();
      const confirmed = await new Promise((resolve) => ui.dialog.addEventListener('close', () => resolve(ui.dialog.returnValue === 'download'), { once: true }));
      if (!confirmed) return;
    }
    await run(() => service.start(record.id, { model: key }));
    choosing = false;
  }

  async function run(action) {
    try {
      await action();
    } catch (error) {
      showMessage(error instanceof BusyError || error?.code ? error.message : `No se pudo iniciar la transcripción: ${error.message}`, 'error');
    }
    await reload();
  }

  ui.startBtn.addEventListener('click', startTranscription);
  ui.startBack.addEventListener('click', () => {
    choosing = false;
    render();
  });
  ui.redo.addEventListener('click', () => {
    choosing = true;
    render();
  });
  ui.retry.addEventListener('click', () => {
    choosing = true;
    render();
  });
  ui.cancel.addEventListener('click', async () => {
    if (!record) return;
    await service.cancel(record.id);
    showMessage('Transcripción cancelada. El vídeo no se ha modificado.', 'info');
    await reload();
  });
  ui.resume.addEventListener('click', () => record && run(() => service.resume(record.id)));
  ui.discard.addEventListener('click', async () => {
    if (!record) return;
    await service.cancel(record.id);
    await reload();
  });

  const exportText = () => {
    const segments = transcript?.segments ?? [];
    return ui.timestamps.checked ? transcriptToTimestampedText(segments) : transcriptToText(segments);
  };
  ui.copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(exportText());
      showMessage('✓ Transcripción copiada al portapapeles.', 'success');
    } catch (error) {
      showMessage(`No se pudo copiar: ${error.message}`, 'error');
    }
  });
  ui.download.addEventListener('click', async () => {
    if (!record || !transcript) return;
    const text = buildTxt({ title: record.title, segments: transcript.segments, withTimestamps: ui.timestamps.checked });
    await downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), txtFileName(record.title));
  });
  ui.deleteModels.addEventListener('click', async () => {
    try {
      await service.deleteModels();
      showMessage('Modelos de transcripción eliminados. Se volverán a descargar si los necesitas.', 'info');
    } catch (error) {
      showMessage(error.message, 'error');
    }
    await reload();
  });

  ui.segments.addEventListener('click', (event) => {
    const button = event.target.closest('.seg');
    if (!button || !renderedSegments) return;
    const segment = renderedSegments[Number(button.dataset.index)];
    if (!segment) return;
    player.currentTime = segment.start;
    player.play().catch(() => {});
  });
  for (const type of ['wheel', 'touchmove', 'keydown']) ui.segments.addEventListener(type, () => (lastUserScroll = Date.now()), { passive: true });
  player.addEventListener('timeupdate', highlight);
  player.addEventListener('seeked', highlight);

  // Progreso del worker de esta página: re-render barato con lo ya leído (la descarga
  // emite muchos eventos). Al terminar (snapshot null) se relee de IndexedDB. Los
  // bloques ya persistidos llegan por BroadcastChannel (library.js → reload()).
  service.onChange((snapshot) => {
    if (!record) return;
    if (snapshot?.id === record.id) render();
    else reload();
  });

  return { show, hide, reload, render: () => record && render() };
}
