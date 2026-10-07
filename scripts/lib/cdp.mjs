/**
 * Cliente CDP mínimo sobre --remote-debugging-pipe (sin dependencias) para las pruebas E2E.
 * Admite relanzar Chrome con el MISMO perfil (simular cuelgues/reinicios).
 */
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function launchChrome({ profile, flags = [] }) {
  const proc = spawn(process.env.CHROME_BIN || 'google-chrome', [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', ...flags, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});
  let nextId = 0;
  let buffer = '';
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
      targetId,
      sessionId,
      async eval(expression, { gesture = false } = {}) {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture }, sessionId);
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
  return { proc, send, attach, open, targets };
}

export async function waitFor(fn, label, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`Timeout esperando: ${label}`);
}
