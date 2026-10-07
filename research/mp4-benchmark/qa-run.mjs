#!/usr/bin/env node
/**
 * Fase 4C — QA real con el PAQUETE de producción (dist/):
 * graba con la extensión, exporta a MP4 y mide RAM, fotogramas, FPS, bitrate y tiempos;
 * después analiza cada WebM/MP4 (sincronía por tramos, seek, audio).
 *
 *   node qa-run.mjs <nombre-de-lote> '<json con lista de configuraciones>'
 *
 * Configuración: { label, seconds, window: [w,h], resolution, fps, quality,
 *                  tabAudio, mic, screen (captura de pantalla falsa de Chrome) }
 */
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as MB from 'mediabunny';
import { launchChrome, sampleProcesses, sleep } from './lib/cdp.mjs';
import { syncPageUrl } from './sync-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(process.env.EXTENSION_DIR ?? resolve(HERE, '../../dist'));
const TITLE = 'SyncTestPage';
const [batch, json] = process.argv.slice(2);
const configs = JSON.parse(json);
const resultsPath = join(HERE, 'results', `qa-${batch}.json`);
const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {};

async function packetInfo(path) {
  const input = new MB.Input({ source: new MB.BufferSource(readFileSync(path)), formats: MB.ALL_FORMATS });
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  const vs = await v.computePacketStats();
  return {
    videoCodec: await v.getCodecParameterString().catch(() => v.codec),
    audioCodec: a ? await a.getCodecParameterString().catch(() => a.codec) : null,
    audioChannels: a?.numberOfChannels ?? null,
    frames: vs.packetCount,
    fps: Math.round(vs.averagePacketRate * 10) / 10,
    videoMbps: Math.round((vs.averageBitrate / 1e6) * 100) / 100,
    videoDuration: await v.computeDuration(),
    audioDuration: a ? await a.computeDuration() : null,
    width: v.displayWidth,
    height: v.displayHeight,
  };
}

async function record(cfg) {
  const downloads = mkdtempSync(join(tmpdir(), 'qa-dl-'));
  const flags = [`--auto-select-tab-capture-source-by-title=${TITLE}`, '--autoplay-policy=no-user-gesture-required', '--screen-info={2560x1600}'];
  if (cfg.mic) flags.push('--use-fake-device-for-media-stream');
  if (cfg.screen) flags.push('--use-fake-ui-for-media-stream');
  const chrome = await launchChrome({ downloads, flags });
  const pid = chrome.proc.pid;
  try {
    const { id } = await chrome.send('Extensions.loadUnpacked', { path: EXT });
    if (cfg.mic) await chrome.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'granted', origin: `chrome-extension://${id}` });
    const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
    const { windowId } = await chrome.send('Browser.getWindowForTarget', { targetId });
    await chrome.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: cfg.window[0], height: cfg.window[1] } });
    const tab = await chrome.attach(targetId);
    await chrome.send('Page.navigate', { url: syncPageUrl(TITLE) }, tab.sessionId);
    await sleep(1500);
    const popup = await chrome.open(`chrome-extension://${id}/src/popup/popup.html`);
    await popup.eval(`chrome.storage.local.set({ settings: ${JSON.stringify({
      micEnabled: !!cfg.mic, tabAudio: cfg.tabAudio !== false, resolution: cfg.resolution ?? 'auto',
      fps: cfg.fps ?? 30, quality: cfg.quality ?? 'auto', countdown: 0, exportFormat: 'mp4',
    })} })`);
    const state = () => popup.eval(`chrome.storage.session.get('recordingState').then(r => r.recordingState ?? {})`);

    await sleep(cfg.seconds >= 300 ? 20000 : 8000); // línea base estable
    const baseline = sampleProcesses(pid);
    await popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: 'START' })`);
    for (let i = 0; (await state()).status !== 'recording'; i++) {
      if (i > 150) throw new Error(`no empezó: ${JSON.stringify(await state())}`);
      await sleep(100);
    }
    const rec = await state();
    await sleep(cfg.seconds * 1000);
    await popup.eval(`chrome.runtime.sendMessage({ target: 'background', type: 'STOP' })`);

    let exportStart = null;
    let exportStartSample = null;
    let peak = { totalMb: 0 };
    let webmCopied = false;
    for (;;) {
      const st = await state();
      const p = sampleProcesses(pid);
      if (st.status === 'exporting') {
        if (!exportStart) { exportStart = Date.now(); exportStartSample = p; }
        if (p.totalMb > peak.totalMb) peak = p;
        if (!webmCopied && st.webm?.blobUrl) {
          webmCopied = true;
          await popup.eval(`chrome.downloads.download({ url: ${JSON.stringify(st.webm.blobUrl)}, filename: 'entrada.webm' })`);
        }
      }
      if (['finished', 'export-failed', 'idle'].includes(st.status)) break;
      await sleep(500);
    }
    const end = await state();
    const atEnd = sampleProcesses(pid);
    if (cfg.after60) await sleep(60000);
    const after60 = cfg.after60 ? sampleProcesses(pid) : null;
    if (end.status !== 'finished') throw new Error(`terminó en ${end.status}: ${end.notice?.message}`);
    for (let i = 0; i < 100 && !readdirSync(downloads).includes('entrada.webm'); i++) await sleep(200);
    const mp4 = readdirSync(downloads).find((f) => f.endsWith('.mp4'));
    copyFileSync(join(downloads, mp4), join(HERE, 'extension/inputs', `qa-${cfg.label}.mp4`));
    copyFileSync(join(downloads, 'entrada.webm'), join(HERE, 'extension/inputs', `qa-${cfg.label}.webm`));
    const s = end.export.stats;
    return {
      cfg,
      captured: { width: rec.video?.width, height: rec.video?.height, fps: rec.video?.frameRate, audio: rec.audio, notice: rec.notice?.message ?? null },
      ram: {
        baseline: Math.round(baseline.totalMb), exportStart: Math.round(exportStartSample?.totalMb ?? 0),
        peak: Math.round(peak.totalMb), atEnd: Math.round(atEnd.totalMb), after60: after60 && Math.round(after60.totalMb),
      },
      conversionS: end.export.stats.elapsedMs / 1000,
      stats: s,
      note: end.lastRecording?.note ?? null,
      webm: { size: readFileSync(join(downloads, 'entrada.webm')).length, ...(await packetInfo(join(downloads, 'entrada.webm'))) },
      mp4: { size: readFileSync(join(downloads, mp4)).length, ...(await packetInfo(join(downloads, mp4))) },
    };
  } finally {
    await chrome.close();
  }
}

async function analyze(labels) {
  const chrome = await launchChrome();
  try {
    const { id } = await chrome.send('Extensions.loadUnpacked', { path: resolve(HERE, 'extension') });
    const page = await chrome.open(`chrome-extension://${id}/bench.html`);
    const out = {};
    for (const label of labels) {
      for (const kind of ['webm', 'mp4']) {
        const a = await page.eval(`bench.analyzeFile('qa-${label}.${kind}')`);
        out[`${label}.${kind}`] = { boxes: a.boxes.order, faststart: a.boxes.faststart, playable: a.playback.playable, duration: a.playback.duration, seeked: a.playback.seeked, audio: a.audio.decodable, sync: { median: a.marks.avOffsetMedianMs, spread: a.marks.avOffsetSpreadMs, ...a.marks.avWindows, pairs: a.marks.pairs } };
      }
    }
    return out;
  } finally {
    await chrome.close();
  }
}

for (const cfg of configs) {
  const t0 = Date.now();
  try {
    results[cfg.label] = await record(cfg);
    const r = results[cfg.label];
    console.log(`[${cfg.label}] ${r.captured.width}×${r.captured.height} pedido ${cfg.fps ?? 30} fps → WebM ${r.webm.frames} fot. ${r.webm.fps} fps · MP4 ${r.mp4.frames} fot. ${r.mp4.fps} fps ${r.mp4.videoCodec} · ${r.mp4.videoMbps} Mbps · conv ${r.stats.elapsedMs / 1000} s · RAM base ${r.ram.baseline} pico ${r.ram.peak} fin ${r.ram.atEnd} +60s ${r.ram.after60}${r.note ? ' · AVISO: ' + r.note.slice(0, 60) : ''}`);
  } catch (error) {
    results[cfg.label] = { cfg, error: error.message };
    console.log(`[${cfg.label}] ✗ ${error.message}`);
  }
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`   (${Math.round((Date.now() - t0) / 1000)} s)`);
}
const ok = configs.map((c) => c.label).filter((l) => !results[l].error);
const analysis = await analyze(ok);
for (const l of ok) {
  results[l].analysis = { webm: analysis[`${l}.webm`], mp4: analysis[`${l}.mp4`] };
  const w = analysis[`${l}.webm`].sync;
  const m = analysis[`${l}.mp4`].sync;
  const f = (x) => (x == null ? '—' : `${x.toFixed(1)}`);
  console.log(`[${l}] sync WebM→MP4: inicio ${f(w.start)}→${f(m.start)} · 60 s ${f(w.at60s)}→${f(m.at60s)} · final ${f(w.end)}→${f(m.end)} ms (${m.pairs} pares) · MP4 ${analysis[`${l}.mp4`].boxes} · seek ${analysis[`${l}.mp4`].seeked} · audio ${analysis[`${l}.mp4`].audio}`);
}
writeFileSync(resultsPath, JSON.stringify(results, null, 2));
console.log(`✓ ${resultsPath}`);
