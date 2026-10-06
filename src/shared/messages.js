/**
 * Contrato de mensajes entre los contextos de la extensión.
 *
 *   popup / controlador / atajos ──comandos──▶ background ──OFFSCREEN_*──▶ offscreen
 *   offscreen ──eventos REC_*──────────────────▶ background
 *   offscreen ──BroadcastChannel (nivel de micro)──▶ popup / controlador
 *   background ──escribe──▶ chrome.storage.session ──onChanged──▶ popup / controlador
 *
 * Cada mensaje lleva un `target` porque chrome.runtime.sendMessage llega a todas
 * las páginas de la extensión; cada contexto ignora lo que no es suyo.
 * Todas las respuestas tienen la forma `{ ok: boolean, data?, error? }`.
 */

export const Target = Object.freeze({
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen',
});

export const Msg = Object.freeze({
  // UI / atajos -> background
  START: 'START',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  STOP: 'STOP',
  CANCEL: 'CANCEL',
  TOGGLE_RECORDING: 'TOGGLE_RECORDING',
  TOGGLE_PAUSE: 'TOGGLE_PAUSE',
  SHOW_CONTROLLER: 'SHOW_CONTROLLER',
  SYNC: 'SYNC',
  CANCEL_EXPORT: 'CANCEL_EXPORT',
  RETRY_EXPORT: 'RETRY_EXPORT',
  DOWNLOAD_WEBM: 'DOWNLOAD_WEBM',
  DISCARD: 'DISCARD',
  OPEN_LIBRARY: 'OPEN_LIBRARY',

  // background -> offscreen
  OFFSCREEN_START: 'OFFSCREEN_START',
  OFFSCREEN_PAUSE: 'OFFSCREEN_PAUSE',
  OFFSCREEN_RESUME: 'OFFSCREEN_RESUME',
  OFFSCREEN_STOP: 'OFFSCREEN_STOP',
  OFFSCREEN_RELEASE: 'OFFSCREEN_RELEASE',
  OFFSCREEN_EXPORT: 'OFFSCREEN_EXPORT',
  OFFSCREEN_CANCEL_EXPORT: 'OFFSCREEN_CANCEL_EXPORT',
  OFFSCREEN_SAVE: 'OFFSCREEN_SAVE',

  // offscreen -> background
  REC_COUNTDOWN: 'REC_COUNTDOWN',
  REC_STARTED: 'REC_STARTED',
  REC_WARNING: 'REC_WARNING',
  REC_SAVING: 'REC_SAVING',
  REC_FINISHED: 'REC_FINISHED',
  REC_FAILED: 'REC_FAILED',
  EXPORT_PROGRESS: 'EXPORT_PROGRESS',
  EXPORT_DONE: 'EXPORT_DONE',
  EXPORT_FAILED: 'EXPORT_FAILED',
});

/** BroadcastChannel del nivel del micrófono: offscreen → popup / controlador. */
export const AUDIO_LEVEL_CHANNEL = 'recorder-audio-level';

/** Nombres de chrome.commands (manifest.json) -> comando interno. */
export const COMMANDS = Object.freeze({
  'toggle-recording': Msg.TOGGLE_RECORDING,
  'toggle-pause': Msg.TOGGLE_PAUSE,
});

export async function sendMessage(target, type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target, type, ...payload });
  if (!response?.ok) {
    throw new Error(response?.error || `Sin respuesta de «${target}».`);
  }
  return response.data;
}

export const sendToBackground = (type, payload) => sendMessage(Target.BACKGROUND, type, payload);
export const sendToOffscreen = (type, payload) => sendMessage(Target.OFFSCREEN, type, payload);

/**
 * Registra un listener que solo atiende mensajes de esta extensión para `target`.
 * `handlers[type](message, sender)` puede ser async; su valor se envía como `data`.
 */
export function listen(target, handlers, { log = 'ext' } = {}) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.target !== target) return false;
    const handler = handlers[message.type];
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(message, sender))
      .then((data) => sendResponse({ ok: true, data: data ?? null }))
      .catch((error) => {
        console.error(`[${log}] ${message.type}:`, error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true; // respuesta asíncrona
  });
}
