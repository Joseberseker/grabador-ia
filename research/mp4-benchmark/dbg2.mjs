import { resolve } from 'node:path';
import { launchChrome } from './lib/cdp.mjs';
const chrome = await launchChrome();
try {
  const { id } = await chrome.send('Extensions.loadUnpacked', { path: resolve('extension') });
  const page = await chrome.open(`chrome-extension://${id}/bench.html`);
  const r = await page.eval(`bench.prodConvert('input-30s-1080p-text', {})`);
  console.log(JSON.stringify(r.ok ? { ...r.stats } : r));
  console.log('psnr', await page.eval(`bench.psnrFull('input-30s-1080p-text')`));
  console.log('crop', (await page.eval(`bench.frameCrop('output', 'input-30s-1080p-text', 15.017, 48, 300, 640, 220).then(x => x.length, e => 'ERR ' + e.message)`)));
  console.log(await page.eval(`(async () => {
    const M0 = await import('./vendor/mediabunny.min.mjs');
    const i = new M0.Input({ source: new M0.BlobSource(window.__last ?? null), formats: M0.ALL_FORMATS });
    return 'skip';
  })().catch(e => 'x')`));
  console.log(await page.eval(`(async () => {
    const M = await import('./vendor/mediabunny.min.mjs');
    const out = [];
    for (const [label, blob] of [['in', await (await fetch('inputs/input-30s-1080p-text.webm')).blob()]]) {
      const i = new M.Input({ source: new M.BlobSource(blob), formats: M.ALL_FORMATS });
      const v = await i.getPrimaryVideoTrack(); const a = await i.getPrimaryAudioTrack();
      out.push(label + ' first=' + await i.getFirstTimestamp() + ' vFirst=' + await v.getFirstTimestamp() + ' aFirst=' + (a ? await a.getFirstTimestamp() : '-') + ' dur=' + await i.computeDuration() + ' vdur=' + await v.computeDuration());
    }
    return out.join('\\n');
  })()`));
} finally { await chrome.close(); }
