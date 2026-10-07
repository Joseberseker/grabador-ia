import { launchChrome } from './lib/cdp.mjs';
const chrome = await launchChrome({ flags: ['--autoplay-policy=no-user-gesture-required'] });
const t = (p, ms, label) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('TIMEOUT ' + label)), ms))]);
try {
  const { id } = await t(chrome.send('Extensions.loadUnpacked', { path: process.cwd() + '/extension' }), 10000, 'load');
  console.log('ext', id);
  const page = await t(chrome.open(`chrome-extension://${id}/bench.html`), 10000, 'open');
  console.log('status:', await t(page.eval('document.getElementById("status").textContent + " / bench=" + !!window.bench'), 5000, 'status'));
  console.log('csp:', JSON.stringify(await t(page.eval('bench.cspProbe()'), 10000, 'csp')));
  for (const v of process.argv.slice(2)) {
    const t0 = Date.now();
    const poll = setInterval(async () => console.log('   …', JSON.stringify(await page.eval('window.benchTrace').catch(() => null))), 15000);
    try { console.log(v, JSON.stringify(await t(page.eval(`bench.convert('${v}', 'input-10s-720p')`), 60000, v)), Date.now() - t0, 'ms'); }
    catch (e) { console.log(v, 'ERROR', e.message.split('\n')[0]); }
    finally { clearInterval(poll); }
  }
} catch (e) { console.log('ERROR', e.message); } finally { await chrome.close(); process.exit(0); }
