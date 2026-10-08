import { launchChrome, sleep } from '../../scripts/lib/cdp.mjs';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// Perfil PERSISTENTE (results/profile) para que la caché del modelo sobreviva entre ejecuciones.
const profile = resolve('results/profile');
const configs = JSON.parse(process.argv[2]);
const chrome = launchChrome({ profile, flags: process.argv.slice(3) });
const rss = () => { let kb = 0; const kids = new Map();
  for (const n of readdirSync('/proc')) { if (!/^\d+$/.test(n)) continue; try { const s = readFileSync(`/proc/${n}/stat`, 'utf8'); const pp = +s.slice(s.lastIndexOf(')') + 2).split(' ')[1]; (kids.get(pp) ?? kids.set(pp, []).get(pp)).push(+n); } catch {} }
  const st = [chrome.proc.pid]; while (st.length) { const p = st.pop(); st.push(...(kids.get(p) ?? [])); try { kb += +readFileSync(`/proc/${p}/statm`, 'utf8').split(' ')[1] * 4; } catch {} } return Math.round(kb / 1024); };
try {
  const { id } = await chrome.send('Extensions.loadUnpacked', { path: resolve('extension') });
  for (const cfg of configs) {
    const page = await chrome.open(`chrome-extension://${id}/bench.html`);
    await sleep(500);
    const base = rss(); let peak = base;
    const timer = setInterval(() => { peak = Math.max(peak, rss()); }, 250);
    try {
      const r = await page.eval(`run(${JSON.stringify(cfg)})`);
      clearInterval(timer);
      console.log(JSON.stringify({ ...r, ramBaseMb: base, ramPeakMb: peak, ramDeltaMb: peak - base }, null, 1));
      writeFileSync(`results/asr-${cfg.model.split('/').pop()}-${cfg.dtype ?? 'q8'}-${cfg.device ?? 'wasm'}.json`, JSON.stringify({ ...r, ramBaseMb: base, ramPeakMb: peak }, null, 2));
    } catch (e) { clearInterval(timer); console.log(cfg.model, 'ERROR', e.message.split('\n')[0]); }
    await chrome.send('Target.closeTarget', { targetId: page.targetId });
  }
} finally { chrome.proc.kill(); process.exit(0); }
