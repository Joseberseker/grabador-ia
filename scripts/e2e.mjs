#!/usr/bin/env node
/**
 * Pruebas de extremo a extremo en Chrome real (headless), sin dependencias.
 *
 * Escenarios (numeración de los requisitos de la fase 3):
 *   A. Vídeo solo, 720p           → 1, 10, 11, 12, duración + seek
 *   B. Vídeo + audio de pestaña   → 2, atajos, PiP
 *   C. Permiso de micrófono       → 5 (página de permiso: denegado / concedido)
 *   D. Vídeo + micrófono          → 3, 7, 8, cuenta regresiva, indicador de nivel
 *   E. Pestaña + micrófono, 1080p60 máxima → 4, 13, 14 (sin escalar hacia arriba)
 *   F. Micrófono activado pero denegado → 5 (se graba sin micrófono)
 *   G. Cancelar la cuenta regresiva
 *   H. Pestaña sin audio + «Dejar de compartir» → 6
 *   I. Cancelar el selector       → 9
 *
 * Uso: npm run e2e   (requiere google-chrome >= 137; CHROME_BIN para otro binario)
 * - --remote-debugging-pipe + Extensions.loadUnpacked: Chrome de marca ya no admite --load-extension.
 * - --auto-select-tab-capture-source-by-title: elige la pestaña de prueba en el selector.
 * - --use-fake-device-for-media-stream: micrófono falso de Chrome (emite pitidos).
 * - Browser.setPermission: concede o deniega el micrófono sin interacción.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectWebm } from '../src/recording/webm-duration.js';
import { targetSize } from '../src/recording/video-quality.js';
import { h264CodecString } from '../src/conversion/conversion-plan.js';
import * as MB from 'mediabunny';

// Se prueba el PAQUETE (dist/, generado por `npm run build`), no el árbol de desarrollo:
// así se detecta cualquier archivo que falte en el build. EXTENSION_DIR permite otro directorio.
const EXT = resolve(process.env.EXTENSION_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error(`No hay extensión en ${EXT}: ejecuta «npm run build» (o usa EXTENSION_DIR).`);
  process.exit(1);
}
const TITLE = 'PaginaDePrueba';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);

const profile = mkdtempSync(join(tmpdir(), 'screen-recorder-e2e-'));
const downloads = join(profile, 'Descargas');
mkdirSync(join(profile, 'Default'), { recursive: true });
mkdirSync(downloads);
writeFileSync(
  join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }),
);

const chrome = spawn(
  process.env.CHROME_BIN || 'google-chrome',
  [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--auto-select-tab-capture-source-by-title=${TITLE}`,
    '--use-fake-device-for-media-stream',
    '--screen-info={1920x1200}', // pantalla headless donde cabe una pestaña mayor que 720p
    '--autoplay-policy=no-user-gesture-required', // solo para el tono de la página de prueba
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
);
let stderr = '';
chrome.stderr.on('data', (d) => (stderr += d));

// --- Cliente CDP mínimo sobre el pipe ---------------------------------------
let nextId = 0;
let buffer = '';
const pending = new Map();
const consoleErrors = [];
const watched = new Set();
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { ok, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    } else if (watched.has(msg.sessionId) && msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleErrors.push(`EXCEPTION ${d.exception?.description ?? d.text}`);
    } else if (watched.has(msg.sessionId) && msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(`console.error ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
  }
});
function send(method, params = {}, sessionId) {
  const id = ++nextId;
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + '\0');
  return new Promise((ok, reject) => pending.set(id, { ok, reject }));
}
async function attach(targetId, { watch = true } = {}) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  if (watch) watched.add(sessionId);
  await send('Runtime.enable', {}, sessionId);
  return {
    targetId,
    sessionId,
    async eval(expression, { gesture = false } = {}) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
  };
}
const targets = async () => (await send('Target.getTargets')).targetInfos;
const findTarget = async (fragment) => (await targets()).find((t) => t.url.includes(fragment));
async function waitFor(fn, label, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timeout esperando: ${label}`);
}

let failures = 0;
function check(cond, label) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures += 1;
}

// Página capturada: animación + tono de 440 Hz activable.
const testPage =
  `data:text/html,<title>${TITLE}</title><body style="margin:0"><canvas id=c width=640 height=360></canvas><script>` +
  // requestAnimationFrame: el contenido cambia a 60 Hz (Chrome solo captura fotogramas cuando hay cambios).
  `const x=c.getContext('2d');let i=0;const f=()=>{x.fillStyle='hsl('+(i++*7%25360)+',80%25,50%25)';x.fillRect(0,0,640,360);requestAnimationFrame(f)};f();` +
  `let osc=null;window.tone=(on)=>{if(on&&!osc){const a=new AudioContext();osc=a.createOscillator();const g=a.createGain();g.gain.value=0.3;osc.connect(g).connect(a.destination);osc.start();}` +
  `if(!on&&osc){osc.stop();osc=null;}return !!osc;};</script>`;

let exitCode = 1;
try {
  const { id: extId } = await send('Extensions.loadUnpacked', { path: EXT });
  const origin = `chrome-extension://${extId}`;
  log('Extensión cargada:', extId);
  await waitFor(async () => (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(extId)), 'service worker');

  const ext = (path) => `${origin}/${path}`;
  const openPage = async (url, opts) => {
    const { targetId } = await send('Target.createTarget', { url });
    await sleep(600);
    return attach(targetId, opts);
  };
  let pageId = (await send('Target.createTarget', { url: testPage })).targetId;
  let testTab = await attach(pageId, { watch: false });
  // Ventana de la pestaña capturada de 1600×1000 (mayor que 720p) para probar la reducción real.
  const { windowId } = await send('Browser.getWindowForTarget', { targetId: pageId });
  await send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1600, height: 1000 } });
  const popup = await openPage(ext('src/popup/popup.html'));
  const analyzer = await openPage('about:blank', { watch: false });

  const state = () => popup.eval(`chrome.storage.session.get('recordingState').then(r => r.recordingState ?? {status:'idle'})`);
  const waitStatus = (s, t) => waitFor(async () => ((await state()).status === s ? true : null), `estado ${s}`, t);
  const text = (s, role) => s.eval(`document.querySelector('[data-role="${role}"]').textContent`);
  const click = (s, role) => s.eval(`document.querySelector('[data-role="${role}"]').click()`, { gesture: true });
  const command = (type) => popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: '${type}' })`);
  const badge = () => popup.eval(`chrome.action.getBadgeText({})`);
  const hasOffscreen = async () => !!(await findTarget('/src/offscreen/offscreen.html'));
  const files = () => readdirSync(downloads).filter((f) => f.endsWith('.webm'));
  const idb = () => popup.eval(`import('${ext('src/recording/chunk-store.js')}').then(m => m.storageSummary())`);
  // Los escenarios A–I (fase 3) usan WebM; los M (fase 4B) piden MP4 explícitamente.
  const setSettings = (patch) =>
    popup.eval(`chrome.storage.local.set({ settings: Object.assign({ micEnabled: false, tabAudio: true, resolution: 'auto', fps: 30, quality: 'auto', countdown: 0, exportFormat: 'webm' }, ${JSON.stringify(patch)}) })`);
  const mp4Files = () => readdirSync(downloads).filter((f) => f.endsWith('.mp4'));
  const opfsTemp = () => popup.eval(`import('${ext('src/conversion/temp-files.js')}').then(m => m.listTempFiles())`);

  /** Analiza un MP4 descargado: cajas, códecs y paquetes (Node) + reproducción y audio (Chrome). */
  async function analyzeMp4(fileName) {
    const bytes = readFileSync(join(downloads, fileName));
    const boxes = [];
    for (let pos = 0; pos < bytes.length && boxes.length < 50;) {
      let size = bytes.readUInt32BE(pos);
      if (size === 1) size = Number(bytes.readBigUInt64BE(pos + 8));
      boxes.push(bytes.toString('latin1', pos + 4, pos + 8));
      if (size < 8) break;
      pos += size;
    }
    const input = new MB.Input({ source: new MB.BufferSource(bytes), formats: MB.ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const videoStats = await video.computePacketStats();
    const played = await analyzer.eval(`(async () => {
      const bin = Uint8Array.from(atob('${bytes.toString('base64')}'), c => c.charCodeAt(0));
      const v = document.createElement('video'); v.muted = true;
      v.src = URL.createObjectURL(new Blob([bin], { type: 'video/mp4' }));
      await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error('MP4 no reproducible')); });
      const duration = v.duration;
      v.currentTime = duration * 0.6;
      const seeked = await new Promise(r => { v.onseeked = () => r(true); setTimeout(() => r(false), 4000); });
      let rms = null;
      try {
        const buf = await new OfflineAudioContext(1, 48000, 48000).decodeAudioData(bin.buffer.slice(0));
        const d = buf.getChannelData(0); rms = 0;
        for (let i = 0; i < d.length; i += 4800) { let s = 0; const e = Math.min(i + 4800, d.length); for (let k = i; k < e; k++) s += d[k] * d[k]; rms = Math.max(rms, Math.sqrt(s / (e - i))); }
      } catch { rms = null; }
      return { duration, seeked, width: v.videoWidth, height: v.videoHeight, rms };
    })()`);
    return {
      boxes: boxes.join(' '),
      faststart: boxes.indexOf('moov') !== -1 && boxes.indexOf('moov') < boxes.indexOf('mdat'),
      videoCodec: video.codec,
      audioCodec: audio?.codec ?? null,
      videoPackets: videoStats.packetCount,
      fps: videoStats.averagePacketRate,
      ...played,
    };
  }

  /** CPU (s) consumida por los procesos de extensión de este Chrome durante `ms`. */
  async function extensionCpuSeconds(ms) {
    const sample = () => {
      let ticks = 0;
      const stack = [chrome.pid];
      const children = new Map();
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const st = readFileSync(`/proc/${name}/stat`, 'utf8');
          const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
          if (!children.has(ppid)) children.set(ppid, []);
          children.get(ppid).push(Number(name));
        } catch { /* terminado */ }
      }
      while (stack.length) {
        const pid = stack.pop();
        stack.push(...(children.get(pid) ?? []));
        try {
          if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--extension-process')) continue;
          const f = readFileSync(`/proc/${pid}/stat`, 'utf8');
          const fields = f.slice(f.lastIndexOf(')') + 2).split(' ');
          ticks += Number(fields[11]) + Number(fields[12]);
        } catch { /* terminado */ }
      }
      return ticks / 100;
    };
    const a = sample();
    await sleep(ms);
    return sample() - a;
  }

  /** Graba unos segundos y detiene; devuelve el estado justo después de detener. */
  async function recordFor(ms) {
    await click(popup, 'start');
    await waitStatus('recording');
    await sleep(ms);
    await command('STOP');
  }
  const setMicPermission = (setting) =>
    send('Browser.setPermission', { permission: { name: 'microphone' }, setting, origin });
  const controller = async () => attach((await waitFor(() => findTarget('/src/controller/controller.html'), 'controlador')).targetId);

  /** Analiza el WebM descargado: cabecera, duración/seek en Chrome y audio decodificado. */
  async function analyze(fileName) {
    const bytes = readFileSync(join(downloads, fileName));
    const header = inspectWebm(new Uint8Array(bytes));
    const audioTracks = header.tracks.filter((t) => t.type === 'audio').length;
    const played = await analyzer.eval(`(async () => {
      const bin = Uint8Array.from(atob('${bytes.toString('base64')}'), c => c.charCodeAt(0));
      const v = document.createElement('video'); v.muted = true;
      v.src = URL.createObjectURL(new Blob([bin], { type: 'video/webm' }));
      await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error('no se pudo cargar el vídeo')); });
      const duration = v.duration;
      let seeked = false;
      if (Number.isFinite(duration)) {
        v.currentTime = duration / 2;
        seeked = await new Promise(r => { v.onseeked = () => r(true); setTimeout(() => r(false), 4000); });
      }
      let rms = null;
      if (${audioTracks} > 0) {
        const buf = await new OfflineAudioContext(1, 48000, 48000).decodeAudioData(bin.buffer.slice(0));
        const d = buf.getChannelData(0); rms = 0;
        for (let i = 0; i < d.length; i += 4800) {
          let s = 0; const end = Math.min(i + 4800, d.length);
          for (let k = i; k < end; k++) s += d[k] * d[k];
          rms = Math.max(rms, Math.sqrt(s / (end - i)));
        }
      }
      return { duration, seeked, currentTime: v.currentTime, rms };
    })()`);
    return { header, audioTracks, ...played, size: bytes.length };
  }

  async function finishAndAnalyze(label) {
    await waitStatus('finished', 25000);
    const s = await state();
    const f = s.lastRecording;
    check(files().includes(f.fileName), `${label}: descargado ${f.fileName} (${(f.size / 1024).toFixed(0)} KB)`);
    await waitFor(async () => !(await hasOffscreen()), 'cierre del offscreen');
    const summary = await idb();
    check(summary.recordings === 0 && summary.chunks === 0, `${label}: IndexedDB limpio tras descargar (${JSON.stringify(summary)})`);
    const a = await analyze(f.fileName);
    check(Math.abs(a.header.durationMs - f.durationMs) < 1, `${label}: Duration en la cabecera = ${(a.header.durationMs / 1000).toFixed(2)} s`);
    check(Number.isFinite(a.duration) && Math.abs(a.duration * 1000 - f.durationMs) < 700 && a.seeked,
      `${label}: Chrome lee duración ${a.duration.toFixed(2)} s y hace seek a ${a.currentTime.toFixed(2)} s`);
    return { state: s, analysis: a };
  }

  // ---------------------------------------------------------------- A
  log('A) Vídeo solo · 720p · calidad alta (1, 10, 11, 12)');
  await setSettings({ tabAudio: false, resolution: '720p', quality: 'high' });
  await click(popup, 'start');
  await waitStatus('recording');
  let s = await state();
  check(s.audio?.plan === 'none' && s.audio.tab === 'off' && s.audio.mic === 'off', `1. vídeo sin audio: ${JSON.stringify(s.audio)}`);
  const box720 = targetSize('720p', s.video.native);
  check(Math.abs(s.video.width - box720.width) <= 2 && Math.abs(s.video.height - box720.height) <= 2 && s.video.height <= 720,
    `720p sobre una pestaña de ${s.video.native.width}×${s.video.native.height} (medida) → ${s.video.width}×${s.video.height} · ${s.video.frameRate} fps (reducido, proporción conservada)`);
  check(/^[0-9a-f-]{36}$/.test(s.recordingId), `identificador único de grabación ${s.recordingId.slice(0, 8)}…`);
  await sleep(1500);
  const c1 = await idb();
  await sleep(1500);
  const c2 = await idb();
  check(c1.recordings === 1 && c1.chunks >= 1 && c2.chunks > c1.chunks, `11. fragmentos guardados progresivamente en IndexedDB (${c1.chunks} → ${c2.chunks})`);
  const ctrlA = await waitFor(() => findTarget('/src/controller/controller.html'), 'controlador');
  await send('Target.closeTarget', { targetId: ctrlA.targetId });
  await sleep(500);
  check((await command('SYNC')).data.status === 'recording' && (await hasOffscreen()), '10. cerrar el controlador no detiene la grabación');
  await command('STOP');
  const A = await finishAndAnalyze('A');
  check(A.analysis.audioTracks === 0, '1. el archivo no tiene pista de audio');

  // ---------------------------------------------------------------- B
  log('B) Vídeo + audio de pestaña (2) · atajos · PiP');
  await testTab.eval('tone(true)');
  await setSettings({ tabAudio: true });
  await command('TOGGLE_RECORDING');
  await waitStatus('recording');
  s = await state();
  check(s.audio?.tab === 'on' && s.audio.plan === 'tab', `2. audio de pestaña: ${JSON.stringify(s.audio)}`);
  const ctrlB = await controller();
  await waitFor(async () => ((await text(ctrlB, 'tab-status')) === '● ON' ? true : null), 'fila audio pestaña');
  check((await text(ctrlB, 'mic-status')) === '○ OFF', 'controlador: 🎙️ Micrófono ○ OFF · 🔊 Audio pestaña ● ON');
  await sleep(1500);
  await command('TOGGLE_PAUSE');
  await waitStatus('paused');
  const pip = await ctrlB
    .eval(`document.getElementById('pip-btn').click(), new Promise(r => setTimeout(() => r(!!window.documentPictureInPicture?.window?.document.getElementById('widget')), 1000))`, { gesture: true })
    .catch(() => false);
  check(pip, 'Picture-in-Picture: el controlador se mueve a la ventana flotante');
  if (pip) await ctrlB.eval('window.documentPictureInPicture.window.close()');
  await command('TOGGLE_PAUSE');
  await waitStatus('recording');
  await sleep(1500);
  await command('TOGGLE_RECORDING');
  const B = await finishAndAnalyze('B');
  check(B.analysis.audioTracks === 1 && B.analysis.rms > 0.02, `2. pista de audio con el tono de la pestaña (RMS ${B.analysis.rms?.toFixed(3)})`);
  await testTab.eval('tone(false)');

  // ---------------------------------------------------------------- C
  log('C) Permiso de micrófono (5)');
  await setMicPermission('denied');
  let p = await openPage(ext('src/popup/popup.html'));
  check((await p.eval(`document.getElementById('mic-toggle').getAttribute('aria-checked')`)) === 'false', 'micrófono OFF por defecto');
  await p.eval(`document.getElementById('mic-toggle').click()`, { gesture: true }).catch(() => {});
  const permT = await waitFor(() => findTarget('/src/permission/permission.html'), 'página de permiso');
  const perm = await attach(permT.targetId);
  const permMsg = await waitFor(async () => {
    const m = await perm.eval(`document.getElementById('message').textContent`);
    return /bloquead|concedi/.test(m) ? m : null;
  }, 'respuesta de la página de permiso');
  const afterDeny = await popup.eval(`chrome.storage.local.get('settings').then(r => r.settings.micEnabled)`);
  check(/bloqueado/.test(permMsg) && afterDeny === false, `5. permiso denegado → mensaje claro y micrófono sigue OFF («${permMsg.slice(0, 60)}…»)`);
  await send('Target.closeTarget', { targetId: permT.targetId });
  await send('Target.closeTarget', { targetId: p.targetId }).catch(() => {});

  await setMicPermission('granted');
  p = await openPage(ext('src/popup/popup.html'));
  await p.eval(`document.getElementById('mic-toggle').click()`, { gesture: true });
  await waitFor(async () => (await popup.eval(`chrome.storage.local.get('settings').then(r => r.settings.micEnabled)`)) === true, 'micEnabled');
  check((await p.eval(`document.getElementById('mic-toggle').getAttribute('aria-checked')`)) === 'true', 'permiso concedido → 🎙️ Micrófono ON');
  await send('Target.closeTarget', { targetId: p.targetId });

  // ---------------------------------------------------------------- D
  log('D) Vídeo + micrófono · cuenta regresiva · pausa · detener en pausa (3, 7, 8)');
  await setSettings({ tabAudio: false, micEnabled: true, countdown: 3 });
  const tStart = Date.now();
  await click(popup, 'start');
  await waitStatus('countdown');
  const ctrlD = await controller();
  const cdText = await waitFor(async () => {
    const t = await text(ctrlD, 'timer');
    return /^[123]$/.test(t) ? t : null;
  }, 'número de cuenta regresiva');
  const cdBadge = await badge();
  check(/^[123]$/.test(cdText) && /^[123]$/.test(cdBadge), `cuenta regresiva visible: controlador «${cdText}», badge «${cdBadge}»`);
  check((await idb()).chunks === 0, 'durante la cuenta regresiva no se graba nada');
  await waitStatus('recording', 8000);
  const cdMs = Date.now() - tStart;
  check(cdMs >= 2800, `la grabación empieza tras la cuenta regresiva (${(cdMs / 1000).toFixed(1)} s)`);
  s = await state();
  check(s.audio?.mic === 'on' && s.audio.tab === 'off' && s.audio.plan === 'mic', `3. micrófono: ${JSON.stringify(s.audio)}`);
  const levels = [];
  for (let i = 0; i < 20; i++) {
    levels.push(await ctrlD.eval(`parseFloat(document.querySelector('[data-role="meter-fill"]').style.width) || 0`));
    await sleep(100);
  }
  check(!(await ctrlD.eval(`document.querySelector('[data-role="meter"]').hidden`)) && Math.max(...levels) > 0,
    `indicador de nivel del micrófono activo (máx ${Math.max(...levels)}%)`);
  await click(ctrlD, 'pause');
  await waitStatus('paused');
  const frozen = await text(ctrlD, 'timer');
  await sleep(1500);
  check((await text(ctrlD, 'timer')) === frozen, `7. pausa con micrófono: temporizador congelado en ${frozen}`);
  await click(ctrlD, 'resume');
  await waitStatus('recording');
  await sleep(1200);
  await click(ctrlD, 'pause');
  await waitStatus('paused');
  await click(ctrlD, 'stop'); // 8. detener estando en pausa
  const D = await finishAndAnalyze('D');
  check(D.analysis.audioTracks === 1 && D.analysis.rms > 0.005, `3/8. pista de micrófono con señal tras detener en pausa (RMS ${D.analysis.rms?.toFixed(3)})`);

  // ---------------------------------------------------------------- E
  log('E) Pestaña + micrófono · 1080p · 60 fps · máxima (4, 13, 14)');
  await testTab.eval('tone(true)');
  await setSettings({ tabAudio: true, micEnabled: true, resolution: '1080p', fps: 60, quality: 'max' });
  await click(popup, 'start');
  await waitStatus('recording');
  s = await state();
  check(s.audio?.plan === 'mix' && s.audio.tab === 'on' && s.audio.mic === 'on', `4. mezcla pestaña + micrófono: ${JSON.stringify(s.audio)}`);
  const viewportE = await testTab.eval('[innerWidth, innerHeight]');
  check(s.video.width <= viewportE[0] && s.video.height <= viewportE[1],
    `13. 1080p pedido sobre una pestaña de ${viewportE.join('×')} (medida ${s.video.native.width}×${s.video.native.height}) → ${s.video.width}×${s.video.height} (sin ampliar)`);
  check([30, 60].includes(s.video.frameRate), `14. FPS efectivos ${s.video.frameRate} (pedidos 60; applied=${s.video.applied})`);
  await sleep(2500);
  await command('STOP');
  const E = await finishAndAnalyze('E');
  check(E.analysis.audioTracks === 1 && E.analysis.rms > 0.02, `4. una sola pista de audio mezclada con señal (RMS ${E.analysis.rms?.toFixed(3)})`);
  await testTab.eval('tone(false)');

  // ---------------------------------------------------------------- F
  log('F) Micrófono activado pero permiso denegado (5)');
  await setMicPermission('denied');
  await setSettings({ tabAudio: true, micEnabled: true });
  await click(popup, 'start');
  await waitStatus('recording');
  s = await state();
  check(s.audio?.mic === 'error' && s.audio.plan === 'tab', `5. se graba sin micrófono: ${JSON.stringify(s.audio)}`);
  check(/Micrófono no disponible/.test(s.notice?.message ?? ''), `mensaje: «${s.notice?.message}»`);
  const ctrlF = await controller();
  await waitFor(async () => ((await text(ctrlF, 'mic-status')) === '⚠ Sin acceso' ? true : null), 'estado del micro en el controlador');
  check(true, 'controlador: 🎙️ Micrófono ⚠ Sin acceso');
  await sleep(1500);
  await command('STOP');
  await finishAndAnalyze('F');
  await setMicPermission('granted');

  // ---------------------------------------------------------------- G
  log('G) Cancelar durante la cuenta regresiva');
  const before = files().length;
  await setSettings({ countdown: 3 });
  await click(popup, 'start');
  await waitStatus('countdown');
  await click(popup, 'cancel');
  await waitStatus('idle');
  s = await state();
  check(/Cuenta regresiva cancelada/.test(s.notice?.message ?? ''), `vuelve a LISTO: «${s.notice?.message}»`);
  check(!(await hasOffscreen()) && files().length === before && (await idb()).chunks === 0, 'sin offscreen, sin archivo y sin datos en IndexedDB');

  // ---------------------------------------------------------------- M1
  log('M1) MP4: vídeo + audio de pestaña (1, 3, 4, 5, 8, 9, 10, 12, 13)');
  // Temporal huérfano de una conversión «interrumpida»: debe desaparecer.
  await popup.eval(`navigator.storage.getDirectory()
    .then(r => r.getDirectoryHandle('conversion-temp', { create: true }))
    .then(d => d.getFileHandle('huerfano-interrumpido.mp4', { create: true }))
    .then(h => h.createWritable()).then(w => w.write(new Uint8Array(1024 * 1024)).then(() => w.close()))`);
  check((await opfsTemp()).some((f) => f.name === 'huerfano-interrumpido.mp4'), '9. temporal huérfano preparado en OPFS');
  await testTab.eval('tone(true)');
  await setSettings({ exportFormat: 'mp4', tabAudio: true });
  // Registra cada transición de estado (más fiable que sondear: la conversión de 4 s es muy rápida).
  await popup.eval(`window.__exportLog = []; chrome.storage.onChanged.addListener((c, a) => {
    const v = a === 'session' && c.recordingState?.newValue;
    if (v && v.status === 'exporting') window.__exportLog.push({ phase: v.export?.phase, progress: v.export?.progress });
  }); true`);
  await recordFor(4000);
  await waitStatus('finished', 60000);
  const exportLog = await popup.eval('window.__exportLog');
  const phases = [...new Set(exportLog.map((e) => e.phase))];
  const progresses = exportLog.map((e) => e.progress).filter((p) => p != null);
  s = await state();
  check(['preparing', 'converting', 'finalizing', 'downloading'].every((p) => phases.includes(p)), `10. fases: ${phases.join(' → ')}`);
  check(progresses.length >= 1 && progresses.every((p, i) => i === 0 || p >= progresses[i - 1]), `10. progreso creciente (${progresses.map((p) => Math.round(p * 100) + '%').join(', ')})`);
  check(s.lastRecording?.kind === 'mp4' && mp4Files().includes(s.lastRecording.fileName), `1. descargado ${s.lastRecording?.fileName}`);
  const st1 = s.export?.stats;
  const m1 = await analyzeMp4(s.lastRecording.fileName);
  check(m1.videoCodec === 'avc' && m1.audioCodec === 'aac', `3. códecs: ${m1.videoCodec} + ${m1.audioCodec} (AAC ${st1?.aacBackend})`);
  check(m1.faststart, `MP4 con moov al principio: ${m1.boxes}`);
  check(m1.videoPackets === st1?.inputVideoFrames, `12. fotogramas: entrada ${st1?.inputVideoFrames} → salida ${m1.videoPackets} (${m1.fps.toFixed(1)} fps)`);
  check(Number.isFinite(m1.duration) && Math.abs(m1.duration - st1.durationS) < 0.15, `4. duración ${m1.duration.toFixed(2)} s (entrada ${st1.durationS.toFixed(2)} s)`);
  check(m1.seeked, '5. seek correcto en Chrome');
  check(m1.rms > 0.02, `3. audio AAC decodificable con señal (RMS ${m1.rms?.toFixed(3)})`);
  check(m1.width === st1.width && m1.height === st1.height, `13. resolución conservada: WebM ${st1.width}×${st1.height} → MP4 ${m1.width}×${m1.height}`);
  const tempAfter = await opfsTemp();
  check(tempAfter.length === 0, `8/9. OPFS limpio tras descargar (huérfano incluido): ${JSON.stringify(tempAfter)}`);
  check((await idb()).chunks === 0 && !(await hasOffscreen()), 'IndexedDB vacío y offscreen cerrado');
  check((await text(popup, 'status-label')) === 'FINALIZADO', '✓ FINALIZADO con MP4');

  // ---------------------------------------------------------------- M2
  log('M2) MP4: vídeo sin audio (2)');
  await setSettings({ exportFormat: 'mp4', tabAudio: false });
  await recordFor(2500);
  await waitStatus('finished', 60000);
  s = await state();
  const m2 = await analyzeMp4(s.lastRecording.fileName);
  check(m2.videoCodec === 'avc' && m2.audioCodec === null, `2. solo vídeo H.264 (audio: ${m2.audioCodec})`);
  check(m2.videoPackets === s.export.stats.inputVideoFrames && m2.seeked, `12. ${s.export.stats.inputVideoFrames} → ${m2.videoPackets} fotogramas, seek ✓`);

  // ---------------------------------------------------------------- M3
  log('M3) MP4: cancelar a mitad → reintentar (6, 8, 10)');
  await testTab.eval('tone(true)');
  await setSettings({ exportFormat: 'mp4', tabAudio: true, quality: 'max' });
  await recordFor(9000);
  const cancelProgress = await waitFor(async () => {
    const st = await state();
    return st.status === 'exporting' && st.export?.phase === 'converting' && st.export.progress >= 0.05 ? st.export.progress : null;
  }, 'conversión en marcha', 30000);
  const ctrlM = await controller();
  await click(ctrlM, 'cancel-export');
  await waitStatus('export-failed', 15000);
  s = await state();
  check(s.export?.cancelled === true && (await text(ctrlM, 'status-label')) === 'CANCELADO', `6. cancelado al ${Math.round(cancelProgress * 100)} %: estado CANCELADO`);
  check((await opfsTemp()).length === 0, '8. sin MP4 temporal tras cancelar');
  check(mp4Files().length === 2, '6. sin descarga parcial');
  check(await ctrlM.eval(`['retry-export','download-webm','discard'].every(r => !document.querySelector('[data-role="'+r+'"]').hidden)`), 'opciones: ↻ Reintentar MP4 · ⬇ WebM · Descartar');
  await click(ctrlM, 'retry-export');
  await waitStatus('finished', 60000);
  s = await state();
  check(s.lastRecording.kind === 'mp4' && mp4Files().length === 3, `reintento completado: ${s.lastRecording.fileName}`);

  // ---------------------------------------------------------------- M4
  log('M4) MP4 cancelado → descargar el WebM original (fallback)');
  const webmBefore = files().length;
  await setSettings({ exportFormat: 'mp4', tabAudio: true, quality: 'max' });
  await recordFor(6000);
  await waitFor(async () => { const st = await state(); return st.status === 'exporting' && st.export?.progress > 0.02 ? true : null; }, 'conversión', 30000);
  await click(popup, 'cancel-export');
  await waitStatus('export-failed', 15000);
  await click(popup, 'download-webm');
  await waitStatus('finished', 30000);
  s = await state();
  check(s.lastRecording.kind === 'webm' && files().length === webmBefore + 1, `WebM descargado como alternativa: ${s.lastRecording.fileName}`);
  check((await idb()).chunks === 0 && (await opfsTemp()).length === 0 && !(await hasOffscreen()), 'todo limpio tras la descarga del WebM');

  // ---------------------------------------------------------------- M5
  log('M5) MP4 cancelado → descartar');
  await recordFor(5000);
  await waitFor(async () => { const st = await state(); return st.status === 'exporting' && st.export?.progress > 0.02 ? true : null; }, 'conversión', 30000);
  await click(popup, 'cancel-export');
  await waitStatus('export-failed', 15000);
  await click(popup, 'discard');
  await waitStatus('idle', 15000);
  check((await idb()).chunks === 0 && (await opfsTemp()).length === 0 && !(await hasOffscreen()), 'descartar borra WebM, MP4 temporal y offscreen');
  await testTab.eval('tone(false)');

  // ---------------------------------------------------------------- Q1
  log('Q1) MP4 a 60 fps: nivel H.264 según FPS y FPS reales');
  await testTab.eval('tone(true)');
  await setSettings({ exportFormat: 'mp4', tabAudio: true, resolution: '720p', fps: 60 });
  await recordFor(4000);
  await waitStatus('finished', 60000);
  s = await state();
  const q1 = await analyzeMp4(s.lastRecording.fileName);
  const q1Bytes = readFileSync(join(downloads, s.lastRecording.fileName));
  const q1Codec = await (await new MB.Input({ source: new MB.BufferSource(q1Bytes), formats: MB.ALL_FORMATS }).getPrimaryVideoTrack()).getCodecParameterString();
  const expectedLevel = h264CodecString({ width: s.export.stats.width, height: s.export.stats.height, fps: s.export.stats.targetFps, bitrate: s.export.stats.videoBitrate });
  check(q1Codec.slice(-2) === expectedLevel.slice(-2), `nivel H.264 en el MP4: ${q1Codec} (nivel esperado ${expectedLevel.slice(-2)} para ${s.export.stats.width}×${s.export.stats.height} @ ${s.export.stats.targetFps} fps; Chrome declaraba uno menor)`);
  // Solo el avcC declara SPS/PPS: ningún paquete lleva un SPS en banda con otro nivel.
  const q1In = new MB.Input({ source: new MB.BufferSource(q1Bytes), formats: MB.ALL_FORMATS });
  let inbandSps = 0;
  for await (const pkt of new MB.EncodedPacketSink(await q1In.getPrimaryVideoTrack()).packets()) {
    for (let p = 0; p + 4 < pkt.data.length;) {
      const len = (pkt.data[p] << 24) | (pkt.data[p + 1] << 16) | (pkt.data[p + 2] << 8) | pkt.data[p + 3];
      if ((pkt.data[p + 4] & 0x1f) === 7) inbandSps++;
      p += 4 + len;
    }
  }
  check(inbandSps === 0, `sin SPS en banda (${inbandSps}): el nivel del avcC es el que leen los reproductores`);
  check(s.export.stats.targetFps === 60 && q1.fps > 50, `FPS reales del MP4: ${q1.fps.toFixed(1)} (entrada ${s.export.stats.inputFps}) · ${q1.videoPackets} fotogramas = ${s.export.stats.inputVideoFrames}`);
  check(q1.videoPackets === s.export.stats.inputVideoFrames && q1.seeked && q1.rms > 0.02, '60 fps: N → N, seek y audio');
  check(!s.lastRecording.note, 'sin aviso de FPS bajos (la captura entregó ~60 fps)');

  // ---------------------------------------------------------------- Q2
  log('Q2) Sin espacio → error claro, WebM conservado → reintento');
  // Disco «lleno»: se sustituye navigator.storage.estimate() en el offscreen (lo que la
  // extensión consulta para decidir) por 100 MB de cuota con 99 MB usados.
  await setSettings({ exportFormat: 'mp4', tabAudio: true, resolution: '720p', fps: 30 });
  await click(popup, 'start');
  await waitStatus('recording');
  const off = await attach((await findTarget('/src/offscreen/offscreen.html')).targetId, { watch: false });
  await off.eval(`navigator.storage.estimate = async () => ({ quota: 100 * 1024 * 1024, usage: 99 * 1024 * 1024 }); true`);
  await sleep(3000);
  await command('STOP');
  await waitStatus('export-failed', 60000);
  s = await state();
  check(/espacio/i.test(s.notice?.message ?? '') && !s.export.cancelled, `error comprensible: «${s.notice?.message}»`);
  check(!!s.webm && (await opfsTemp()).length === 0, 'WebM conservado y sin temporal OPFS');
  await off.eval('delete navigator.storage.estimate; true'); // vuelve el método real
  await click(popup, 'retry-export');
  await waitStatus('finished', 60000);
  check((await state()).lastRecording.kind === 'mp4', 'reintento con espacio restaurado → MP4');

  // ---------------------------------------------------------------- Q3
  log('Q3) Cerrar el controlador durante la conversión');
  await setSettings({ exportFormat: 'mp4', tabAudio: true, quality: 'max', resolution: 'auto', fps: 30 });
  await recordFor(8000);
  await waitFor(async () => { const st = await state(); return st.status === 'exporting' && st.export?.progress > 0.05 ? true : null; }, 'conversión', 30000);
  const ctrlQ = await waitFor(() => findTarget('/src/controller/controller.html'), 'controlador');
  await send('Target.closeTarget', { targetId: ctrlQ.targetId });
  await waitStatus('finished', 60000);
  check((await state()).lastRecording.kind === 'mp4', 'la conversión continúa sin el controlador y termina');

  // ---------------------------------------------------------------- Q4
  log('Q4) Cancelar en distintos puntos de la misma conversión');
  await setSettings({ exportFormat: 'mp4', tabAudio: true, quality: 'max', resolution: 'auto', fps: 60 });
  const mp4Before = mp4Files().length;
  await recordFor(25000);
  // El progreso se notifica cada 500 ms: 80 % es el último punto alcanzable de forma fiable
  // (25 s de vídeo); el 99 % se cubre de forma determinista en los tests unitarios.
  for (const target of [0.01, 0.25, 0.5, 0.65, 0.8]) {
    if (target > 0.01) await click(popup, 'retry-export');
    const at = await waitFor(async () => {
      const st = await state();
      if (st.status !== 'exporting') return st.status === 'finished' ? -1 : null;
      return st.export?.phase === 'converting' && st.export.progress >= target ? st.export.progress : null;
    }, `progreso ≥ ${target * 100} %`, 60000);
    if (at === -1) { check(false, `terminó antes de llegar al ${target * 100} %`); break; }
    await click(popup, 'cancel-export');
    await waitStatus('export-failed', 15000);
    const st = await state();
    const cpu = await extensionCpuSeconds(2000);
    const temp = await opfsTemp();
    check(st.export.cancelled && temp.length === 0 && mp4Files().length === mp4Before && !!st.webm && cpu < 0.3,
      `cancelado al ${Math.round(at * 100)} % (objetivo ${target * 100} %): CANCELADO · OPFS vacío · sin MP4 parcial · WebM disponible · CPU en reposo ${cpu.toFixed(2)} s/2 s`);
  }
  await click(popup, 'retry-export');
  await waitStatus('finished', 120000);
  s = await state();
  const q4 = await analyzeMp4(s.lastRecording.fileName);
  check(q4.videoPackets === s.export.stats.inputVideoFrames, `tras 5 cancelaciones, el reintento completa: ${s.export.stats.inputVideoFrames} → ${q4.videoPackets} fotogramas`);

  await testTab.eval('tone(false)');
  // Q5 (cuelgue de Chrome a mitad de conversión) está en scripts/e2e-crash.mjs.

  // ---------------------------------------------------------------- H
  log('H) Pestaña sin audio + «Dejar de compartir» (6)');
  await setSettings({ tabAudio: true, micEnabled: false });
  await click(popup, 'start');
  await waitStatus('recording');
  s = await state();
  check(['on', 'unavailable'].includes(s.audio?.tab), `6. pestaña silenciosa: audio.tab=${s.audio?.tab} (Chrome entrega un track ${s.audio?.tab === 'on' ? 'silencioso' : 'ausente'})`);
  await sleep(1500);
  await send('Target.closeTarget', { targetId: pageId }); // la captura termina → track.onended
  const H = await finishAndAnalyze('H');
  check(H.analysis.audioTracks === 0 || H.analysis.rms < 0.01, `6. archivo válido sin audio audible (pistas de audio: ${H.analysis.audioTracks}, RMS ${H.analysis.rms?.toFixed(4) ?? '—'})`);

  // ---------------------------------------------------------------- I
  log('I) Cancelar el selector (9)');
  await setSettings({});
  await click(popup, 'start');
  await waitStatus('selecting');
  const settled = await waitFor(async () => ((await state()).status !== 'selecting' ? true : null), 'fin de selección', 2500).catch(() => false);
  if (!settled) await click(popup, 'cancel');
  await waitStatus('idle');
  s = await state();
  check(s.notice?.type === 'info' && /cancelad/i.test(s.notice.message), `9. vuelve a LISTO: «${s.notice?.message}»`);
  check(!(await hasOffscreen()) && (await badge()) === '', 'sin offscreen ni badge');

  // ---------------------------------------------------------------- final
  check(files().length === 7 && mp4Files().length === 7, `descargas: ${files().length} WebM y ${mp4Files().length} MP4 (esperado 7 y 7)`);
  const finalIdb = await idb();
  check(finalIdb.recordings === 0 && finalIdb.chunks === 0, 'IndexedDB vacío al terminar');
  check(consoleErrors.length === 0, `sin errores de consola ${consoleErrors.length ? JSON.stringify(consoleErrors) : ''}`);

  exitCode = failures ? 1 : 0;
  log(exitCode ? `E2E FALLÓ (${failures})` : 'E2E OK');
} catch (error) {
  console.error('[e2e] ERROR', error.message);
  console.error(stderr.split('\n').filter((l) => /extension|ERROR/i.test(l)).slice(-15).join('\n'));
} finally {
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
  process.exit(exitCode);
}
