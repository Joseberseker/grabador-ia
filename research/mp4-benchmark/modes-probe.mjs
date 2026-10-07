// ¿Puede Chrome headless capturar ventana/pantalla con getDisplayMedia y selección automática?
import { launchChrome, sleep } from './lib/cdp.mjs';
import { resolve } from 'node:path';
const [mode, ...flags] = process.argv.slice(2);
const chrome = await launchChrome({ flags });
try {
  const { id } = await chrome.send('Extensions.loadUnpacked', { path: resolve('extension') });
  await chrome.send('Target.createTarget', { url: 'data:text/html,<title>Ventana de prueba</title><h1>x</h1>' });
  const page = await chrome.open(`chrome-extension://${id}/bench.html`);
  const r = await Promise.race([page.eval(`navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: '${mode}' }, audio: true, selfBrowserSurface: 'exclude' })
    .then(s => { const t = s.getVideoTracks()[0]; const st = t.getSettings(); const out = { surface: st.displaySurface, label: t.label, size: st.width + 'x' + st.height, audio: s.getAudioTracks().length }; s.getTracks().forEach(x => x.stop()); return out; })
    .catch(e => e.name + ': ' + e.message)`, { gesture: true }), sleep(8000).then(() => 'sin respuesta (selector abierto, nadie elige)')]);
  console.log(mode, flags.join(' '), '→', JSON.stringify(r));
} finally { await chrome.close(); }
