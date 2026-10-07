#!/usr/bin/env node
/**
 * Prueba REAL de la Fase 4B con la extensión de producción (raíz del repo):
 * grabar N s a 1080p (página de sincronía) → exportar MP4 → descargar.
 * Mide RAM de todos los procesos de Chrome y analiza el MP4 descargado.
 *
 *   node real-test.mjs <segundos> [etiqueta]
 */
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as MB from 'mediabunny';
import { launchChrome, sampleProcesses, sleep } from './lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Por defecto, el paquete de producción (dist/). EXTENSION_DIR permite otro.
const EXT = resolve(process.env.EXTENSION_DIR ?? resolve(HERE, '../../dist'));
const seconds = Number(process.argv[2] ?? 60);
const label = process.argv[3] ?? `${seconds}s-1080p`;
const TITLE = 'SyncTestPage';
const page = (await import('./sync-page.mjs')).syncPageUrl(TITLE);

const downloads = mkdtempSync(join(tmpdir(), 'real-test-dl-'));
const chrome = await launchChrome({
  downloads,
  flags: [`--auto-select-tab-capture-source-by-title=${TITLE}`, '--autoplay-policy=no-user-gesture-required', '--screen-info={2560x1600}'],
});
const pid = chrome.proc.pid;
const mb = (x) => Math.round(x.totalMb);
try {
  const { id } = await chrome.send('Extensions.loadUnpacked', { path: EXT });
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
  const { windowId } = await chrome.send('Browser.getWindowForTarget', { targetId });
  await chrome.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1920, height: 1080 } });
  const tab = await chrome.attach(targetId);
  await chrome.send('Page.navigate', { url: page }, tab.sessionId);
  await sleep(1500);
  const popup = await chrome.open(`chrome-extension://${id}/src/popup/popup.html`);
  await popup.eval(`chrome.storage.local.set({ settings: { micEnabled: false, tabAudio: true, resolution: 'auto', fps: 30, quality: 'auto', countdown: 0, exportFormat: 'mp4' } })`);
  const state = () => popup.eval(`chrome.storage.session.get('recordingState').then(r => r.recordingState ?? {})`);

  await sleep(20000); // reposo para una línea base estable
  const baseline = sampleProcesses(pid);
  await popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: 'START' })`);
  while ((await state()).status !== 'recording') await sleep(100);
  const s0 = await state();
  console.log(`[${label}] grabando ${s0.video.width}×${s0.video.height} · ${s0.video.frameRate} fps · audio ${s0.audio.plan} · ${seconds} s`);
  await sleep(seconds * 1000);
  const beforeStop = sampleProcesses(pid);
  await popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: 'STOP' })`);

  // Conversión: muestras cada 0,5 s.
  const series = [];
  let exportStart = null, exportStartSample = null;
  const t0 = Date.now();
  for (;;) {
    const st = await state();
    const p = sampleProcesses(pid);
    if (st.status === 'exporting' && !exportStart) {
      exportStart = Date.now();
      exportStartSample = p;
      // Copia del WebM de entrada (el offscreen aún lo conserva) para comparar la sincronía antes/después.
      await popup.eval(`chrome.downloads.download({ url: ${JSON.stringify(st.webm.blobUrl)}, filename: 'entrada-${label}.webm' })`);
    }
    series.push({ t: (Date.now() - t0) / 1000, status: st.status, phase: st.export?.phase, progress: st.export?.progress, totalMb: p.totalMb, extensionMb: p.extensionMb, gpuMb: p.gpuMb });
    if (st.status === 'finished' || st.status === 'export-failed' || st.status === 'idle') break;
    await sleep(500);
  }
  const finishedAt = Date.now();
  const end = await state();
  const atEnd = sampleProcesses(pid);
  const tail = [];
  for (let i = 0; i < 12; i++) { await sleep(5000); tail.push(sampleProcesses(pid)); }
  const after60 = tail.at(-1);
  if (end.status !== 'finished') throw new Error(`terminó en ${end.status}: ${JSON.stringify(end.notice)}`);

  const stats = end.export.stats;
  const exporting = series.filter((x) => x.status === 'exporting');
  const peak = exporting.reduce((m, x) => (x.totalMb > m.totalMb ? x : m), exporting[0] ?? series[0]);
  const file = readdirSync(downloads).find((f) => f.endsWith('.mp4'));
  for (let i = 0; i < 100 && !readdirSync(downloads).includes(`entrada-${label}.webm`); i++) await sleep(200);
  copyFileSync(join(downloads, `entrada-${label}.webm`), join(HERE, 'extension/inputs', `real-${label}-input.webm`));
  const mp4Path = join(downloads, file);
  copyFileSync(mp4Path, join(HERE, 'extension/inputs', `real-${label}.mp4`));
  copyFileSync(mp4Path, join(HERE, 'results', `real-${label}.mp4`));

  // Paquetes del MP4 (Node, solo demux)
  const input = new MB.Input({ source: new MB.BufferSource(readFileSync(mp4Path)), formats: MB.ALL_FORMATS });
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  const vStats = await v.computePacketStats();
  const audioFirst = await a.getFirstTimestamp();
  const videoFirst = await v.getFirstTimestamp();

  const report = {
    label, seconds, baselineMb: mb(baseline), beforeStopMb: mb(beforeStop), exportStartMb: exportStartSample && mb(exportStartSample),
    peakMb: mb(peak), peakAt: peak.t, peakExtensionMb: Math.round(peak.extensionMb), atEndMb: mb(atEnd), after60Mb: mb(after60),
    conversionS: exportStart ? (finishedAt - exportStart) / 1000 : null, stats,
    mp4: { file, sizeMb: readFileSync(mp4Path).length / 1e6, videoCodec: v.codec, audioCodec: a.codec, packets: vStats.packetCount, fps: vStats.averagePacketRate, bitrateMbps: vStats.averageBitrate / 1e6, videoFirst, audioFirst, width: v.displayWidth, height: v.displayHeight },
    series,
  };
  writeFileSync(join(HERE, 'results', `real-${label}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, series: `${series.length} muestras` }, null, 1));
} finally {
  await chrome.close();
}
