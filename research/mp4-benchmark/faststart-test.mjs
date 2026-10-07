#!/usr/bin/env node
/**
 * ¿Empieza a reproducirse el MP4 sin descargarlo entero?
 * Servidor HTTP local SIN rangos (Accept-Ranges: none) y limitado a 2 MB/s: con el moov al
 * final, Chrome necesita el archivo completo antes de conocer la duración.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { launchChrome, sleep } from './lib/cdp.mjs';

const files = process.argv.slice(2);
let sent = 0;
let current = null;
const server = http.createServer(async (req, res) => {
  const data = readFileSync(current);
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length, 'Accept-Ranges': 'none', 'Cache-Control': 'no-store' });
  sent = 0;
  for (let i = 0; i < data.length && !res.destroyed; i += 64 * 1024) {
    res.write(data.subarray(i, i + 64 * 1024));
    sent += Math.min(64 * 1024, data.length - i);
    await sleep(32); // ~2 MB/s
  }
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const chrome = await launchChrome({ flags: ['--autoplay-policy=no-user-gesture-required'] });
try {
  for (const f of files) {
    current = f;
    const page = await chrome.open('about:blank');
    const t0 = Date.now();
    const r = await page.eval(`new Promise((resolve) => {
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto';
      const out = {};
      v.onloadedmetadata = () => { out.metadataMs = performance.now(); out.duration = v.duration; };
      v.requestVideoFrameCallback(() => { out.firstFrameMs = performance.now(); resolve(out); });
      v.src = 'http://127.0.0.1:${port}/v.mp4?' + Math.random(); v.play().catch(() => {});
      setTimeout(() => resolve(out), 120000);
    })`);
    const firstFrameBytes = sent;
    const size = readFileSync(f).length;
    console.log(`${f.split('/').pop()}: ${(size / 1e6).toFixed(1)} MB · primer fotograma tras ${(firstFrameBytes / 1e6).toFixed(1)} MB recibidos (${((firstFrameBytes / size) * 100).toFixed(0)} %) · ${((Date.now() - t0) / 1000).toFixed(1)} s · duración ${r.duration?.toFixed(1)} s`);
    await chrome.send('Target.closeTarget', { targetId: page.targetId });
    await sleep(500);
  }
} finally {
  await chrome.close();
  server.close();
}
