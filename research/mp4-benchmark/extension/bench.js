/**
 * Fase 4A — conversores candidatos WebM → MP4 y analizador común.
 * Se ejecuta DENTRO de una extensión MV3 para respetar sus restricciones reales
 * (CSP, workers, WASM). Todo es local: nada sale del navegador.
 *
 *   window.bench.convert(variant, inputName) → { size, ... } (deja el MP4 en memoria)
 *   window.bench.analyze(inputName)          → métricas del último MP4
 *   window.bench.outputBase64()              → para guardar el MP4 en disco
 */

// --- Instrumentación (solo investigación): cuenta fotogramas y colas de los códecs ---
const codecStats = { decoded: 0, encoded: 0, closedFrames: 0, openFrames: 0, maxOpenFrames: 0, maxInFlight: 0, maxEncodeQueue: 0, maxDecodeQueue: 0, liveDecoders: 0, liveEncoders: 0 };
window.codecStats = codecStats;
{
  const NativeDecoder = globalThis.VideoDecoder;
  globalThis.VideoDecoder = class extends NativeDecoder {
    constructor(init) {
      super({ ...init, output: (frame) => {
        codecStats.decoded++;
        codecStats.maxInFlight = Math.max(codecStats.maxInFlight, codecStats.decoded - codecStats.encoded);
        // Fotogramas decodificados que siguen vivos (ocupan memoria) hasta su close().
        codecStats.openFrames++;
        codecStats.maxOpenFrames = Math.max(codecStats.maxOpenFrames, codecStats.openFrames);
        const nativeClose = frame.close.bind(frame);
        let closed = false;
        frame.close = () => { if (!closed) { closed = true; codecStats.openFrames--; codecStats.closedFrames++; } nativeClose(); };
        init.output(frame);
      } });
      codecStats.liveDecoders++;
    }
    decode(chunk) { codecStats.maxDecodeQueue = Math.max(codecStats.maxDecodeQueue, this.decodeQueueSize); return super.decode(chunk); }
    close() { codecStats.liveDecoders--; return super.close(); }
  };
  const NativeEncoder = globalThis.VideoEncoder;
  globalThis.VideoEncoder = class extends NativeEncoder {
    constructor(init) { super(init); codecStats.liveEncoders++; }
    encode(frame, opts) { codecStats.encoded++; codecStats.maxEncodeQueue = Math.max(codecStats.maxEncodeQueue, this.encodeQueueSize); return super.encode(frame, opts); }
    close() { codecStats.liveEncoders--; return super.close(); }
  };
}

import * as MB from './vendor/mediabunny.min.mjs';

let lastOutput = null;
window.benchTrace = { stage: 'idle', progress: 0, log: '' };
const trace = (stage) => { window.benchTrace.stage = stage; };
const inputCache = new Map();

async function loadInput(name) {
  if (!inputCache.has(name)) {
    const res = await fetch(chrome.runtime.getURL(`inputs/${name}.webm`));
    inputCache.set(name, await res.blob());
  }
  return inputCache.get(name);
}

// ---------------------------------------------------------------------------
// Opción A: WebCodecs + muxer MP4 (Mediabunny)
// ---------------------------------------------------------------------------

async function mediabunnyConvert(blob, { video, audio, aacFallback = false, toDisk = false }) {
  const notes = [];
  if (aacFallback && audio?.codec === 'aac' && !(await MB.canEncodeAudio('aac'))) {
    const { registerAacEncoder } = await import('./vendor/mediabunny-aac-encoder.min.mjs');
    registerAacEncoder();
    notes.push('AAC: WebCodecs no lo soporta → codificador WASM (@mediabunny/aac-encoder)');
  }
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
  // toDisk: el MP4 se escribe incrementalmente en un archivo OPFS (moov al final);
  // si no, se construye entero en memoria (BufferTarget + fastStart 'in-memory').
  let target, fileHandle, writable;
  if (toDisk) {
    const root = await navigator.storage.getDirectory();
    fileHandle = await root.getFileHandle('bench-output.mp4', { create: true });
    writable = await fileHandle.createWritable();
    target = new MB.StreamTarget(writable, { chunked: true, chunkSize: 16 * 1024 * 1024 });
  } else {
    target = new MB.BufferTarget();
  }
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: toDisk ? false : 'in-memory' }), target });
  const conversion = await MB.Conversion.init({ input, output, video, audio });
  if (!conversion.isValid) throw new Error('Conversión no válida: ' + JSON.stringify(conversion.discardedTracks.map((t) => t.reason)));
  if (conversion.discardedTracks.length) notes.push('pistas descartadas: ' + conversion.discardedTracks.map((t) => t.reason).join(', '));
  let lastProgress = 0;
  conversion.onProgress = (p) => { lastProgress = p; window.benchTrace.progress = p; };
  await conversion.execute();
  if (toDisk) {
    // Mediabunny cierra el WritableStream al finalizar; el Blob resultante está respaldado por disco.
    return { blob: await fileHandle.getFile(), notes: [...notes, 'salida incremental a OPFS'], progressReported: lastProgress };
  }
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), notes, progressReported: lastProgress };
}

// ---------------------------------------------------------------------------
// Opción B: FFmpeg.wasm (x264 + AAC nativo de FFmpeg)
// ---------------------------------------------------------------------------

async function ffmpegConvert(blob, { mt, threads = null }) {
  const { FFmpeg } = await import('./vendor/ffmpeg/index.js');
  const ffmpeg = new FFmpeg();
  const base = chrome.runtime.getURL(mt ? 'vendor/core-mt/' : 'vendor/core/');
  const notes = [];
  if (mt && !self.crossOriginIsolated) throw new Error('core-mt requiere crossOriginIsolated (COOP/COEP)');
  ffmpeg.on('log', ({ message }) => { window.benchTrace.log = message; });
  trace('ffmpeg: cargando core');
  const tLoad = performance.now();
  await ffmpeg.load({
    coreURL: base + 'ffmpeg-core.js',
    wasmURL: base + 'ffmpeg-core.wasm',
    ...(mt && { workerURL: base + 'ffmpeg-core.worker.js' }),
  });
  notes.push(`carga del core: ${Math.round(performance.now() - tLoad)} ms`);
  let lastProgress = 0;
  ffmpeg.on('progress', ({ progress }) => { lastProgress = progress; window.benchTrace.progress = progress; });
  trace('ffmpeg: escribiendo entrada');
  await ffmpeg.writeFile('in.webm', new Uint8Array(await blob.arrayBuffer()));
  trace('ffmpeg: convirtiendo');
  // -fps_mode passthrough: los WebM de MediaRecorder tienen frecuencia variable y base de
  // tiempo 1/1000. Sin esto, FFmpeg duplica fotogramas hasta 1000 fps (comprobado).
  const args = ['-i', 'in.webm', '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', ...(threads ? ['-threads', String(threads)] : []), 'out.mp4'];
  const code = await ffmpeg.exec(args);
  if (code !== 0) throw new Error(`ffmpeg salió con código ${code}`);
  const data = await ffmpeg.readFile('out.mp4');
  ffmpeg.terminate();
  return { blob: new Blob([data.buffer], { type: 'video/mp4' }), notes, progressReported: lastProgress };
}

// ---------------------------------------------------------------------------
// Opción C: MediaRecorder grabando MP4 directamente (aquí, reproduciendo el WebM en tiempo real)
// ---------------------------------------------------------------------------

async function mediaRecorderMp4(blob) {
  const mimeType = 'video/mp4;codecs=avc1,opus';
  if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error(`${mimeType} no soportado`);
  const video = document.createElement('video');
  video.src = URL.createObjectURL(blob);
  await new Promise((r) => (video.onloadedmetadata = r));
  const stream = video.captureStream();
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (recorder.onstop = r));
  recorder.start(1000);
  await video.play();
  await new Promise((r) => (video.onended = r));
  recorder.stop();
  await stopped;
  URL.revokeObjectURL(video.src);
  return { blob: new Blob(chunks, { type: 'video/mp4' }), notes: ['tiempo real: dura lo mismo que el vídeo'], progressReported: null };
}

// ---------------------------------------------------------------------------

const VARIANTS = {
  // A: re-codifica a H.264 (WebCodecs) + AAC (WebCodecs o WASM si no hay)
  'A1-webcodecs-h264-aac': (b) => mediabunnyConvert(b, { video: { codec: 'avc', bitrate: MB.QUALITY_HIGH, forceTranscode: true }, audio: { codec: 'aac', bitrate: 128_000 }, aacFallback: true }),
  // A1 escribiendo el MP4 en disco (OPFS) de forma incremental
  'A1s-webcodecs-h264-aac-opfs': (b) => mediabunnyConvert(b, { video: { codec: 'avc', bitrate: MB.QUALITY_HIGH, forceTranscode: true }, audio: { codec: 'aac', bitrate: 128_000 }, aacFallback: true, toDisk: true }),
  // A1 con bitrate medio: para comparar tamaño/calidad con x264
  'A1m-webcodecs-h264-aac-medium': (b) => mediabunnyConvert(b, { video: { codec: 'avc', bitrate: MB.QUALITY_MEDIUM, forceTranscode: true }, audio: { codec: 'aac', bitrate: 128_000 }, aacFallback: true }),
  // A: H.264 + Opus (sin WASM; Opus en MP4 no lo reproduce Apple)
  'A2-webcodecs-h264-opus': (b) => mediabunnyConvert(b, { video: { codec: 'avc', bitrate: MB.QUALITY_HIGH, forceTranscode: true }, audio: { codec: 'opus' } }),
  // A: solo cambia el contenedor (VP9 + Opus copiados a MP4, sin re-codificar)
  'A3-remux-vp9-opus': (b) => mediabunnyConvert(b, { video: {}, audio: {} }),
  'B1-ffmpeg-wasm-st': (b) => ffmpegConvert(b, { mt: false }),
  // Multihilo: con la detección automática de hilos se bloquea en el primer fotograma
  // (comprobado); con 2-4 hilos explícitos funciona.
  'B2-ffmpeg-wasm-mt': (b) => ffmpegConvert(b, { mt: true, threads: 4 }),
  'C-mediarecorder-mp4': (b) => mediaRecorderMp4(b),
};

async function convert(variant, inputName) {
  const input = await loadInput(inputName);
  const t0 = performance.now();
  const { blob, notes, progressReported } = await VARIANTS[variant](input);
  const ms = performance.now() - t0;
  lastOutput = blob;
  return { inputSize: input.size, outputSize: blob.size, convertMs: ms, notes, progressReported };
}

// ---------------------------------------------------------------------------
// Analizador común
// ---------------------------------------------------------------------------

/** Cajas MP4 de primer nivel: orden (moov antes de mdat = faststart) y si es fragmentado. */
async function mp4Boxes(blob) {
  const boxes = [];
  let pos = 0;
  while (pos < blob.size && boxes.length < 2000) {
    const head = new DataView(await blob.slice(pos, pos + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (size === 1) size = Number(head.getBigUint64(8));
    if (size === 0) size = blob.size - pos;
    if (size < 8) break;
    boxes.push(type);
    pos += size;
  }
  const order = boxes.filter((t, i) => i === 0 || t !== boxes[i - 1]);
  return { order: order.slice(0, 8).join(' '), fragmented: boxes.includes('moof'), faststart: boxes.indexOf('moov') < boxes.indexOf('mdat') };
}

async function chromePlayback(blob) {
  const v = document.createElement('video');
  v.muted = true;
  v.src = URL.createObjectURL(blob);
  try {
    await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error(`error de reproducción ${v.error?.code}`)); });
    const duration = v.duration;
    let seeked = false;
    if (Number.isFinite(duration)) {
      v.currentTime = duration * 0.6;
      seeked = await new Promise((r) => { v.onseeked = () => r(true); setTimeout(() => r(false), 5000); });
    }
    let frames = 0;
    const counter = () => { frames++; v.requestVideoFrameCallback(counter); };
    v.requestVideoFrameCallback(counter);
    await v.play();
    await new Promise((r) => setTimeout(r, 1000));
    v.pause();
    return { playable: frames > 5, duration, seeked, width: v.videoWidth, height: v.videoHeight, framesIn1s: frames };
  } finally {
    URL.revokeObjectURL(v.src);
  }
}

async function chromeAudio(blob) {
  try {
    const buf = await new OfflineAudioContext(1, 48000, 48000).decodeAudioData(await blob.arrayBuffer());
    return { decodable: true, duration: buf.duration, channels: buf.numberOfChannels };
  } catch (e) {
    return { decodable: false, error: e.name };
  }
}

/** Tiempos (s) de los destellos blancos y de los pitidos de 1 kHz. */
async function syncMarks(blob) {
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
  const flashes = [];
  const videoTrack = await input.getPrimaryVideoTrack();
  if (videoTrack) {
    const sink = new MB.CanvasSink(videoTrack, { width: 48, height: 27, fit: 'fill' });
    let wasBright = false;
    for await (const { canvas, timestamp } of sink.canvases()) {
      const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 48, 27).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
      const bright = sum / (px.length / 4) / 3 > 200;
      if (bright && !wasBright) flashes.push(timestamp);
      wasBright = bright;
    }
  }
  const beeps = [];
  const audioTrack = await input.getPrimaryAudioTrack();
  let audioCodec = null;
  if (audioTrack) {
    audioCodec = audioTrack.codec;
    const sink = new MB.AudioBufferSink(audioTrack);
    let lastBeep = -10;
    for await (const { buffer, timestamp } of sink.buffers()) {
      const d = buffer.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        if (Math.abs(d[i]) > 0.35) {
          const t = timestamp + i / buffer.sampleRate;
          if (t - lastBeep > 0.5) beeps.push(t);
          lastBeep = t;
        }
      }
    }
  }
  const pairs = [];
  for (const f of flashes) {
    const b = beeps.reduce((best, x) => (Math.abs(x - f) < Math.abs(best - f) ? x : best), Infinity);
    if (Math.abs(b - f) < 0.5) pairs.push({ t: f, ms: (b - f) * 1000 });
  }
  const offsets = pairs.map((p) => p.ms).sort((a, b) => a - b);
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const lastT = pairs.at(-1)?.t ?? 0;
  const windows = {
    start: median(pairs.filter((p) => p.t < 10).map((p) => p.ms)),
    at60s: median(pairs.filter((p) => p.t >= 55 && p.t < 65).map((p) => p.ms)),
    end: median(pairs.filter((p) => p.t > lastT - 10).map((p) => p.ms)),
  };
  const duration = await input.computeDuration();
  return {
    container: (await input.getFormat()).name,
    videoCodec: videoTrack?.codec ?? null,
    audioCodec,
    duration,
    flashes: flashes.length,
    beeps: beeps.length,
    avOffsetMedianMs: offsets.length ? offsets[Math.floor(offsets.length / 2)] : null,
    avOffsetSpreadMs: offsets.length ? offsets.at(-1) - offsets[0] : null,
    avWindows: windows,
    pairs: pairs.length,
  };
}

/** PSNR de luminancia entre entrada y salida en 8 instantes (a 640 px de ancho). */
async function psnr(inputBlob, outputBlob, duration) {
  const sinkFor = async (blob) => {
    const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
    return new MB.CanvasSink(await input.getPrimaryVideoTrack(), { width: 640, height: 360, fit: 'fill' });
  };
  const [a, b] = [await sinkFor(inputBlob), await sinkFor(outputBlob)];
  const luma = (c) => {
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 640, 360).data;
    const y = new Float32Array(d.length / 4);
    for (let i = 0; i < y.length; i++) y[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return y;
  };
  const values = [];
  for (let k = 1; k <= 8; k++) {
    const t = (duration * k) / 9;
    const [ca, cb] = [await a.getCanvas(t), await b.getCanvas(t)];
    if (!ca || !cb) continue;
    const ya = luma(ca.canvas), yb = luma(cb.canvas);
    let mse = 0;
    for (let i = 0; i < ya.length; i++) mse += (ya[i] - yb[i]) ** 2;
    mse /= ya.length;
    values.push(mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse));
  }
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

async function analyze(inputName) {
  const input = await loadInput(inputName);
  const out = lastOutput;
  const [boxes, playback, audio, marks, inputMarks] = [
    await mp4Boxes(out), await chromePlayback(out), await chromeAudio(out), await syncMarks(out), await syncMarks(input),
  ];
  return {
    boxes, playback, audio, marks,
    inputAvOffsetMedianMs: inputMarks.avOffsetMedianMs,
    psnrDb: await psnr(input, out, marks.duration),
  };
}

async function analyzeInput(inputName) {
  const input = await loadInput(inputName);
  lastOutput = input;
  return { size: input.size, playback: await chromePlayback(input), marks: await syncMarks(input) };
}

/** ¿Puede el codificador AAC WASM crear su worker bajo la CSP de MV3? */
async function cspProbe() {
  const result = {};
  try {
    const url = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
    const w = new Worker(url);
    result.blobWorker = await new Promise((r) => { w.onmessage = () => r('permitido'); w.onerror = (e) => r('bloqueado: ' + (e.message || 'error')); setTimeout(() => r('sin respuesta'), 2000); });
  } catch (e) {
    result.blobWorker = 'bloqueado: ' + e.message;
  }
  result.webcodecsAac = await MB.canEncodeAudio('aac');
  result.webcodecsAvc = await MB.canEncodeVideo('avc');
  result.crossOriginIsolated = self.crossOriginIsolated;
  return result;
}

async function outputBase64() {
  const bytes = new Uint8Array(await lastOutput.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Paquetes de vídeo de la entrada y del MP4: ¿se descartan fotogramas al convertir? */
async function packetStats(inputName) {
  const count = async (blob) => {
    const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    const s = await track.computePacketStats();
    return { packets: s.packetCount, avgFps: Math.round(s.averagePacketRate * 10) / 10, durationS: Math.round((await track.computeDuration()) * 100) / 100 };
  };
  return { input: await count(await loadInput(inputName)), output: await count(lastOutput) };
}

/** Diagnóstico de descarte: duraciones de paquetes (demux) y de fotogramas decodificados. */
async function diagnoseFrames(inputName) {
  const input = new MB.Input({ source: new MB.BlobSource(await loadInput(inputName)), formats: MB.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const pk = { count: 0, zeroDuration: 0, durations: {} };
  for await (const p of new MB.EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
    pk.count++;
    if (!(p.duration > 0)) pk.zeroDuration++;
    const key = Math.round(p.duration * 1000);
    pk.durations[key] = (pk.durations[key] ?? 0) + 1;
  }
  const fr = { count: 0, zeroDuration: 0, firstZero: [] };
  for await (const sample of new MB.VideoSampleSink(track).samples()) {
    fr.count++;
    if (!(sample.duration > 0)) { fr.zeroDuration++; if (fr.firstZero.length < 5) fr.firstZero.push(sample.timestamp); }
    sample.close();
  }
  const top = Object.entries(pk.durations).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { packets: { ...pk, durations: Object.fromEntries(top) }, frames: fr };
}

// ---------------------------------------------------------------------------
// Validación del conversor de PRODUCCIÓN (copiado en ./prod por setup.mjs)
// ---------------------------------------------------------------------------

let lastStats = null;
async function prodConvert(inputName, options = {}) {
  const { Mp4Converter } = await import('./prod/conversion/mp4-converter.js');
  const converter = new Mp4Converter();
  const progress = [];
  const controller = new AbortController();
  if (options.cancelAt != null) {
    // Cancela cuando el progreso supere `cancelAt`.
    options.onProgressHook = (p) => { if (p.progress >= options.cancelAt) controller.abort(); };
  }
  const t0 = performance.now();
  try {
    const result = await converter.convert(await loadInput(inputName), {
      id: 'bench-' + inputName,
      quality: options.quality ?? 'auto',
      videoBitrate: options.videoBitrate,
      aacPrimingCompensation: options.aacPrimingCompensation ?? true,
      signal: controller.signal,
      onProgress: (p) => { progress.push({ t: Math.round(performance.now() - t0), ...p }); options.onProgressHook?.(p); },
    });
    lastOutput = result.file;
    window.__last = result.file;
    lastStats = result.stats;
    return { ok: true, stats: result.stats, progressEvents: progress.length, progressSample: progress.filter((_, i) => i % 10 === 0).slice(0, 12), lastProgress: progress.at(-1) };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message, progressEvents: progress.length, lastProgress: progress.at(-1) };
  }
}

async function opfsTemp() {
  const { listTempFiles } = await import('./prod/conversion/temp-files.js');
  return listTempFiles();
}

/** PSNR de luminancia a resolución completa en 6 instantes. */
async function psnrFull(inputName, count = 6) {
  const sinkFor = async (blob) => {
    const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    return { sink: new MB.CanvasSink(track, { width: track.displayWidth, height: track.displayHeight, fit: 'fill' }), w: track.displayWidth, h: track.displayHeight, dur: await input.computeDuration(), t0: await input.getFirstTimestamp() };
  };
  const a = await sinkFor(await loadInput(inputName));
  const b = await sinkFor(lastOutput);
  const luma = (c, w, h) => {
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const y = new Float32Array(d.length / 4);
    for (let i = 0; i < y.length; i++) y[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return y;
  };
  const values = [];
  for (let k = 1; k <= count; k++) {
    const t = (a.dur * k) / (count + 1);
    const [ca, cb] = [await a.sink.getCanvas(a.t0 + t), await b.sink.getCanvas(b.t0 + t)];
    if (!ca || !cb) continue;
    const ya = luma(ca.canvas, a.w, a.h), yb = luma(cb.canvas, a.w, a.h);
    let mse = 0;
    for (let i = 0; i < ya.length; i++) mse += (ya[i] - yb[i]) ** 2;
    mse /= ya.length;
    values.push(mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse));
  }
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Recorte de un fotograma (PNG base64) para inspección visual. */
async function frameCrop(which, inputName, t, x, y, w, h) {
  const blob = which === 'input' ? await loadInput(inputName) : lastOutput;
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const sink = new MB.CanvasSink(track, { width: track.displayWidth, height: track.displayHeight, fit: 'fill' });
  const { canvas } = await sink.getCanvas((await input.getFirstTimestamp()) + t);
  const out = new OffscreenCanvas(w, h);
  out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  const bytes = new Uint8Array(await (await out.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Analiza un archivo cualquiera de inputs/ (p. ej. el MP4 que generó la extensión). */
async function analyzeFile(name) {
  const res = await fetch(chrome.runtime.getURL(`inputs/${name}`));
  const blob = await res.blob();
  lastOutput = blob;
  return {
    size: blob.size,
    boxes: await mp4Boxes(blob),
    playback: await chromePlayback(blob),
    audio: await chromeAudio(blob),
    marks: await syncMarks(blob),
  };
}

function stats() {
  return { ...codecStats, progress: window.benchTrace.progress, jsHeapMb: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null };
}

/** Suelta las referencias del benchmark (MP4 y entradas) para ver qué queda retenido. */
async function release() {
  lastOutput = null;
  inputCache.clear();
  try { await (await navigator.storage.getDirectory()).removeEntry('bench-output.mp4'); } catch { /* no existe */ }
  return true;
}

window.bench = { analyzeFile, prodConvert, opfsTemp, psnrFull, frameCrop, diagnoseFrames, packetStats, stats, release, convert, analyze, analyzeInput, cspProbe, outputBase64, variants: Object.keys(VARIANTS) };
document.getElementById('status').textContent = 'preparado';
