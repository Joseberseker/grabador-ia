#!/usr/bin/env node
/**
 * Genera los WebM de entrada CON NUESTRA EXTENSIÓN DE PRODUCCIÓN (raíz del repo).
 * Graba una página de prueba de sincronía: en cada segundo exacto la pantalla se
 * pone blanca 100 ms y suena un pitido de 1 kHz a la vez. Así se mide después
 * el desfase audio/vídeo antes y después de convertir.
 *
 * Uso: node make-inputs.mjs   → extension/inputs/input-10s-720p.webm, input-60s-1080p.webm
 */
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Por defecto, el paquete de producción (dist/). EXTENSION_DIR permite otro.
const EXT = resolve(process.env.EXTENSION_DIR ?? resolve(HERE, '../../dist'));
const TITLE = 'SyncTestPage';

// Página de prueba: animación + reloj + destello/pitido sincronizados en cada segundo.
const html = `<title>${TITLE}</title><body style="margin:0;background:#000"><canvas id=c></canvas><script>
c.width = innerWidth; c.height = innerHeight; const x = c.getContext('2d');
const ac = new AudioContext();
const beepGain = ac.createGain(); beepGain.gain.value = 0;
const beep = ac.createOscillator(); beep.frequency.value = 1000; beep.connect(beepGain).connect(ac.destination); beep.start();
const hum = ac.createOscillator(); hum.frequency.value = 220; const humGain = ac.createGain(); humGain.gain.value = 0.05;
hum.connect(humGain).connect(ac.destination); hum.start();
const t0 = performance.now(); const a0 = ac.currentTime;
for (let s = 1; s < 7200; s++) { beepGain.gain.setValueAtTime(0.8, a0 + s); beepGain.gain.setValueAtTime(0, a0 + s + 0.1); }
function draw() {
  const t = (performance.now() - t0) / 1000;
  const flash = t >= 1 && (t % 1) < 0.1;
  x.fillStyle = flash ? '#fff' : 'hsl(' + (t * 40 % 360) + ',60%,25%)';
  x.fillRect(0, 0, c.width, c.height);
  if (!flash) {
    x.fillStyle = '#fff'; x.font = 'bold 80px monospace'; x.fillText(t.toFixed(2) + ' s', 40, 120);
    for (let i = 0; i < 12; i++) {
      x.fillStyle = 'hsl(' + (i * 30) + ',80%,60%)'; x.beginPath();
      x.arc(c.width / 2 + Math.cos(t * 2 + i) * c.height / 3, c.height / 2 + Math.sin(t * 3 + i) * c.height / 3, 30, 0, 7); x.fill();
    }
  }
  requestAnimationFrame(draw);
}
draw();
</script>`;
const page = 'data:text/html,' + encodeURIComponent(html);

// Contenido de pantalla realista: documento con texto pequeño y código que se desplaza.
const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
const textHtml = `<title>${TITLE}</title><body style="margin:0;font:14px/1.5 system-ui;background:#fff;color:#222">
<div id=d style="padding:24px 48px;column-count:2;column-gap:48px">${Array.from({ length: 120 }, (_, i) =>
  `<h3 style="margin:12px 0 4px">${i + 1}. Sección de prueba de texto</h3><p>${lorem.repeat(3)}</p>` +
  `<pre style="background:#f4f5f7;padding:8px;font:12px monospace">function ejemplo${i}(a, b) {\n  return a.map((x) => x * b + ${i});\n}</pre>`).join('')}</div>
<script>let y=0;setInterval(()=>{y+=2;scrollTo(0,y)},33);</script>`;
const textPage = 'data:text/html,' + encodeURIComponent(textHtml);

async function record({ name, seconds, width, height, url = page }) {
  const downloads = mkdtempSync(join(tmpdir(), 'mp4-bench-dl-'));
  const chrome = await launchChrome({
    downloads,
    flags: [`--auto-select-tab-capture-source-by-title=${TITLE}`, '--autoplay-policy=no-user-gesture-required', '--screen-info={2560x1600}'],
  });
  try {
    const { id } = await chrome.send('Extensions.loadUnpacked', { path: EXT });
    const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
    const { windowId } = await chrome.send('Browser.getWindowForTarget', { targetId });
    await chrome.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width, height } });
    const tab = await chrome.attach(targetId);
    await chrome.send('Page.navigate', { url }, tab.sessionId);
    await sleep(1500);
    console.log(`  pestaña de prueba: «${await tab.eval('document.title')}» ${await tab.eval('innerWidth + "×" + innerHeight')}`);
    const popup = await chrome.open(`chrome-extension://${id}/src/popup/popup.html`);
    await popup.eval(`chrome.storage.local.set({ settings: { micEnabled: false, tabAudio: true, resolution: 'auto', fps: 30, quality: 'high', countdown: 0 } })`);
    const state = () => popup.eval(`chrome.storage.session.get('recordingState').then(r => r.recordingState ?? {})`);
    await popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: 'START' })`);
    for (let i = 0; (await state()).status !== 'recording'; i++) {
      if (i > 100) throw new Error(`no empezó a grabar: ${JSON.stringify(await state())}`);
      await sleep(100);
    }
    const s = await state();
    console.log(`  grabando ${name}: ${s.video.width}×${s.video.height} · ${s.video.frameRate} fps · audio ${s.audio.plan}`);
    await sleep(seconds * 1000);
    await popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: 'STOP' })`);
    while ((await state()).status !== 'finished') await sleep(200);
    const file = readdirSync(downloads).find((f) => f.endsWith('.webm'));
    copyFileSync(join(downloads, file), join(HERE, 'extension/inputs', `${name}.webm`));
    console.log(`  ✓ extension/inputs/${name}.webm`);
  } finally {
    await chrome.close();
  }
}

// Sin argumentos: las entradas del benchmark original. Con argumentos:
//   node make-inputs.mjs <nombre> <segundos> <ancho> <alto>
const [name, seconds, width, height, kind] = process.argv.slice(2);
if (name) {
  await record({ name, seconds: Number(seconds), width: Number(width), height: Number(height), url: kind === 'text' ? textPage : page });
} else {
  await record({ name: 'input-10s-720p', seconds: 10, width: 1280, height: 720 });
  await record({ name: 'input-60s-1080p', seconds: 60, width: 1920, height: 1080 });
}
