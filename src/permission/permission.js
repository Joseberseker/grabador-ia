/**
 * Página de permiso de micrófono.
 *
 * El offscreen document no puede mostrar el aviso de permiso (es invisible):
 * getUserMedia allí falla con «Permission dismissed». Por eso el permiso se
 * pide aquí, en una pestaña visible de la extensión, y SOLO cuando el usuario
 * activa «Micrófono» en el popup. Una vez concedido al origen de la extensión,
 * el offscreen puede capturar el micrófono durante las grabaciones.
 *
 * El micrófono solo se abre un instante para obtener el permiso y se cierra
 * enseguida. La opción micEnabled solo se guarda si el permiso se concede.
 */

import { saveSettings } from '../shared/settings.js';

const message = document.getElementById('message');
const retryBtn = document.getElementById('retry-btn');
const settingsBtn = document.getElementById('settings-btn');
const closeBtn = document.getElementById('close-btn');

function show(text, type) {
  message.textContent = text;
  message.dataset.type = type;
}

async function closeTab() {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id != null) chrome.tabs.remove(tab.id);
}

async function requestMicrophone() {
  retryBtn.hidden = true;
  settingsBtn.hidden = true;
  show('Esperando tu respuesta en el aviso de Chrome…', 'info');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((track) => track.stop()); // no lo mantenemos abierto
    await saveSettings({ micEnabled: true });
    show('✓ Micrófono activado. Se usará en tus próximas grabaciones. Cerrando…', 'success');
    setTimeout(closeTab, 1500);
  } catch (error) {
    await saveSettings({ micEnabled: false });
    if (error.name === 'NotFoundError') {
      show('No se encontró ningún micrófono conectado. Conecta uno y vuelve a intentarlo.', 'error');
      retryBtn.hidden = false;
    } else if (error.name === 'NotAllowedError') {
      const state = await navigator.permissions.query({ name: 'microphone' }).then((p) => p.state, () => 'denied');
      if (state === 'denied') {
        show(
          'El permiso de micrófono está bloqueado para esta extensión. Actívalo en los ajustes de Chrome ' +
            '(Micrófono → Permitir) y vuelve a activar la opción en el popup.',
          'error',
        );
        settingsBtn.hidden = false;
      } else {
        show('No se concedió el permiso. El micrófono sigue desactivado.', 'error');
        retryBtn.hidden = false;
      }
    } else {
      show(`No se pudo acceder al micrófono (${error.name}). El micrófono sigue desactivado.`, 'error');
      retryBtn.hidden = false;
    }
  }
}

retryBtn.addEventListener('click', requestMicrophone);
closeBtn.addEventListener('click', closeTab);
settingsBtn.addEventListener('click', () => {
  chrome.tabs.create({
    url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`,
  });
});

requestMicrophone();
