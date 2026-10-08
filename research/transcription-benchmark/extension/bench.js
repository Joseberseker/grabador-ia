/** Fase 6 — prototipo: Whisper (transformers.js + ONNX Runtime Web) dentro de una extensión MV3. */
import { pipeline, env } from './vendor/transformers.min.js';

env.allowLocalModels = false;            // pesos del modelo: Hugging Face (datos), cacheados en Cache Storage
// Runtime WASM empaquetado (es código: MV3 no permite descargarlo). Variante solo-CPU (14 MB).
env.backends.onnx.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.mjs'),
  wasm: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.wasm'),
};
window.trace = [];

/** Audio de prueba → Float32 16 kHz mono (lo que espera Whisper). */
async function loadAudio(name, seconds) {
  const buf = await (await fetch(chrome.runtime.getURL('audio/' + name))).arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(buf);
  const length = Math.min(decoded.length, Math.round(seconds * decoded.sampleRate));
  const ctx = new OfflineAudioContext(1, Math.round((length / decoded.sampleRate) * 16000), 16000);
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  src.connect(ctx.destination);
  src.start(0, 0, length / decoded.sampleRate);
  return { pcm: (await ctx.startRendering()).getChannelData(0), totalSeconds: decoded.duration };
}

window.run = async ({ model, dtype = 'q8', device = 'wasm', seconds = 60, threads = null }) => {
  if (threads) env.backends.onnx.wasm.numThreads = threads;
  const t0 = performance.now();
  const asr = await pipeline('automatic-speech-recognition', model, {
    dtype, device,
    progress_callback: (p) => { if (p.status === 'progress' && p.progress >= 99.9) window.trace.push(`${p.file} ${Math.round(p.total / 1e6)} MB`); },
  });
  const loadMs = performance.now() - t0;
  const { pcm, totalSeconds } = await loadAudio('judit.ogg', seconds);
  const t1 = performance.now();
  const out = await asr(pcm, { language: 'spanish', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
  const inferMs = performance.now() - t1;
  await asr.dispose?.();
  return {
    model, dtype, device, audioSeconds: pcm.length / 16000, totalSeconds,
    loadMs: Math.round(loadMs), inferMs: Math.round(inferMs), rtf: +(inferMs / 1000 / (pcm.length / 16000)).toFixed(2),
    threads: env.backends.onnx.wasm.numThreads, coi: self.crossOriginIsolated,
    files: window.trace.splice(0),
    text: out.text,
    chunks: (out.chunks ?? []).slice(0, 6).map((c) => ({ t: c.timestamp, text: c.text })),
    chunkCount: out.chunks?.length ?? 0,
  };
};
document.getElementById('s').textContent = 'preparado';
