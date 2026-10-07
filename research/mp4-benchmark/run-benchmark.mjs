#!/usr/bin/env node
/**
 * Orquesta el benchmark: un Chrome nuevo por ejecución (aislamiento de memoria),
 * mide tiempo, CPU y RSS de todos los procesos de Chrome vía /proc y analiza el MP4.
 *
 * Uso:
 *   node run-benchmark.mjs                       # todo
 *   node run-benchmark.mjs --inputs input-10s-720p --variants A1-webcodecs-h264-aac,B1-ffmpeg-wasm-st
 */
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, measure } from './lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, 'extension');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1].split(',') : fallback;
};
const INPUTS = arg('inputs', ['input-10s-720p', 'input-60s-1080p']);
const ALL = ['A1-webcodecs-h264-aac', 'A2-webcodecs-h264-opus', 'A3-remux-vp9-opus', 'B1-ffmpeg-wasm-st', 'B2-ffmpeg-wasm-mt', 'C-mediarecorder-mp4'];
const VARIANTS = arg('variants', ALL);

if (!existsSync(join(EXT, 'vendor/mediabunny.min.mjs'))) {
  console.error('Falta extension/vendor: ejecuta «node setup.mjs»');
  process.exit(1);
}

async function withBenchPage(fn) {
  const chrome = await launchChrome({ flags: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const { id } = await chrome.send('Extensions.loadUnpacked', { path: EXT });
    const page = await chrome.open(`chrome-extension://${id}/bench.html`);
    for (let i = 0; i < 50 && !(await page.eval('!!window.bench')); i++) await new Promise((r) => setTimeout(r, 100));
    return await fn(page, chrome);
  } finally {
    await chrome.close();
  }
}

const resultsPath = join(HERE, 'results/results.json');
const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : { runs: {}, inputs: {} };
results.environment = {
  date: new Date().toISOString(),
  chrome: 'Google Chrome 155 (headless=new), Linux x86_64, sin aceleración de vídeo por hardware',
  cpu: `${(await import('node:os')).cpus()[0].model} × ${(await import('node:os')).cpus().length}`,
};

console.log('— Comprobación de CSP (MV3)');
results.csp = await withBenchPage((p) => p.eval('bench.cspProbe()'));
console.log('  ', JSON.stringify(results.csp));

for (const inputName of INPUTS) {
  console.log(`\n— Entrada ${inputName}`);
  results.inputs[inputName] = await withBenchPage((p) => p.eval(`bench.analyzeInput('${inputName}')`));
  const ii = results.inputs[inputName];
  console.log(`   ${(ii.size / 1e6).toFixed(1)} MB · ${ii.marks.videoCodec}/${ii.marks.audioCodec} · ${ii.marks.duration.toFixed(2)} s · A/V ${ii.marks.avOffsetMedianMs?.toFixed(0)} ms`);

  for (const variant of VARIANTS) {
    if (variant.startsWith('C-') && !inputName.includes('10s')) continue; // tiempo real: solo la corta
    process.stdout.write(`   ${variant.padEnd(24)} `);
    const run = await withBenchPage(async (page, chrome) => {
      const m = await measure(chrome.proc.pid, () => page.eval(`bench.convert('${variant}', '${inputName}')`));
      if (m.error) return { error: m.error.message.split('\n')[0] };
      const analysis = await page.eval(`bench.analyze('${inputName}')`).catch((e) => ({ error: e.message.split('\n')[0] }));
      const out = join(HERE, 'results', `${inputName}__${variant}.mp4`);
      writeFileSync(out, Buffer.from(await page.eval('bench.outputBase64()'), 'base64'));
      const { result, error, ...resources } = m;
      return { ...result, resources, analysis };
    });
    results.runs[`${inputName}__${variant}`] = run;
    if (run.error) console.log(`✗ ${run.error}`);
    else {
      const a = run.analysis;
      console.log(
        `${(run.convertMs / 1000).toFixed(1).padStart(6)} s · ${(run.outputSize / 1e6).toFixed(1).padStart(5)} MB · ` +
        `RAM pico +${run.resources.rssDeltaMb.toFixed(0)} MB · CPU ${(run.resources.cpuMs / 1000).toFixed(1)} s · ` +
        `${a.marks?.videoCodec}/${a.marks?.audioCodec} · dur ${a.playback?.duration?.toFixed(2)} s · seek ${a.playback?.seeked ? '✓' : '✗'} · ` +
        `A/V ${a.marks?.avOffsetMedianMs?.toFixed(0)} ms (entrada ${a.inputAvOffsetMedianMs?.toFixed(0)}) · PSNR ${a.psnrDb?.toFixed(1)} dB`,
      );
    }
    writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  }
}
console.log(`\n✓ ${resultsPath}`);
