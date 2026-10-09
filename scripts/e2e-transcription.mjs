#!/usr/bin/env node
/**
 * E2E de la transcripción (Fase 6) en Chrome REAL con el modelo Whisper REAL, cargando dist/.
 *
 * Entrada: una pestaña que reproduce voz humana real en español (Wikipedia hablada,
 * tests/fixtures/audio) y se graba con audio de pestaña → MP4 (AAC) real de la extensión.
 *
 * Perfil persistente en .cache/e2e-transcription-profile para no descargar el modelo
 * (≈76 MB) en cada ejecución; el estado de la biblioteca se limpia al empezar.
 * E2E_FRESH_PROFILE=1 usa un perfil nuevo (prueba también la primera descarga).
 * Requiere conexión a Hugging Face la primera vez.
 */
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep, waitFor } from './lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = resolve(process.env.EXTENSION_DIR ?? join(ROOT, 'dist'));
if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error(`No hay extensión en ${EXT}: ejecuta «npm run build».`);
  process.exit(1);
}
const TITLE = 'PaginaVozES';
const SPEECH_MS = 75_000; // 2 bloques: ~60 s + ~15 s
const log = (...a) => console.log('[e2e-transcription]', ...a);
let failures = 0;
const check = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
};

// --- página de prueba con voz real ---------------------------------------------------
const audio = readFileSync(join(ROOT, 'tests/fixtures/audio/es-judit-reyes.ogg'));
const server = createServer((req, res) => {
  if (req.url.startsWith('/voz.ogg')) {
    res.writeHead(200, { 'content-type': 'audio/ogg', 'content-length': audio.length });
    return res.end(audio);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  return res.end(`<!doctype html><title>${TITLE}</title><canvas id=c width=960 height=540></canvas><audio id=a src="/voz.ogg"></audio>
<script>const x=c.getContext('2d');let i=0;const f=()=>{x.fillStyle='hsl('+(i++%360)+',70%,50%)';x.fillRect(0,0,960,540);requestAnimationFrame(f)};f();</script>`);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const fresh = process.env.E2E_FRESH_PROFILE === '1';
const profile = fresh ? mkdtempSync(join(tmpdir(), 'screen-recorder-transcription-')) : join(ROOT, '.cache/e2e-transcription-profile');
const downloads = join(profile, 'Descargas');
mkdirSync(join(profile, 'Default'), { recursive: true });
rmSync(downloads, { recursive: true, force: true });
mkdirSync(downloads);
const prefsFile = join(profile, 'Default', 'Preferences');
const prefs = existsSync(prefsFile) ? JSON.parse(readFileSync(prefsFile, 'utf8')) : {};
prefs.download = { default_directory: downloads, prompt_for_download: false, directory_upgrade: true };
writeFileSync(prefsFile, JSON.stringify(prefs));
const flags = [`--auto-select-tab-capture-source-by-title=${TITLE}`, '--autoplay-policy=no-user-gesture-required'];

/** RSS total (MB) de los procesos de Chrome de este perfil. */
const chromeRssMb = () => {
  try {
    const out = execSync(`ps -eo rss=,args= | grep -F -- '--user-data-dir=${profile}' | grep -v grep`, { encoding: 'utf8' });
    return Math.round(out.trim().split('\n').reduce((n, line) => n + Number(line.trim().split(/\s+/)[0] || 0), 0) / 1024);
  } catch {
    return 0;
  }
};

let chrome = null;
let id = null;
let exitCode = 1;
const ext = (p) => `chrome-extension://${id}/${p}`;
async function start() {
  chrome = launchChrome({ profile, flags });
  ({ id } = await chrome.send('Extensions.loadUnpacked', { path: EXT }));
  await waitFor(async () => (await chrome.targets()).find((t) => t.type === 'service_worker' && t.url.includes(id)), 'service worker');
}
async function restart({ kill = false } = {}) {
  if (kill) chrome.proc.kill('SIGKILL'); // como un cierre forzado / cuelgue
  else await chrome.send('Browser.close').catch(() => {});
  await new Promise((r) => (chrome.proc.exitCode !== null ? r() : chrome.proc.once('exit', r)));
  await sleep(500);
  await start();
}

try {
  await start();
  let popup = await chrome.open(ext('src/popup/popup.html'));
  let page = await chrome.open(pageUrl);
  const state = () => popup.eval(`chrome.storage.session.get('recordingState').then(r => r.recordingState ?? {})`);
  const setSettings = (s) => popup.eval(`chrome.storage.local.set({ settings: ${JSON.stringify(s)} })`);
  const record = async (ms, { speech = true } = {}) => {
    if (speech) await page.eval(`(async () => { const a = document.getElementById('a'); a.currentTime = 0; await a.play(); return true; })()`, { gesture: true });
    await popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: 'START' })`);
    await waitFor(async () => ((await state()).status === 'recording' ? true : null), 'grabando');
    await sleep(ms);
    await popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: 'STOP' })`);
    await waitFor(async () => ((await state()).status === 'finished' ? true : null), 'grabación lista', 120000);
    if (speech) await page.eval(`document.getElementById('a').pause(); true`);
    return (await state()).lastRecording;
  };

  let lib = await chrome.open(ext('src/library/library.html'));
  const transcriptOf = (rid, p = lib) => p.eval(`import('${ext('src/transcription/transcript-repository.js')}').then(m => m.createTranscriptRepository().get('${rid}'))`);
  const allTranscripts = (p = lib) => p.eval(`import('${ext('src/transcription/transcript-repository.js')}').then(m => m.createTranscriptRepository().listIds())`);
  const panel = (p = lib) => p.eval(`(() => { const t = (id) => document.getElementById(id); return {
    badge: t('tr-badge').textContent, startVisible: !t('tr-start').hidden, startDisabled: t('tr-start-btn').disabled, warning: t('tr-start-warning').hidden ? '' : t('tr-start-warning').textContent,
    progress: !t('tr-progress').hidden, label: t('tr-progress-label').textContent, detail: t('tr-progress-detail').textContent,
    interrupted: !t('tr-interrupted').hidden, error: t('tr-error').hidden ? '' : t('tr-error-text').textContent, done: !t('tr-done').hidden,
    segments: document.querySelectorAll('.seg').length, message: t('message').hidden ? '' : t('message').textContent }; })()`);
  const openDetail = async (rid, p = lib) => {
    await p.eval(`location.hash = '#/recording/${rid}'; true`);
    await waitFor(async () => ((await p.eval(`document.getElementById('detail-title').textContent.length > 0 && document.getElementById('tr-badge').textContent.length > 0`)) ? true : null), 'detalle');
    await sleep(300);
  };
  const clickTranscribe = async (model = 'base', p = lib) => {
    await p.eval(`document.querySelector('input[name="tr-model"][value="${model}"]').checked = true; document.getElementById('tr-start-btn').click(); true`, { gesture: true });
    await sleep(500);
    const dialog = await p.eval(`document.getElementById('model-dialog').open`);
    if (dialog) await p.eval(`document.getElementById('model-dialog-confirm').click(); true`);
    return dialog;
  };
  const waitDone = (rid, timeout = 600000) => waitFor(async () => {
    const t = await transcriptOf(rid);
    return t && (t.status === 'completed' || t.status === 'error') ? t : null;
  }, 'transcripción terminada', timeout);

  // ---------------------------------------------------------------- 0
  log('0) Estado limpio');
  await lib.eval(`(async () => {
    const { createLibrary } = await import('${ext('src/library/library-service.js')}');
    const l = createLibrary();
    for (const r of await l.list()) await l.remove(r.id);
    return true;
  })()`);
  const cachedAtStart = await lib.eval(`caches.has('transformers-cache')`);
  log(`   modelo ya en caché del perfil: ${cachedAtStart ? 'sí' : 'no (se descargará)'}`);

  // ---------------------------------------------------------------- 1
  log(`1) Grabar ${SPEECH_MS / 1000} s de una pestaña con voz real en español → MP4`);
  await setSettings({ tabAudio: true, microphone: false, exportFormat: 'mp4', autoDownload: false });
  const speech = await record(SPEECH_MS);
  check(speech.kind === 'mp4' && !!speech.libraryId, `MP4 guardado en la biblioteca (${speech.libraryId.slice(0, 8)}…) — el pipeline MP4 sigue funcionando`);
  await sleep(1500);
  check((await allTranscripts()).length === 0, 'grabar NO inicia ninguna transcripción (opcional, solo a petición)');

  // ---------------------------------------------------------------- 2
  log('2) Biblioteca: estado «Pendiente» y transcripción con el modelo real');
  await openDetail(speech.libraryId);
  let p = await panel();
  check(p.badge === 'Pendiente' && p.startVisible && !p.startDisabled, `panel junto al vídeo: «${p.badge}», botón «Transcribir» activo`);
  const videoBefore = await lib.eval(`(async () => { const { createLibrary } = await import('${ext('src/library/library-service.js')}'); const { file } = await createLibrary().getVideo('${speech.libraryId}'); return file.size; })()`);
  const rssBase = chromeRssMb();
  // Sonda de fluidez: retraso máximo del bucle de eventos de la página durante el proceso.
  await lib.eval(`window.__lag = { max: 0, n: 0 }; window.__lagTimer = setInterval((() => { let last = performance.now(); return () => { const now = performance.now(); window.__lag.max = Math.max(window.__lag.max, now - last - 50); window.__lag.n++; last = now; }; })(), 50); true`);
  const t0 = Date.now();
  const dialogShown = await clickTranscribe('base');
  check(cachedAtStart ? !dialogShown : dialogShown, cachedAtStart ? 'modelo ya descargado: sin diálogo de descarga' : 'primera vez: diálogo de consentimiento antes de descargar el modelo (79 MB, «el audio nunca sale del equipo»)');
  const phases = new Set();
  let rssPeak = rssBase;
  let seenProgress = null;
  const done = await waitFor(async () => {
    const s = await panel();
    if (s.progress) phases.add(s.label);
    if (s.progress && /de \d/.test(s.detail)) seenProgress = s.detail;
    rssPeak = Math.max(rssPeak, chromeRssMb());
    const t = await transcriptOf(speech.libraryId);
    return t?.status === 'completed' || t?.status === 'error' ? t : null;
  }, 'transcripción completada', 600000);
  const elapsed = (Date.now() - t0) / 1000;
  const lag = await lib.eval(`(() => { clearInterval(window.__lagTimer); return window.__lag; })()`);
  check(done.status === 'completed', `completada en ${elapsed.toFixed(1)} s (incluye ${cachedAtStart ? 'carga' : 'descarga y carga'} del modelo) · fases: ${[...phases].join(' → ')}`);
  check(!!seenProgress, `progreso visible: «${seenProgress}»`);
  check(lag.max < 250, `interfaz fluida durante la transcripción: retraso máximo del hilo principal ${Math.round(lag.max)} ms (${lag.n} muestras)`);
  log(`   RAM Chrome (todos los procesos): base ${rssBase} MB → pico ${rssPeak} MB (+${rssPeak - rssBase} MB)`);

  const text = done.segments.map((s) => s.text).join(' ');
  log(`   texto: «${text.slice(0, 260)}…»`);
  check(/compositora/i.test(text) && /cantante/i.test(text) && /mexicana/i.test(text), 'contenido correcto: «compositora», «cantante», «mexicana» (voz real reconocida)');
  check(/[áéíóúñ]/i.test(text) && /[.,]/.test(text), 'conserva tildes/ñ y puntuación del español');
  const monotonic = done.segments.every((s, i) => s.end >= s.start && (i === 0 || s.start >= done.segments[i - 1].start));
  const lastEnd = done.segments.at(-1)?.end ?? 0;
  check(monotonic && lastEnd <= SPEECH_MS / 1000 + 3 && done.segments.some((s) => s.start >= 60), `${done.segments.length} segmentos con marcas de tiempo crecientes; hay texto después del primer bloque de 60 s (último fin ${lastEnd} s)`);
  check(done.recordingId === speech.libraryId && done.model === 'base' && /^[0-9a-f]{40}$/.test(done.modelRevision), 'asociada al id de la grabación, con modelo y revisión fijada');

  // ---------------------------------------------------------------- 3
  log('3) Ver junto al vídeo, saltar al instante, copiar y descargar .txt');
  p = await panel();
  check(p.badge === 'Completada' && p.done && p.segments === done.segments.length, `panel «Completada» con ${p.segments} fragmentos clicables`);
  const target = done.segments[Math.min(3, done.segments.length - 1)];
  const seek = await lib.eval(`(async () => {
    const v = document.getElementById('player'); v.muted = true;
    if (v.readyState < 1) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
    const b = document.querySelector('.seg[data-index="${done.segments.indexOf(target)}"]');
    b.click();
    await new Promise(r => setTimeout(r, 700));
    v.pause();
    return { t: v.currentTime, current: document.querySelector('.seg[aria-current="true"]')?.dataset.index };
  })()`, { gesture: true });
  check(Math.abs(seek.t - target.start) < 1.5, `clic en [${target.start} s] → el vídeo salta a ${seek.t.toFixed(2)} s; fragmento resaltado #${seek.current}`);

  await chrome.send('Browser.grantPermissions', { origin: `chrome-extension://${id}`, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
  await chrome.send('Emulation.setFocusEmulationEnabled', { enabled: true }, lib.sessionId).catch(() => {});
  await lib.eval(`document.getElementById('tr-timestamps').checked = false; document.getElementById('tr-copy').click(); true`, { gesture: true });
  await sleep(500);
  const clip = await lib.eval(`navigator.clipboard.readText().catch(e => 'ERR ' + e.message)`, { gesture: true });
  check(clip.includes('compositora') && !clip.includes('[0:00]'), `copiar (sin marcas): ${clip.length} caracteres en el portapapeles`);
  await lib.eval(`document.getElementById('tr-timestamps').checked = true; document.getElementById('tr-download').click(); true`, { gesture: true });
  const txtName = await waitFor(async () => readdirSync(downloads).find((f) => f.endsWith('.txt') && !f.endsWith('.crdownload')), '.txt descargado', 20000);
  await sleep(300);
  const txt = readFileSync(join(downloads, txtName), 'utf8');
  check(/transcripción\.txt$/.test(txtName) && txt.startsWith(speech.title) && txt.includes('[0:00]') && /[áéíóúñ]/.test(txt), `«${txtName}»: UTF-8, título + líneas «[m:ss] texto» con tildes (${txt.length} caracteres)`);

  // ---------------------------------------------------------------- 4
  log('4) Reabrir sin reprocesar; persiste tras reiniciar Chrome');
  lib = await chrome.open(ext(`src/library/library.html#/recording/${speech.libraryId}`));
  await waitFor(async () => ((await panel()).badge === 'Completada' ? true : null), 'completada al reabrir', 5000);
  check((await lib.eval(`document.querySelectorAll('.seg').length`)) === done.segments.length && (await lib.eval(`!document.getElementById('tr-progress').hidden`)) === false, 'pestaña nueva: texto al instante, sin procesar de nuevo');
  check((await lib.eval(`(location.hash = '#/', new Promise(r => setTimeout(r, 400))).then(() => document.querySelector('.card[data-id="${speech.libraryId}"] .card-badge').textContent)`)) === '📝 Transcrita', 'tarjeta de la lista: «📝 Transcrita»');
  await restart();
  popup = await chrome.open(ext('src/popup/popup.html'));
  page = await chrome.open(pageUrl);
  lib = await chrome.open(ext(`src/library/library.html#/recording/${speech.libraryId}`));
  await waitFor(async () => ((await panel()).badge === 'Completada' ? true : null), 'completada tras reiniciar', 8000);
  const afterRestart = await transcriptOf(speech.libraryId);
  check(afterRestart.segments.length === done.segments.length && afterRestart.updatedAt === done.updatedAt, 'tras reiniciar Chrome: misma transcripción, sin reprocesar (updatedAt intacto)');

  // ---------------------------------------------------------------- 5
  log('5) Duplicados: una sola transcripción a la vez (también entre pestañas)');
  await lib.eval(`document.getElementById('tr-redo').click(); true`);
  await clickTranscribe('base');
  const lib2 = await chrome.open(ext(`src/library/library.html#/recording/${speech.libraryId}`));
  await sleep(800);
  const p2 = await panel(lib2);
  const busy = await lib2.eval(`(async () => { const { createTranscriptionService } = await import('${ext('src/transcription/transcription-service.js')}');
    const { createLibrary } = await import('${ext('src/library/library-service.js')}');
    try { await createTranscriptionService({ library: createLibrary() }).start('${speech.libraryId}'); return 'arrancó'; } catch (e) { return e.name; } })()`);
  check(p2.badge === 'Procesando' && /otra pestaña/.test(p2.label) && busy === 'BusyError', `segunda pestaña: «${p2.label}»; intentar otra → ${busy}`);
  await chrome.send('Target.closeTarget', { targetId: lib2.targetId });

  // ---------------------------------------------------------------- 6
  log('6) Cancelar a mitad sin dañar el vídeo');
  await waitFor(async () => ((await panel()).label === 'Transcribiendo…' ? true : null), 'transcribiendo', 120000);
  await sleep(1500);
  await lib.eval(`document.getElementById('tr-cancel').click(); true`);
  await waitFor(async () => ((await panel()).badge === 'Pendiente' ? true : null), 'pendiente tras cancelar', 10000);
  p = await panel();
  const videoAfter = await lib.eval(`(async () => { const { createLibrary } = await import('${ext('src/library/library-service.js')}'); const { file } = await createLibrary().getVideo('${speech.libraryId}'); return file.size; })()`);
  const plays = await lib.eval(`(async () => { const v = document.getElementById('player'); v.muted = true; v.currentTime = 1; await v.play(); await new Promise(r => setTimeout(r, 600)); v.pause(); return v.currentTime > 1.2; })()`, { gesture: true });
  check(p.startVisible && (await transcriptOf(speech.libraryId)) === null && /cancelada/.test(p.message), `cancelada → «Pendiente», sin datos parciales; aviso «${p.message}»`);
  check(videoAfter === videoBefore && plays, `vídeo intacto (${(videoAfter / 1e6).toFixed(2)} MB, mismo tamaño) y se reproduce`);
  check((await lib.eval(`(async () => (await navigator.locks.query()).held.length)()`)) === 0, 'sin locks colgados tras cancelar');

  // ---------------------------------------------------------------- 7
  log('7) Recuperación: Chrome se cierra a mitad → «Interrumpida» → Reanudar');
  await clickTranscribe('base');
  const partial = await waitFor(async () => {
    const t = await transcriptOf(speech.libraryId);
    return t?.processedMs >= 50_000 && t.status === 'processing' ? t : null;
  }, 'primer bloque guardado', 300000);
  await restart({ kill: true });
  popup = await chrome.open(ext('src/popup/popup.html'));
  page = await chrome.open(pageUrl);
  lib = await chrome.open(ext(`src/library/library.html#/recording/${speech.libraryId}`));
  await waitFor(async () => ((await panel()).interrupted ? true : null), 'interrumpida', 8000);
  p = await panel();
  const saved = await transcriptOf(speech.libraryId);
  check(p.badge === 'Interrumpida' && saved.segments.length === partial.segments.length && p.segments === saved.segments.length, `tras el cierre forzado: «Interrumpida» con ${saved.segments.length} fragmentos ya guardados (${Math.round(saved.processedMs / 1000)} s)`);
  await lib.eval(`document.getElementById('tr-resume').click(); true`, { gesture: true });
  const resumed = await waitDone(speech.libraryId);
  const texts = resumed.segments.map((s) => s.text);
  check(resumed.status === 'completed' && resumed.segments.slice(0, saved.segments.length).every((s, i) => s.text === saved.segments[i].text), `reanudada desde ${Math.round(saved.processedMs / 1000)} s y completada (${resumed.segments.length} fragmentos; conserva los anteriores)`);
  check(texts.every((t, i) => i === 0 || t !== texts[i - 1]), 'sin fragmentos duplicados en la unión');

  // ---------------------------------------------------------------- 8
  log('8) Grabación sin audio');
  await setSettings({ tabAudio: false, microphone: false, exportFormat: 'webm', autoDownload: false });
  const silent = await record(4000, { speech: false });
  await openDetail(silent.libraryId);
  p = await panel();
  check(p.startDisabled && /sin audio/.test(p.warning), `UI: «${p.warning}» (botón desactivado)`);
  const forced = await lib.eval(`(async () => { const { createTranscriptionService } = await import('${ext('src/transcription/transcription-service.js')}');
    const { createLibrary } = await import('${ext('src/library/library-service.js')}');
    await createTranscriptionService({ library: createLibrary() }).start('${silent.libraryId}'); return true; })()`);
  const silentResult = await waitDone(silent.libraryId, 60000);
  check(forced && silentResult.status === 'error' && silentResult.error.code === 'no-audio', `forzando el motor igualmente: error «${silentResult.error?.message}» sin cargar el modelo`);

  // ---------------------------------------------------------------- 9
  log('9) Eliminar: con transcripción completada y durante una transcripción');
  await setSettings({ tabAudio: true, microphone: false, exportFormat: 'mp4', autoDownload: false });
  const short = await record(20_000);
  lib = await chrome.open(ext(`src/library/library.html#/recording/${short.libraryId}`));
  await sleep(800);
  await clickTranscribe('base');
  await waitFor(async () => ((await panel()).progress ? true : null), 'procesando', 30000);
  await lib.eval(`document.getElementById('detail-delete').click(); document.getElementById('delete-confirm').click(); true`);
  await waitFor(async () => ((await lib.eval(`location.hash`)) === '#/' ? true : null), 'vuelta a la lista', 10000);
  await sleep(1500);
  const opfsIds = await lib.eval(`(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('library'); const ids = []; for await (const [n] of d.entries()) ids.push(n); return ids; })()`);
  check((await transcriptOf(short.libraryId)) === null && !opfsIds.includes(short.libraryId) && (await lib.eval(`(async () => (await navigator.locks.query()).held.length)()`)) === 0,
    'eliminada durante la transcripción: trabajo cancelado, sin transcripción, sin archivos, sin locks');
  await lib.eval(`document.querySelector('.card[data-id="${speech.libraryId}"] [data-action="delete"]').click(); document.getElementById('delete-confirm').click(); true`);
  await sleep(1500);
  check((await transcriptOf(speech.libraryId)) === null, 'eliminar una grabación transcrita borra su transcripción');

  // ---------------------------------------------------------------- 10
  log('10) Grabaciones antiguas y migración IndexedDB real v2 → v3');
  p = await lib.eval(`(location.hash = '#/recording/${silent.libraryId}', new Promise(r => setTimeout(r, 600))).then(() => document.getElementById('tr-badge').textContent)`);
  check(p === 'Error' || p === 'Pendiente', `grabación sin transcripción conserva su estado (${p}); ninguna se procesa sola`);
  const migration = await lib.eval(`(async () => {
    const name = 'e2e-migracion-v2';
    indexedDB.deleteDatabase(name);
    await new Promise((resolve, reject) => { const r = indexedDB.open(name, 2); r.onupgradeneeded = () => { const db = r.result;
      db.createObjectStore('recordings', { keyPath: 'id' }); db.createObjectStore('chunks', { keyPath: ['recordingId', 'seq'] });
      const lib = db.createObjectStore('library', { keyPath: 'id' }); lib.createIndex('createdAt', 'createdAt'); lib.put({ id: 'fase5', title: 'Grabación de la fase 5', createdAt: 1 }); };
      r.onsuccess = () => { r.result.close(); resolve(); }; r.onerror = () => reject(r.error); });
    const { openDatabase } = await import('${ext('src/shared/database.js')}');
    const db = await openDatabase(indexedDB, { name });
    const kept = await new Promise(r => { const q = db.transaction('library').objectStore('library').get('fase5'); q.onsuccess = () => r(q.result); });
    const out = { version: db.version, stores: [...db.objectStoreNames].sort(), kept: kept?.title };
    db.close(); indexedDB.deleteDatabase(name);
    return out;
  })()`);
  check(migration.version === 3 && migration.stores.includes('transcripts') && migration.kept === 'Grabación de la fase 5', `Chrome real: v2 → v${migration.version}, almacenes ${migration.stores.join(', ')}; datos de la fase 5 intactos`);

  exitCode = failures ? 1 : 0;
  log(exitCode ? `FALLÓ (${failures})` : 'OK');
} catch (error) {
  console.error('[e2e-transcription] ERROR', error.stack ?? error.message);
} finally {
  chrome?.proc.kill('SIGKILL');
  server.close();
  await sleep(500);
  if (fresh) rmSync(profile, { recursive: true, force: true });
  process.exit(exitCode);
}
