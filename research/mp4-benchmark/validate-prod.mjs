#!/usr/bin/env node
/** Valida el conversor de producción aislado: fotogramas, sincronía, fast start, cancelación. */
import { resolve } from 'node:path';
import { launchChrome } from './lib/cdp.mjs';

const input = process.argv[2] ?? 'input-60s-1080p';
const chrome = await launchChrome();
try {
  const { id } = await chrome.send('Extensions.loadUnpacked', { path: resolve('extension') });
  const page = await chrome.open(`chrome-extension://${id}/bench.html`);
  const run = async (label, opts) => {
    const r = await page.eval(`bench.prodConvert('${input}', ${JSON.stringify(opts)})`);
    if (!r.ok) return console.log(`${label}: ✗ ${r.code} — ${r.message}`), r;
    const a = await page.eval(`bench.analyze('${input}')`);
    const pk = await page.eval(`bench.packetStats('${input}')`);
    const s = r.stats;
    console.log(`${label}: ${(s.elapsedMs / 1000).toFixed(1)} s · ${(s.outputBytes / 1e6).toFixed(1)} MB · ${s.width}×${s.height} · vídeo ${(s.videoBitrate / 1e6).toFixed(2)} Mbps · AAC ${s.aacBackend}`);
    console.log(`   fotogramas: entrada ${pk.input.packets} (${pk.input.avgFps} fps) → salida ${pk.output.packets} (${pk.output.avgFps} fps) · bombeados ${s.convertedVideoFrames} · codificados ${s.encodedVideoPackets}`);
    console.log(`   cajas: ${a.boxes.order} · fastStart=${a.boxes.faststart} · Chrome: dur ${a.playback.duration.toFixed(2)} s (entrada ${pk.input.durationS}) · seek ${a.playback.seeked} · audio ${a.audio.decodable}`);
    console.log(`   A/V: salida ${a.marks.avOffsetMedianMs?.toFixed(1)} ms (dispersión ${a.marks.avOffsetSpreadMs?.toFixed(1)}) vs entrada ${a.inputAvOffsetMedianMs?.toFixed(1)} ms · destellos ${a.marks.flashes} · pitidos ${a.marks.beeps} · progreso: ${r.progressEvents} eventos`);
    return r;
  };
  await run('Con compensación AAC', {});
  await run('Sin compensación AAC', { aacPrimingCompensation: false });
  const c = await page.eval(`bench.prodConvert('${input}', { cancelAt: 0.4 })`);
  console.log(`Cancelar al 40 %: ${c.ok ? '✗ no se canceló' : `✓ ${c.code}`} (último progreso ${(c.lastProgress?.progress * 100).toFixed(0)} %) · temporales OPFS: ${JSON.stringify(await page.eval('bench.opfsTemp()'))}`);
} finally {
  await chrome.close();
}
