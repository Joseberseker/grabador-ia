#!/usr/bin/env node
/**
 * Fase 4A — prueba de memoria de WebCodecs H.264 + AAC en conversiones largas.
 *
 *   node memory-test.mjs <variante> <entrada> [<entrada>…]
 *   p. ej. node memory-test.mjs A1-webcodecs-h264-aac input-10s-720p input-180s-1080p
 *
 * Fases: reposo (5 s) → conversión (muestras cada 0,5 s) → al terminar →
 * 60 s después → soltar referencias + GC forzado.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sampleProcesses, sleep } from './lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const [variant, ...inputs] = process.argv.slice(2);
const r1 = (n) => Math.round(n);

for (const inputName of inputs) {
  const chrome = await launchChrome();
  const pid = chrome.proc.pid;
  try {
    const { id } = await chrome.send('Extensions.loadUnpacked', { path: resolve(HERE, 'extension') });
    const page = await chrome.open(`chrome-extension://${id}/bench.html`);
    const gc = () => chrome.send('HeapProfiler.collectGarbage', {}, page.sessionId);
    const pageStats = () => Promise.race([page.eval('bench.stats()'), sleep(400).then(() => null)]).catch(() => null);
    const snap = async (label) => ({ label, t: 0, ...sampleProcesses(pid), page: await pageStats() });

    // Reposo hasta que la RAM se estabilice: justo tras cargar, el renderer ocupa ~500 MB
    // y Chrome lo reduce solo a ~150 MB en menos de un minuto (comprobado).
    await sleep(45000);
    await gc();
    await sleep(2000);
    const before = await snap('antes');

    // Conversión con muestreo periódico.
    const series = [];
    const t0 = Date.now();
    let done = false;
    const sampler = (async () => {
      while (!done) {
        series.push({ t: (Date.now() - t0) / 1000, ...sampleProcesses(pid), page: await pageStats() });
        await sleep(500);
      }
    })();
    const result = await page.eval(`bench.convert('${variant}', '${inputName}')`);
    done = true;
    await sampler;
    const convertS = (Date.now() - t0) / 1000;
    const after = await snap('al terminar');

    // 60 s después (sin tocar nada): ¿Chrome libera por sí solo?
    const tail = [];
    for (let s = 0; s < 60; s += 5) {
      await sleep(5000);
      tail.push({ t: s + 5, ...sampleProcesses(pid) });
    }
    const after60 = { label: '60 s después', ...tail.at(-1), page: await pageStats() };

    const packets = await page.eval(`bench.packetStats('${inputName}')`).catch((e) => ({ error: e.message }));

    // Soltar el MP4 y la entrada (lo que una integración real haría tras descargar) + GC.
    await page.eval('bench.release()');
    await gc();
    await sleep(5000);
    const released = await snap('tras soltar referencias + GC');

    const peak = series.reduce((m, x) => (x.totalMb > m.totalMb ? x : m), series[0] ?? after);
    const report = {
      variant, inputName, packets, inputMb: result.inputSize / 1e6, outputMb: result.outputSize / 1e6, convertS,
      before, peak, after, after60, released, series, tail,
      codecs: series.at(-1)?.page ?? after.page,
    };
    writeFileSync(join(HERE, 'results', `memory__${inputName}__${variant}.json`), JSON.stringify(report, null, 2));
    const d = (x) => `${r1(x.totalMb)} MB (+${r1(x.totalMb - before.totalMb)})`;
    console.log(`\n${inputName} · ${variant}`);
    console.log(`  entrada ${report.inputMb.toFixed(1)} MB → salida ${report.outputMb.toFixed(1)} MB en ${convertS.toFixed(1)} s`);
    console.log(`  RAM total   antes ${r1(before.totalMb)} MB · pico ${d(peak)} a los ${peak.t?.toFixed(1)} s · al terminar ${d(after)} · 60 s después ${d(after60)} · tras soltar+GC ${d(released)}`);
    console.log(`  renderer extensión: antes ${r1(before.extensionMb)} · pico ${r1(peak.extensionMb)} · 60 s ${r1(after60.extensionMb)} · soltar+GC ${r1(released.extensionMb)} MB | GPU pico ${r1(peak.gpuMb)} MB`);
    console.log(`  paquetes de vídeo: entrada ${packets.input?.packets} (${packets.input?.avgFps} fps) → salida ${packets.output?.packets} (${packets.output?.avgFps} fps) · duración ${packets.input?.durationS} → ${packets.output?.durationS} s`);
    const c = report.codecs ?? {};
    console.log(`  fotogramas: decodificados ${c.decoded} · codificados ${c.encoded} · abiertos máx ${c.maxOpenFrames ?? '—'} (al final ${c.openFrames ?? '—'}) · decod−cod máx ${c.maxInFlight} · cola encoder máx ${c.maxEncodeQueue} · cola decoder máx ${c.maxDecodeQueue} · heap JS ${c.jsHeapMb?.toFixed(0)} MB`);
  } catch (e) {
    console.log(`${inputName}: ERROR ${e.message.split('\n')[0]}`);
  } finally {
    await chrome.close();
  }
}
