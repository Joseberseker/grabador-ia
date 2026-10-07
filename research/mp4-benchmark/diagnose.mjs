import { launchChrome } from './lib/cdp.mjs';
import { resolve } from 'node:path';
const chrome = await launchChrome();
try {
  const { id } = await chrome.send('Extensions.loadUnpacked', { path: resolve('extension') });
  const page = await chrome.open(`chrome-extension://${id}/bench.html`);
  for (const name of process.argv.slice(2)) console.log(name, JSON.stringify(await page.eval(`bench.diagnoseFrames('${name}')`), null, 1));
} finally { await chrome.close(); }
