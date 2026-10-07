#!/usr/bin/env node
/**
 * E2E (Q5): Chrome muere a mitad de una conversión MP4 (SIGKILL) y se vuelve a abrir con
 * el mismo perfil. Al arrancar, la extensión debe borrar el MP4 temporal (OPFS), los
 * fragmentos del WebM (IndexedDB) y cualquier huérfano, y volver a LISTO.
 *
 * No se ofrece recuperación tras un cuelgue (documentado en el README, 3A): lo que se
 * garantiza es que no quede basura indefinidamente.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep, waitFor } from './lib/cdp.mjs';

const EXT = resolve(process.env.EXTENSION_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error(`No hay extensión en ${EXT}: ejecuta «npm run build».`);
  process.exit(1);
}
const TITLE = 'PaginaDePrueba';
const log = (...a) => console.log('[e2e-crash]', ...a);
let failures = 0;
const check = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
};

const profile = mkdtempSync(join(tmpdir(), 'screen-recorder-crash-'));
mkdirSync(join(profile, 'Default'), { recursive: true });
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: join(profile, 'dl'), prompt_for_download: false } }));
const flags = [`--auto-select-tab-capture-source-by-title=${TITLE}`, '--autoplay-policy=no-user-gesture-required'];
const page = `data:text/html,<title>${TITLE}</title><canvas id=c width=1280 height=720></canvas><script>` +
  `const x=c.getContext('2d');let i=0;const f=()=>{x.fillStyle='hsl('+(i++*7%25360)+',80%25,50%25)';x.fillRect(0,0,1280,720);requestAnimationFrame(f)};f();</script>`;

let chrome = null;
let exitCode = 1;
try {
  // --- Sesión 1: grabar, empezar a convertir y «colgar» Chrome --------------------
  log('Sesión 1: grabar → convertir → SIGKILL a mitad');
  chrome = launchChrome({ profile, flags });
  const { id } = await chrome.send('Extensions.loadUnpacked', { path: EXT });
  const ext = (p) => `chrome-extension://${id}/${p}`;
  await chrome.send('Target.createTarget', { url: page });
  const popup = await chrome.open(ext('src/popup/popup.html'));
  const state = () => popup.eval(`chrome.storage.session.get('recordingState').then(r => r.recordingState ?? {})`);
  await popup.eval(`chrome.storage.local.set({ settings: { exportFormat: 'mp4', quality: 'max', fps: 60, tabAudio: false } })`);
  await popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: 'START' })`);
  await waitFor(async () => ((await state()).status === 'recording' ? true : null), 'grabando');
  await sleep(10000);
  await popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: 'STOP' })`);
  const progress = await waitFor(async () => { const s = await state(); return s.status === 'exporting' && s.export?.progress > 0.1 ? s.export.progress : null; }, 'conversión en marcha', 30000);
  await popup.eval(`navigator.storage.getDirectory().then(r => r.getDirectoryHandle('conversion-temp', { create: true }))
    .then(d => d.getFileHandle('huerfano-anterior.mp4', { create: true })).then(h => h.createWritable()).then(w => w.close())`);
  const before = await popup.eval(`import('${ext('src/conversion/temp-files.js')}').then(m => m.listTempFiles())`);
  const idbBefore = await popup.eval(`import('${ext('src/recording/chunk-store.js')}').then(m => m.storageSummary())`);
  check(before.length >= 2 && idbBefore.chunks > 0, `antes del cuelgue (al ${Math.round(progress * 100)} %): OPFS [${before.map((f) => f.name).join(', ')}] · IndexedDB ${idbBefore.chunks} fragmentos`);
  chrome.proc.kill('SIGKILL');
  await sleep(1500);

  // --- Sesión 2: mismo perfil, arranque normal -------------------------------------
  log('Sesión 2: reabrir Chrome con el mismo perfil');
  chrome = launchChrome({ profile, flags });
  const { id: id2 } = await chrome.send('Extensions.loadUnpacked', { path: EXT });
  check(id2 === id, 'misma extensión (mismo id)');
  await waitFor(async () => (await chrome.targets()).find((t) => t.type === 'service_worker' && t.url.includes(id2)), 'service worker');
  await sleep(2000);
  const popup2 = await chrome.open(ext('src/popup/popup.html'));
  const after = await waitFor(async () => {
    const files = await popup2.eval(`import('${ext('src/conversion/temp-files.js')}').then(m => m.listTempFiles())`);
    return files.length === 0 ? files : null;
  }, 'OPFS limpio', 15000).catch(() => null);
  check(Array.isArray(after), 'OPFS: temporal interrumpido y huérfano borrados al arrancar');
  const idbAfter = await popup2.eval(`import('${ext('src/recording/chunk-store.js')}').then(m => m.storageSummary())`);
  check(idbAfter.chunks === 0 && idbAfter.recordings === 0, `IndexedDB vacío (${JSON.stringify(idbAfter)})`);
  const s2 = await popup2.eval(`chrome.storage.session.get('recordingState').then(r => r.recordingState ?? { status: 'idle' })`);
  check(s2.status === 'idle', `estado tras reiniciar: ${s2.status}`);
  check(await popup2.eval(`document.querySelector('[data-role="status-label"]').textContent`) === 'LISTO', 'la UI vuelve a ● LISTO');

  exitCode = failures ? 1 : 0;
  log(exitCode ? `FALLÓ (${failures})` : 'OK');
} catch (error) {
  console.error('[e2e-crash] ERROR', error.message);
} finally {
  chrome?.proc.kill('SIGKILL');
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
  process.exit(exitCode);
}
