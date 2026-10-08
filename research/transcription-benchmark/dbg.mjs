import { launchChrome, sleep } from '../../scripts/lib/cdp.mjs';
import { mkdtempSync } from 'node:fs'; import { resolve } from 'node:path';
const chrome = launchChrome({ profile: mkdtempSync('/tmp/claude-1000/-home-jose-ahumada-personal-projects-chrome-screen-recorder-/3e3f2ba0-72d9-426e-924f-b7626e88ee16/scratchpad/p-') });
try {
  const { id } = await chrome.send('Extensions.loadUnpacked', { path: resolve('extension') });
  const page = await chrome.open(`chrome-extension://${id}/bench.html`);
  await sleep(1000);
  console.log(await page.eval(`import('./bench.js').then(() => 'ok', e => 'ERROR ' + e.name + ': ' + e.message)`));
  console.log(await page.eval(`import('./vendor/transformers.min.js').then(m => 'transformers ok: ' + Object.keys(m).length, e => 'ERROR ' + e.message)`));
} finally { chrome.proc.kill(); process.exit(0); }
