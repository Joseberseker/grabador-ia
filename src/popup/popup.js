/**
 * Popup: interfaz rápida desde el icono de la extensión. Puede cerrarse en
 * cualquier momento (p. ej. al abrirse el selector de Chrome) sin afectar a la
 * grabación, que vive en el offscreen document.
 *
 * Antes de grabar muestra los ajustes (micrófono, audio de pestaña, calidad,
 * cuenta regresiva); durante la grabación, el estado del audio.
 */

import { COMMANDS, Msg, sendToBackground } from '../shared/messages.js';
import { isActive } from '../shared/state.js';
import { getSettings, saveSettings, onSettingsChange } from '../shared/settings.js';
import { mountRecordingControls } from '../shared/ui/recording-controls.js';

const PERMISSION_PAGE = 'src/permission/permission.html';

const $ = (id) => document.getElementById(id);
const ui = {
  settings: $('settings'),
  micToggle: $('mic-toggle'),
  micHint: $('mic-hint'),
  tabToggle: $('tab-toggle'),
  resolution: $('resolution'),
  fps: $('fps'),
  quality: $('quality'),
  countdown: $('countdown'),
  exportFormat: $('export-format'),
  autoDownload: $('autodl-toggle'),
  library: $('library-btn'),
  showController: $('show-controller'),
  shortcuts: $('shortcuts'),
};

mountRecordingControls($('controls'), {
  onRender: (state) => {
    const active = isActive(state.status);
    ui.showController.hidden = !active;
    ui.settings.hidden = active; // los ajustes se aplican a la siguiente grabación
  },
});

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    return 'prompt';
  }
}

async function renderSettings(settings) {
  ui.micToggle.setAttribute('aria-checked', String(settings.micEnabled));
  ui.tabToggle.setAttribute('aria-checked', String(settings.tabAudio));
  ui.resolution.value = settings.resolution;
  ui.fps.value = String(settings.fps);
  ui.quality.value = settings.quality;
  ui.countdown.value = String(settings.countdown);
  ui.exportFormat.value = settings.exportFormat;
  ui.autoDownload.setAttribute('aria-checked', String(settings.autoDownload));

  const permission = await micPermission();
  if (settings.micEnabled && permission !== 'granted') {
    ui.micHint.textContent =
      '⚠ El permiso de micrófono ya no está concedido: se grabará sin micrófono. Desactívalo y vuelve a activarlo.';
  } else if (!settings.micEnabled) {
    ui.micHint.textContent =
      permission === 'denied'
        ? 'El micrófono está bloqueado en los ajustes de Chrome para esta extensión.'
        : 'Al activarlo, Chrome te pedirá permiso.';
  } else {
    ui.micHint.textContent = '';
  }
  ui.micHint.hidden = !ui.micHint.textContent;
}

/**
 * El micrófono nunca se activa en silencio: si el permiso no está concedido,
 * se abre una página visible que lo solicita con una explicación. La opción
 * solo queda en ON si el usuario lo concede.
 */
async function toggleMic() {
  const settings = await getSettings();
  if (settings.micEnabled) {
    await saveSettings({ micEnabled: false });
    return;
  }
  if ((await micPermission()) === 'granted') {
    await saveSettings({ micEnabled: true });
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL(PERMISSION_PAGE) });
  window.close();
}

ui.micToggle.addEventListener('click', toggleMic);
ui.autoDownload.addEventListener('click', async () => {
  const { autoDownload } = await getSettings();
  await saveSettings({ autoDownload: !autoDownload });
});
ui.library.addEventListener('click', async () => {
  await sendToBackground(Msg.OPEN_LIBRARY, {}).catch(() => {});
  window.close();
});
ui.tabToggle.addEventListener('click', async () => {
  const { tabAudio } = await getSettings();
  await saveSettings({ tabAudio: !tabAudio });
});
for (const key of ['resolution', 'fps', 'quality', 'countdown', 'exportFormat']) {
  ui[key].addEventListener('change', () => saveSettings({ [key]: ui[key].value }));
}

onSettingsChange(renderSettings);
renderSettings(await getSettings());

// ---------------------------------------------------------------------------
// Controlador y atajos
// ---------------------------------------------------------------------------

ui.showController.addEventListener('click', async () => {
  await sendToBackground(Msg.SHOW_CONTROLLER).catch(() => {});
  window.close();
});

renderShortcuts();

/** Muestra los atajos reales (el usuario puede cambiarlos en chrome://extensions/shortcuts). */
async function renderShortcuts() {
  const order = Object.keys(COMMANDS);
  const commands = (await chrome.commands.getAll())
    .filter((c) => order.includes(c.name))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  if (!commands.length) return;
  const rows = commands.map((c) => {
    const row = document.createElement('div');
    const kbd = document.createElement('kbd');
    kbd.textContent = c.shortcut || 'sin asignar';
    row.append(kbd, ` ${c.description}`);
    return row;
  });
  // Chrome no asigna un atajo sugerido si ya lo usa otra extensión.
  const configure = document.createElement('button');
  configure.type = 'button';
  configure.className = 'btn btn-link';
  configure.textContent = 'Configurar atajos';
  configure.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  ui.shortcuts.replaceChildren(...rows, configure);
  ui.shortcuts.hidden = false;
}
