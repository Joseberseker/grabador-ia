#!/usr/bin/env node
/** Prueba de bitrate H.264 con el conversor de producción: tamaño, bitrate real, PSNR y recortes de texto. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchChrome } from './lib/cdp.mjs';

const CASES = [
  { input: 'input-10s-720p', w: 1278, h: 632, crop: [40, 40, 480, 140] },
  { input: 'input-30s-1080p-text', w: 1918, h: 992, crop: [48, 300, 640, 220] },
  { input: 'input-60s-1080p', w: 1918, h: 992, crop: [40, 40, 480, 140] },
];
const BPP = [0.04, 0.06, 0.09, 0.14];
const rows = [];
const chrome = await launchChrome();
try {
  const { id } = await chrome.send('Extensions.loadUnpacked', { path: resolve('extension') });
  const page = await chrome.open(`chrome-extension://${id}/bench.html`);
  for (const c of CASES) {
    for (const bpp of BPP) {
      const r = await page.eval(`bench.prodConvert('${c.input}', { videoBitrate: Math.round(${c.w} * ${c.h} * 30 * ${bpp}) })`);
      if (!r.ok) { console.log(c.input, bpp, '✗', r.message); continue; }
      const psnr = await page.eval(`bench.psnrFull('${c.input}')`);
      const s = r.stats;
      const realMbps = ((s.outputBytes * 8) / s.durationS - s.audioBitrate) / 1e6;
      const [x, y, w, h] = c.crop;
      const crop = async (which, file) => {
        try {
          writeFileSync(file, Buffer.from(await page.eval(`bench.frameCrop('${which}', '${c.input}', ${s.durationS / 2}, ${x}, ${y}, ${w}, ${h})`), 'base64'));
        } catch (e) { console.log(`   (recorte ${which} no disponible: ${e.message.split('\n')[0]})`); }
      };
      await crop('output', `results/crop__${c.input}__bpp${bpp}.png`);
      if (bpp === BPP[0]) await crop('input', `results/crop__${c.input}__input.png`);
      const row = { input: c.input, bpp, targetMbps: s.videoBitrate / 1e6, realVideoMbps: realMbps, sizeMb: s.outputBytes / 1e6, mbPerMin: s.outputBytes / 1e6 / (s.durationS / 60), psnr, seconds: s.elapsedMs / 1000 };
      rows.push(row);
      console.log(`${c.input.padEnd(22)} bpp ${bpp.toFixed(2)} · objetivo ${row.targetMbps.toFixed(2)} Mbps · real ${row.realVideoMbps.toFixed(2)} Mbps · ${row.sizeMb.toFixed(1)} MB (${row.mbPerMin.toFixed(1)} MB/min) · PSNR ${psnr.toFixed(1)} dB · ${row.seconds.toFixed(1)} s`);
    }
  }
  writeFileSync('results/bitrate.json', JSON.stringify(rows, null, 2));
} finally {
  await chrome.close();
}
