/**
 * Cliente CDP mínimo sobre --remote-debugging-pipe (sin dependencias) y
 * medición de recursos de los procesos de Chrome vía /proc (Linux).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ flags = [], downloads = null } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'mp4-bench-'));
  if (downloads) {
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(join(profile, 'Default', 'Preferences'),
      JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
  }
  const proc = spawn(process.env.CHROME_BIN || 'google-chrome', [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', ...flags, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});
  let nextId = 0, buffer = '';
  const pending = new Map();
  proc.stdio[4].on('data', (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { ok, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : ok(msg.result);
      }
    }
  });
  const send = (method, params = {}, sessionId) => {
    const id = ++nextId;
    proc.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + '\0');
    return new Promise((ok, reject) => pending.set(id, { ok, reject }));
  };
  const attach = async (targetId) => {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    return {
      targetId, sessionId,
      async eval(expression, { gesture = false, timeout = 0 } = {}) {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture, ...(timeout && { timeout }) }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
    };
  };
  const open = async (url) => {
    const { targetId } = await send('Target.createTarget', { url });
    await sleep(700);
    return attach(targetId);
  };
  const targets = async () => (await send('Target.getTargets')).targetInfos;
  const close = async () => {
    proc.kill();
    await sleep(400);
    rmSync(profile, { recursive: true, force: true });
  };
  return { proc, send, attach, open, targets, close };
}

// ---------------------------------------------------------------------------
// Recursos: RSS y tiempo de CPU de TODOS los procesos de Chrome lanzados.
// ---------------------------------------------------------------------------

const CLK_TCK = 100;
const PAGE_KB = 4;

function descendants(rootPid) {
  const children = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(name));
    } catch { /* proceso terminado */ }
  }
  const out = [rootPid];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]) ?? []));
  return out;
}

/** RSS por tipo de proceso (MB) en este instante. */
export function sampleProcesses(rootPid) {
  const out = { totalMb: 0, extensionMb: 0, gpuMb: 0, browserMb: 0, otherMb: 0 };
  for (const pid of descendants(rootPid)) {
    try {
      const mb = (Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * PAGE_KB) / 1024;
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      out.totalMb += mb;
      if (cmd.includes('--extension-process')) out.extensionMb += mb;
      else if (cmd.includes('--type=gpu-process')) out.gpuMb += mb;
      else if (pid === rootPid) out.browserMb += mb;
      else out.otherMb += mb;
    } catch { /* proceso terminado */ }
  }
  return out;
}

function sample(rootPid) {
  let rssKb = 0, cpuTicks = 0, extensionRssKb = 0;
  for (const pid of descendants(rootPid)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      cpuTicks += Number(fields[11]) + Number(fields[12]); // utime + stime
      const rss = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * PAGE_KB;
      rssKb += rss;
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--extension-process')) extensionRssKb += rss;
    } catch { /* proceso terminado */ }
  }
  return { rssKb, cpuTicks, extensionRssKb };
}

/** Mide picos de RSS y CPU consumida mientras corre `fn`. */
export async function measure(rootPid, fn) {
  const base = sample(rootPid);
  let peakRss = base.rssKb, peakExt = base.extensionRssKb;
  const timer = setInterval(() => {
    const s = sample(rootPid);
    peakRss = Math.max(peakRss, s.rssKb);
    peakExt = Math.max(peakExt, s.extensionRssKb);
  }, 100);
  const t0 = performance.now();
  let result, error;
  try { result = await fn(); } catch (e) { error = e; }
  const wallMs = performance.now() - t0;
  clearInterval(timer);
  const end = sample(rootPid);
  return {
    result, error,
    wallMs,
    cpuMs: ((end.cpuTicks - base.cpuTicks) * 1000) / CLK_TCK,
    peakRssMb: peakRss / 1024,
    rssDeltaMb: (peakRss - base.rssKb) / 1024,
    peakExtensionRendererMb: peakExt / 1024,
    extensionRendererDeltaMb: (peakExt - base.extensionRssKb) / 1024,
  };
}
