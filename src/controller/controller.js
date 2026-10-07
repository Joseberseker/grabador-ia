/**
 * Ventana del controlador (chrome.windows.create type 'popup').
 *
 * Es solo UI: cerrarla no detiene la grabación (vive en el offscreen document)
 * y se puede reabrir desde el popup. Opcionalmente mueve sus controles a una
 * ventana Document Picture-in-Picture, la única API que Chrome ofrece a las
 * páginas para una ventana «siempre encima». Necesita un clic del usuario.
 */

import { isActive } from '../shared/state.js';
import { mountRecordingControls } from '../shared/ui/recording-controls.js';

const widget = document.getElementById('widget');
const slot = document.getElementById('widget-slot');
const pipBtn = document.getElementById('pip-btn');
const pipReturn = document.getElementById('pip-return');
const placeholder = document.getElementById('pip-placeholder');
const closeBtn = document.getElementById('close-btn');

const PIP_SUPPORTED = 'documentPictureInPicture' in window;
const PIP_SIZE = { width: 320, height: 230 };

let pipWindow = null;

const controls = mountRecordingControls(widget, {
  onRender: (state) => {
    // Mientras se graba, «Ocultar» deja claro que la grabación continúa.
    closeBtn.textContent = isActive(state.status) ? 'Ocultar' : 'Cerrar';
    closeBtn.title = isActive(state.status)
      ? 'La grabación continúa. Puedes volver a abrir el controlador desde el icono de la extensión.'
      : '';
  },
});

pipBtn.hidden = !PIP_SUPPORTED;
pipBtn.addEventListener('click', () => openPip().catch(showPipError));
pipReturn.addEventListener('click', () => pipWindow?.close());
closeBtn.addEventListener('click', () => window.close());

async function openPip() {
  if (pipWindow) return;
  pipWindow = await window.documentPictureInPicture.requestWindow(PIP_SIZE);

  const pipDoc = pipWindow.document;
  pipDoc.title = 'Grabación';
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const copy = pipDoc.createElement('link');
    copy.rel = 'stylesheet';
    copy.href = link.href;
    pipDoc.head.append(copy);
  }
  pipDoc.body.classList.add('pip');
  pipDoc.body.append(widget); // se mueve el nodo: conserva sus listeners
  controls.retarget();

  placeholder.hidden = false;
  pipBtn.hidden = true;

  pipWindow.addEventListener('pagehide', onPipClosed, { once: true });
  setOwnWindowState('minimized');
}

function onPipClosed() {
  slot.append(widget);
  pipWindow = null;
  controls.retarget();
  placeholder.hidden = true;
  pipBtn.hidden = false;
  setOwnWindowState('normal');
}

async function setOwnWindowState(state) {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.windows.update(win.id, { state });
  } catch {
    // la ventana se está cerrando: no importa
  }
}

function showPipError(error) {
  pipWindow = null;
  const message = widget.querySelector('[data-role="message"]');
  message.hidden = false;
  message.dataset.type = 'error';
  message.textContent = `No se pudo abrir la ventana flotante: ${error.message}`;
}
