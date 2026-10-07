import { resolve } from 'node:path';
import { launchChrome } from './lib/cdp.mjs';
const chrome = await launchChrome();
try {
  const { id } = await chrome.send('Extensions.loadUnpacked', { path: resolve('extension') });
  const page = await chrome.open(`chrome-extension://${id}/bench.html`);
  for (const name of process.argv.slice(2)) {
    const a = await page.eval(`bench.analyzeFile('${name}')`);
    console.log(`${name}: cajas ${a.boxes.order} (faststart ${a.boxes.faststart}) · reproduce ${a.playback.playable} · ${a.playback.width}×${a.playback.height} · dur ${a.playback.duration.toFixed(2)} s · seek ${a.playback.seeked} · audio decodificable ${a.audio.decodable} (${a.audio.duration?.toFixed(2)} s)`);
    console.log(`   códecs ${a.marks.videoCodec}/${a.marks.audioCodec} · destellos ${a.marks.flashes} · pitidos ${a.marks.beeps} · A/V mediana ${a.marks.avOffsetMedianMs?.toFixed(1)} ms · dispersión ${a.marks.avOffsetSpreadMs?.toFixed(1)} ms`);
  }
} finally { await chrome.close(); }
