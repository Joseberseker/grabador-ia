#!/usr/bin/env node
/**
 * E2E de la biblioteca (Fase 5) en Chrome real, cargando dist/:
 *   vacío → grabar MP4 → «Grabación lista» → biblioteca → preview (play, seek, volumen,
 *   pantalla completa) → renombrar → grabar WebM → descargar → REINICIAR CHROME →
 *   sigue ahí → eliminar → vacío → rendimiento con 100 grabaciones.
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const log = (...a) => console.log('[e2e-library]', ...a);
let failures = 0;
const check = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
};

const profile = mkdtempSync(join(tmpdir(), 'screen-recorder-library-'));
const downloads = join(profile, 'Descargas');
mkdirSync(join(profile, 'Default'), { recursive: true });
mkdirSync(downloads);
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
const flags = [`--auto-select-tab-capture-source-by-title=${TITLE}`, '--autoplay-policy=no-user-gesture-required'];
const testPage = `data:text/html,<title>${TITLE}</title><canvas id=c width=1280 height=720></canvas><script>` +
  `const x=c.getContext('2d');let i=0;const f=()=>{x.fillStyle='hsl('+(i++*7%25360)+',80%25,50%25)';x.fillRect(0,0,1280,720);requestAnimationFrame(f)};f();` +
  `const a=new AudioContext();const o=a.createOscillator();const g=a.createGain();g.gain.value=0.3;o.connect(g).connect(a.destination);o.start();</script>`;

let chrome = null;
let exitCode = 1;
async function start() {
  chrome = launchChrome({ profile, flags });
  const { id } = await chrome.send('Extensions.loadUnpacked', { path: EXT });
  await waitFor(async () => (await chrome.targets()).find((t) => t.type === 'service_worker' && t.url.includes(id)), 'service worker');
  return id;
}

try {
  let id = await start();
  const ext = (p) => `chrome-extension://${id}/${p}`;
  await chrome.send('Target.createTarget', { url: testPage });
  let popup = await chrome.open(ext('src/popup/popup.html'));
  const state = () => popup.eval(`chrome.storage.session.get('recordingState').then(r => r.recordingState ?? {})`);
  const setSettings = (s) => popup.eval(`chrome.storage.local.set({ settings: ${JSON.stringify({ tabAudio: true, ...s })} })`);
  const record = async (ms) => {
    await popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: 'START' })`);
    await waitFor(async () => ((await state()).status === 'recording' ? true : null), 'grabando');
    await sleep(ms);
    await popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: 'STOP' })`);
    await waitFor(async () => ((await state()).status === 'finished' ? true : null), 'grabación lista', 60000);
    return (await state()).lastRecording;
  };
  const opfs = (page) => page.eval(`(async () => {
    const root = await navigator.storage.getDirectory();
    const out = {};
    for await (const [name, h] of root.entries()) {
      if (h.kind !== 'directory') continue;
      out[name] = {};
      for await (const [n2, h2] of h.entries()) {
        if (h2.kind === 'directory') { out[name][n2] = {}; for await (const [n3, h3] of h2.entries()) out[name][n2][n3] = (await h3.getFile()).size; }
        else out[name][n2] = (await h2.getFile()).size;
      }
    }
    return out;
  })()`);
  const idbLibrary = (page) => page.eval(`import('${ext('src/library/library-repository.js')}').then(m => m.createLibraryRepository().list())`);
  const files = () => readdirSync(downloads).filter((f) => !f.endsWith('.crdownload'));

  // ---------------------------------------------------------------- 1
  log('1) Biblioteca vacía');
  let lib = await chrome.open(ext('src/library/library.html'));
  await sleep(500);
  check(await lib.eval(`!document.getElementById('empty').hidden && document.getElementById('empty').textContent.includes('No tienes grabaciones todavía')`), 'estado vacío: «No tienes grabaciones todavía» + 🔴 Nueva grabación');

  // ---------------------------------------------------------------- 2
  log('2) Grabar MP4 → «✓ Grabación lista»');
  await setSettings({ exportFormat: 'mp4', autoDownload: true });
  const r1 = await record(4000);
  check(!!r1.libraryId && r1.kind === 'mp4', `guardada en la biblioteca: ${r1.libraryId?.slice(0, 8)}… «${r1.title}»`);
  check(files().includes(r1.fileName), `descarga automática conservada: ${r1.fileName}`);
  const card = await waitFor(async () => {
    const r = await popup.eval(`(() => { const b = document.querySelector('[data-role="result"]'); const img = document.querySelector('[data-role="result-thumb"]');
      return !b.hidden && img.complete && img.naturalWidth > 0 ? { title: document.querySelector('[data-role="result-title"]').textContent, meta: document.querySelector('[data-role="result-meta"]').textContent, w: img.naturalWidth, h: img.naturalHeight,
        buttons: ['view-recording','download-recording','open-library'].every(r => !document.querySelector('[data-role="'+r+'"]').hidden) } : null; })()`);
    return r;
  }, 'tarjeta «Grabación lista»');
  check(card.buttons && card.w <= 320 && card.h <= 180, `popup: «${card.title}» · ${card.meta} · miniatura ${card.w}×${card.h} · ▶ Ver · ⬇ Descargar · Mis grabaciones`);

  // ---------------------------------------------------------------- 3
  log('3) Aparece en la biblioteca; almacenamiento coherente');
  const listed = await waitFor(async () => {
    const r = await lib.eval(`(() => { const c = document.querySelector('.card[data-id]'); const img = c?.querySelector('img');
      return c && img.complete && img.naturalWidth > 0 ? { id: c.dataset.id, title: c.querySelector('.card-title').textContent, duration: c.querySelector('.duration').textContent, meta: c.querySelector('.card-meta').textContent, group: c.closest('.group').querySelector('h2').textContent, w: img.naturalWidth } : null; })()`);
    return r;
  }, 'tarjeta en la biblioteca (actualización en vivo)');
  check(listed.id === r1.libraryId && listed.group === 'Hoy', `tarjeta en «${listed.group}»: «${listed.title}» · ${listed.duration} · ${listed.meta} · miniatura ${listed.w} px`);
  let store = await opfs(lib);
  const dir1 = store.library?.[r1.libraryId] ?? {};
  check(dir1['recording.mp4'] > 0 && dir1['thumbnail.jpg'] > 0 && dir1['thumbnail.jpg'] < 60_000, `OPFS library/${r1.libraryId.slice(0, 8)}…: recording.mp4 ${(dir1['recording.mp4'] / 1e6).toFixed(2)} MB + thumbnail.jpg ${(dir1['thumbnail.jpg'] / 1024).toFixed(1)} KB`);
  check(Object.keys(store['conversion-temp'] ?? {}).length === 0, 'el MP4 se MOVIÓ desde conversion-temp (no queda copia temporal)');
  check(statSync(join(downloads, r1.fileName)).size === dir1['recording.mp4'], 'la descarga es el mismo archivo de la biblioteca (mismo tamaño)');
  let meta = (await idbLibrary(lib))[0];
  check(meta.format === 'mp4' && meta.width > 0 && meta.fps > 0 && meta.durationMs > 3000 && meta.hasTabAudio && meta.sourceType === 'browser' && meta.status === 'ready',
    `metadatos: ${meta.width}×${meta.height} · ${meta.fps} fps · ${meta.durationMs} ms · ${meta.videoCodec} · audio pestaña · fuente ${meta.sourceType}`);

  // ---------------------------------------------------------------- 4
  log('4) Preview');
  await lib.eval(`location.hash = '#/recording/${r1.libraryId}'; true`);
  const play = await lib.eval(`(async () => {
    const v = document.getElementById('player');
    if (v.readyState < 1) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
    v.muted = true; await v.play(); await new Promise(r => setTimeout(r, 1200));
    const t1 = v.currentTime; v.pause();
    v.currentTime = v.duration * 0.7; await new Promise(r => v.addEventListener('seeked', r, { once: true }));
    v.volume = 0.4;
    return { duration: v.duration, played: t1, seekedTo: v.currentTime, volume: v.volume, src: v.src.slice(0, 5), fs: document.fullscreenEnabled };
  })()`, { gesture: true });
  check(play.played > 0.5 && Math.abs(play.seekedTo - play.duration * 0.7) < 0.5 && play.volume === 0.4 && play.src === 'blob:',
    `reproduce (${play.played.toFixed(1)} s), seek a ${play.seekedTo.toFixed(1)} s de ${play.duration.toFixed(1)} s, volumen 0,4, fuente blob: del archivo OPFS`);
  const fs = await lib.eval(`document.getElementById('player').requestFullscreen().then(() => { const ok = document.fullscreenElement?.id === 'player'; return document.exitFullscreen().then(() => ok); }, e => 'no: ' + e.message)`, { gesture: true });
  check(fs === true, `pantalla completa del reproductor: ${fs}`);
  check(await lib.eval(`document.getElementById('detail-meta').textContent.includes('MP4')`), 'panel de metadatos visible');

  // ---------------------------------------------------------------- 5
  log('5) Renombrar');
  await lib.eval(`document.getElementById('detail-rename').click(); true`);
  await lib.eval(`document.getElementById('rename-input').value = '   '; document.getElementById('rename-form').requestSubmit(); true`);
  await sleep(300);
  check(await lib.eval(`document.getElementById('rename-dialog').open && !document.getElementById('rename-error').hidden`), `nombre vacío rechazado: «${await lib.eval(`document.getElementById('rename-error').textContent`)}»`);
  await lib.eval(`document.getElementById('rename-input').value = 'Demo del CRM Pocki: v2/final'; document.getElementById('rename-form').requestSubmit(); true`);
  await waitFor(async () => (await lib.eval(`document.getElementById('detail-title').textContent`)) === 'Demo del CRM Pocki: v2/final', 'título actualizado');
  check(!(await lib.eval(`document.getElementById('rename-dialog').open`)), 'renombrado: «Demo del CRM Pocki: v2/final»');

  // ---------------------------------------------------------------- 6
  log('6) Segunda grabación en WebM, sin descarga automática');
  const before = files().length;
  await setSettings({ exportFormat: 'webm', autoDownload: false });
  const r2 = await record(3000);
  check(r2.kind === 'webm' && files().length === before, `WebM guardado solo en la biblioteca (descargas: ${files().length})`);
  await lib.eval(`location.hash = '#/'; true`);
  const order = await waitFor(async () => {
    const ids = await lib.eval(`[...document.querySelectorAll('.card[data-id]')].map(c => c.dataset.id)`);
    return ids.length === 2 ? ids : null;
  }, 'dos tarjetas');
  check(order[0] === r2.libraryId && order[1] === r1.libraryId, 'orden: más recientes primero');
  check((await lib.eval(`document.querySelector('.card[data-id="${r2.libraryId}"] .card-meta').textContent`)).includes('WEBM'), 'formato WEBM en la tarjeta');

  // ---------------------------------------------------------------- 7
  log('7) Descargar desde la biblioteca');
  await lib.eval(`document.querySelector('.card[data-id="${r1.libraryId}"] [data-action="download"]').click(); true`);
  const renamedFile = await waitFor(async () => files().find((f) => f.startsWith('Demo del CRM Pocki')), 'descarga con el nombre nuevo', 20000);
  check(renamedFile === 'Demo del CRM Pocki- v2-final.mp4' && statSync(join(downloads, renamedFile)).size === dir1['recording.mp4'], `«${renamedFile}» (nombre saneado, mismo archivo)`);

  // ---------------------------------------------------------------- 8
  log('8) Cerrar Chrome y volver a abrirlo con el mismo perfil');
  await chrome.send('Browser.close').catch(() => {});
  await new Promise((r) => chrome.proc.once('exit', r));
  id = await start();
  check(ext('x').includes(id), 'misma extensión');
  popup = await chrome.open(ext('src/popup/popup.html'));
  lib = await chrome.open(ext('src/library/library.html'));
  const afterRestart = await waitFor(async () => {
    const r = await lib.eval(`[...document.querySelectorAll('.card[data-id]')].map(c => ({ id: c.dataset.id, title: c.querySelector('.card-title').textContent }))`);
    return r.length === 2 ? r : null;
  }, 'biblioteca tras reiniciar');
  check(afterRestart.find((c) => c.id === r1.libraryId)?.title === 'Demo del CRM Pocki: v2/final', 'tras reiniciar Chrome siguen las 2 grabaciones con el nombre cambiado');
  await lib.eval(`location.hash = '#/recording/${r2.libraryId}'; true`);
  const replay = await lib.eval(`(async () => { const v = document.getElementById('player');
    if (v.readyState < 1) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
    v.muted = true; await v.play(); await new Promise(r => setTimeout(r, 800)); v.pause(); return v.currentTime; })()`, { gesture: true });
  check(replay > 0.3, `la grabación WebM se reproduce tras el reinicio (${replay.toFixed(1)} s)`);

  // ---------------------------------------------------------------- 9
  log('9) Eliminar');
  await lib.eval(`location.hash = '#/'; true`);
  await sleep(300);
  await lib.eval(`document.querySelector('.card[data-id="${r1.libraryId}"] [data-action="delete"]').click(); true`);
  check(await lib.eval(`document.getElementById('delete-dialog').open && document.getElementById('delete-dialog').textContent.includes('Esta acción no se puede deshacer')`), 'confirmación: «¿Eliminar esta grabación? Esta acción no se puede deshacer.»');
  await lib.eval(`document.querySelector('#delete-dialog [value="cancel"]').click(); true`);
  await sleep(300);
  check((await idbLibrary(lib)).length === 2, 'cancelar no borra nada');
  await lib.eval(`document.querySelector('.card[data-id="${r1.libraryId}"] [data-action="delete"]').click(); document.getElementById('delete-confirm').click(); true`);
  await waitFor(async () => ((await lib.eval(`document.querySelectorAll('.card[data-id]').length`)) === 1 ? true : null), 'tarjeta eliminada');
  store = await opfs(lib);
  meta = await idbLibrary(lib);
  check(!store.library?.[r1.libraryId] && meta.length === 1 && meta[0].id === r2.libraryId, 'eliminada: sin carpeta en OPFS (vídeo + miniatura) ni metadatos; la otra intacta');
  check(existsSync(join(downloads, renamedFile)), 'las descargas del usuario no se tocan');
  await lib.eval(`document.querySelector('.card[data-id="${r2.libraryId}"] [data-action="delete"]').click(); document.getElementById('delete-confirm').click(); true`);
  await waitFor(async () => ((await lib.eval(`!document.getElementById('empty').hidden`)) ? true : null), 'vacía');
  store = await opfs(lib);
  check(Object.keys(store.library ?? {}).length === 0 && (await idbLibrary(lib)).length === 0, 'biblioteca vacía: OPFS e IndexedDB sin restos');

  // ---------------------------------------------------------------- 10
  log('10) Rendimiento con 100 grabaciones');
  const seeded = await lib.eval(`(async () => {
    const { createLibrary } = await import('${ext('src/library/library-service.js')}');
    const { createLibraryRepository } = await import('${ext('src/library/library-repository.js')}');
    const canvas = new OffscreenCanvas(320, 180);
    canvas.getContext('2d').fillRect(0, 0, 320, 180);
    const thumb = await canvas.convertToBlob({ type: 'image/jpeg' });
    const lib = createLibrary({ makeThumbnail: async () => thumb, notify: () => {} });
    for (let i = 0; i < 100; i++) {
      await lib.save({ id: 'seed-' + i, format: 'mp4', video: { blob: new Blob([new Uint8Array(1024)]) },
        meta: { createdAt: Date.now() - i * 3600_000, durationMs: 60_000 + i, width: 1920, height: 1080, fps: 30 } });
    }
    return (await createLibraryRepository().count());
  })()`);
  // Página nueva (carga en frío) con las 100 grabaciones.
  lib = await chrome.open(ext('src/library/library.html'));
  const render = await waitFor(async () => {
    const r = await lib.eval(`(() => { const cards = document.querySelectorAll('.card[data-id]').length;
      return cards === 100 ? { cards, thumbsLoaded: [...document.querySelectorAll('.card img')].filter(i => i.src).length, groups: document.querySelectorAll('.group').length,
        heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, nav: Math.round(performance.getEntriesByType('navigation')[0].duration) } : null; })()`);
    return r;
  }, '100 tarjetas', 20000);
  check(seeded === 100 && render.cards === 100 && render.thumbsLoaded < 100, `100 grabaciones: ${render.cards} tarjetas en ${render.groups} grupos · miniaturas cargadas solo las visibles (${render.thumbsLoaded}) · carga ${render.nav} ms · heap JS ${render.heap} MB`);

  exitCode = failures ? 1 : 0;
  log(exitCode ? `FALLÓ (${failures})` : 'OK');
} catch (error) {
  console.error('[e2e-library] ERROR', error.message);
} finally {
  chrome?.proc.kill('SIGKILL');
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
  process.exit(exitCode);
}
