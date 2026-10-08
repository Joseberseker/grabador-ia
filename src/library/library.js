/**
 * Página «Mis grabaciones»: lista, preview, renombrar, descargar y eliminar.
 *
 * Memoria: solo se cargan metadatos (IndexedDB) y miniaturas visibles
 * (IntersectionObserver). El vídeo se reproduce desde el File de OPFS mediante
 * una URL blob: el navegador lo lee por partes desde disco, sin cargarlo entero.
 * Rutas: #/  ·  #/recording/<id>  ·  #/recording/<id>/download
 *
 * Transcripción (fase 6): panel junto al vídeo (transcript-panel.js). El trabajo pesado
 * corre en un Worker de esta página; nunca empieza sin un clic del usuario.
 */

import { Msg, sendToBackground } from '../shared/messages.js';
import { getState, isActive, onStateChange } from '../shared/state.js';
import { formatBytes, formatDuration } from '../shared/format.js';
import { createLibrary, LIBRARY_CHANNEL, TitleError } from './library-service.js';
import { SOURCE_LABEL, formatSummary, groupByDay, resolutionLabel, sanitizeFileName } from './recording-meta.js';
import { createTranscriptionService, TRANSCRIPT_CHANNEL } from '../transcription/transcription-service.js';
import { createTranscriptPanel } from './transcript-panel.js';

const $ = (id) => document.getElementById(id);
const ui = {
  count: $('count'),
  newRecording: $('new-recording'),
  message: $('message'),
  listView: $('list-view'),
  detailView: $('detail-view'),
  empty: $('empty'),
  groups: $('groups'),
  player: $('player'),
  detailTitle: $('detail-title'),
  detailMeta: $('detail-meta'),
  renameDialog: $('rename-dialog'),
  renameForm: $('rename-form'),
  renameInput: $('rename-input'),
  renameError: $('rename-error'),
  deleteDialog: $('delete-dialog'),
  deleteName: $('delete-name'),
  cardTemplate: $('card-template'),
};

const library = createLibrary();
const transcription = createTranscriptionService({ library });
let records = [];
let transcriptStatuses = new Map(); // id → 'processing' | 'completed' | 'error'
let recordingActive = false;
let currentId = null;
let playerUrl = null;
const thumbUrls = new Map(); // id → URL blob de la miniatura
const downloads = new Map(); // id de descarga → URL blob (se revoca al terminar)

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

async function refresh() {
  try {
    records = await library.list();
    transcriptStatuses = await transcription.statuses().catch(() => new Map());
  } catch (error) {
    showMessage(`No se pudo leer la biblioteca: ${error.message}`, 'error');
    records = [];
  }
  for (const [id, url] of thumbUrls) {
    if (!records.some((r) => r.id === id)) {
      URL.revokeObjectURL(url);
      thumbUrls.delete(id);
    }
  }
  renderList();
  await route();
}

const byId = (id) => records.find((r) => r.id === id) ?? null;

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    thumbObserver.unobserve(entry.target);
    loadThumbnail(entry.target);
  }
}, { rootMargin: '200px' });

async function loadThumbnail(img) {
  const record = byId(img.dataset.id);
  if (!record?.thumbnailFileName) return;
  let url = thumbUrls.get(record.id);
  if (!url) {
    const file = await library.getThumbnail(record).catch(() => null);
    if (!file) return;
    url = URL.createObjectURL(file);
    thumbUrls.set(record.id, url);
  }
  img.src = url;
}

function renderList() {
  ui.count.textContent = records.length ? `${records.length} ${records.length === 1 ? 'grabación' : 'grabaciones'}` : '';
  ui.empty.hidden = records.length > 0;
  thumbObserver.disconnect();
  const fragment = document.createDocumentFragment();
  for (const group of groupByDay(records)) {
    const section = document.createElement('section');
    section.className = 'group';
    const heading = document.createElement('h2');
    heading.textContent = group.label;
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const record of group.items) grid.append(renderCard(record));
    section.append(heading, grid);
    fragment.append(section);
  }
  ui.groups.replaceChildren(fragment);
}

function renderCard(record) {
  const card = ui.cardTemplate.content.firstElementChild.cloneNode(true);
  card.dataset.id = record.id;
  const link = card.querySelector('.card-thumb');
  link.href = `#/recording/${encodeURIComponent(record.id)}`;
  link.setAttribute('aria-label', `Ver ${record.title}`);
  const img = card.querySelector('img');
  img.dataset.id = record.id;
  if (record.thumbnailFileName) thumbObserver.observe(img);
  else link.classList.add('no-thumb');
  card.querySelector('.duration').textContent = formatDuration(record.durationMs);
  card.querySelector('.card-title').textContent = record.title;
  card.querySelector('.card-title').title = record.title;
  const time = new Date(record.createdAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  card.querySelector('.card-meta').textContent = `${time} · ${formatSummary(record)}`;
  renderCardBadge(card.querySelector('.card-badge'), transcriptStatuses.get(record.id));
  card.querySelector('[data-action="download"]').addEventListener('click', () => download(record.id));
  card.querySelector('[data-action="rename"]').addEventListener('click', () => openRename(record.id));
  card.querySelector('[data-action="delete"]').addEventListener('click', () => openDelete(record.id));
  return card;
}

const BADGE = { completed: '📝 Transcrita', processing: '⏳ Transcripción sin terminar', error: '⚠ Transcripción con error' };
function renderCardBadge(element, status) {
  element.hidden = !BADGE[status];
  element.textContent = BADGE[status] ?? '';
}

async function refreshBadges() {
  transcriptStatuses = await transcription.statuses().catch(() => transcriptStatuses);
  for (const card of ui.groups.querySelectorAll('.card')) renderCardBadge(card.querySelector('.card-badge'), transcriptStatuses.get(card.dataset.id));
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function parseRoute() {
  const match = location.hash.match(/^#\/recording\/([^/]+)(\/download)?$/);
  return match ? { id: decodeURIComponent(match[1]), download: !!match[2] } : { id: null };
}

async function route() {
  const { id, download: wantsDownload } = parseRoute();
  if (!id) return showList();
  const record = byId(id);
  if (!record) {
    showMessage('Esa grabación ya no existe.', 'error');
    history.replaceState(null, '', '#/');
    return showList();
  }
  await showDetail(record);
  if (wantsDownload) {
    history.replaceState(null, '', `#/recording/${encodeURIComponent(id)}`);
    await download(id);
  }
}

function showList() {
  panel.hide();
  releasePlayer();
  ui.detailView.hidden = true;
  ui.listView.hidden = false;
  document.title = 'Mis grabaciones';
}

async function showDetail(record) {
  ui.listView.hidden = true;
  ui.detailView.hidden = false;
  document.title = record.title;
  ui.detailTitle.textContent = record.title;
  renderMeta(record);
  panel.show(record);
  if (currentId === record.id && playerUrl) return; // ya cargado (p. ej. tras renombrar)
  releasePlayer();
  try {
    const { file } = await library.getVideo(record.id);
    playerUrl = URL.createObjectURL(file); // File de OPFS: el vídeo se lee desde disco por partes
    currentId = record.id;
    ui.player.src = playerUrl;
  } catch (error) {
    showMessage(error.message, 'error');
  }
}

function renderMeta(record) {
  const rows = [
    ['Fecha', new Date(record.createdAt).toLocaleString('es', { dateStyle: 'long', timeStyle: 'short' })],
    ['Duración', formatDuration(record.durationMs)],
    ['Formato', record.format.toUpperCase() + (record.videoCodec ? ` (${record.videoCodec})` : '')],
    ['Resolución', record.width ? `${record.width}×${record.height} (${resolutionLabel(record)})` : '—'],
    ['FPS', record.fps ?? '—'],
    ['Tamaño', formatBytes(record.fileSize)],
    ['Audio', [record.hasTabAudio && 'pestaña', record.hasMicrophone && 'micrófono'].filter(Boolean).join(' + ') || 'sin audio'],
    ['Fuente', SOURCE_LABEL[record.sourceType] ?? '—'],
  ];
  ui.detailMeta.replaceChildren(...rows.map(([label, value]) => {
    const pair = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    pair.append(dt, dd);
    return pair;
  }));
}

function releasePlayer() {
  ui.player.pause();
  ui.player.removeAttribute('src');
  ui.player.load();
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = null;
  currentId = null;
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
    downloads.set(downloadId, url);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function download(id) {
  try {
    const { record, file } = await library.getVideo(id);
    await downloadBlob(file, sanitizeFileName(record.title, record.format));
    showMessage(`Descargando «${record.title}»…`, 'info');
  } catch (error) {
    showMessage(`No se pudo descargar: ${error.message}`, 'error');
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  const url = downloads.get(delta.id);
  const state = delta.state?.current;
  if (!url || !state || state === 'in_progress') return;
  URL.revokeObjectURL(url);
  downloads.delete(delta.id);
  showMessage(state === 'complete' ? '✓ Descarga completada.' : 'La descarga no se completó.', state === 'complete' ? 'success' : 'error');
});

let renameId = null;
function openRename(id) {
  const record = byId(id);
  if (!record) return;
  renameId = id;
  ui.renameInput.value = record.title;
  ui.renameError.hidden = true;
  ui.renameDialog.showModal();
  ui.renameInput.select();
}

ui.renameForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await library.rename(renameId, ui.renameInput.value);
    ui.renameDialog.close();
    await refresh();
  } catch (error) {
    ui.renameError.textContent = error instanceof TitleError ? error.message : `No se pudo renombrar: ${error.message}`;
    ui.renameError.hidden = false;
  }
});
$('rename-cancel').addEventListener('click', () => ui.renameDialog.close());

let deleteId = null;
function openDelete(id) {
  const record = byId(id);
  if (!record) return;
  deleteId = id;
  ui.deleteName.textContent = `«${record.title}» · ${formatDuration(record.durationMs)} · ${formatBytes(record.fileSize)}`;
  ui.deleteDialog.returnValue = '';
  ui.deleteDialog.showModal();
}

ui.deleteDialog.addEventListener('close', async () => {
  if (ui.deleteDialog.returnValue !== 'delete' || !deleteId) return;
  const id = deleteId;
  deleteId = null;
  if (currentId === id) releasePlayer();
  try {
    // Una transcripción en curso de esta grabación se cancela antes de borrar el vídeo.
    if (transcription.active()?.id === id) await transcription.cancel(id);
    await library.remove(id);
    showMessage('Grabación eliminada.', 'info');
  } catch (error) {
    showMessage(`No se pudo eliminar: ${error.message}`, 'error');
  }
  if (parseRoute().id === id) history.replaceState(null, '', '#/');
  await refresh();
});

$('detail-download').addEventListener('click', () => currentId && download(currentId));
$('detail-rename').addEventListener('click', () => currentId && openRename(currentId));
$('detail-delete').addEventListener('click', () => currentId && openDelete(currentId));

async function newRecording() {
  try {
    await sendToBackground(Msg.START);
  } catch (error) {
    showMessage(error.message, 'error');
  }
}
ui.newRecording.addEventListener('click', newRecording);
document.querySelector('[data-action="new"]').addEventListener('click', newRecording);

const panel = createTranscriptPanel({
  service: transcription,
  player: ui.player,
  isRecordingActive: () => recordingActive,
  showMessage,
  downloadBlob,
});

function showMessage(text, type = 'info') {
  ui.message.textContent = text;
  ui.message.dataset.type = type;
  ui.message.hidden = false;
}

// ---------------------------------------------------------------------------
// Sincronización
// ---------------------------------------------------------------------------

const renderRecordingState = (state) => {
  recordingActive = isActive(state.status);
  panel.render();
  ui.newRecording.disabled = isActive(state.status);
  ui.newRecording.textContent = isActive(state.status) ? '⏺ Grabación en curso…' : '🔴 Nueva grabación';
};
onStateChange(renderRecordingState);
renderRecordingState(await getState());

// Cambios hechos en otros contextos (grabación guardada, renombrada o eliminada).
new BroadcastChannel(LIBRARY_CHANNEL).onmessage = async () => {
  await refresh();
  // Grabación eliminada desde otra pestaña mientras esta la transcribía: se cancela.
  const active = transcription.active();
  if (active && !byId(active.id)) await transcription.cancel(active.id);
};
// Transcripciones: bloques guardados, inicio/fin (de esta u otra pestaña).
new BroadcastChannel(TRANSCRIPT_CHANNEL).onmessage = () => {
  refreshBadges();
  panel.reload();
};
window.addEventListener('beforeunload', (event) => {
  if (transcription.active()) event.preventDefault(); // «¿Salir? La transcripción se interrumpirá»
});
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => {
  releasePlayer();
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
});

await refresh();
