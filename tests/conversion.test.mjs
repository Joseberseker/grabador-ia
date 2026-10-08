import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Mp4Converter, h264Supported, nativeAacSupported } from '../src/conversion/mp4-converter.js';
import { ConversionError, ConversionPhase } from '../src/conversion/video-converter.js';
import {
  TrackPacer,
  aacPrimingSeconds,
  checkSpace,
  estimateEtaMs,
  estimateMp4Bytes,
  frameDuration,
  h264Bitrate,
  maxAacPackets,
  maxVideoPackets,
  monotonicTimestamp,
  requiredTempBytes,
  FIXED_MARGIN_BYTES,
  h264CodecString,
  h264Level,
  lowFpsNote,
  nominalFps,
  raiseAvcLevel,
} from '../src/conversion/conversion-plan.js';

// ---------------------------------------------------------------------------
// Mediabunny falso: reproduce lo que vimos en WebM reales de MediaRecorder
// (algunos paquetes con duración demuxada 0) sin necesitar navegador.
// ---------------------------------------------------------------------------

/** 30 fps con intervalos variables; cada 13.º fotograma con duración 0 (≈ 7,7 %). */
function realisticVideo(n, start = 0.007) {
  const timestamps = [];
  let t = start;
  for (let i = 0; i < n; i++) {
    timestamps.push(Math.round(t * 1000) / 1000);
    t += i % 7 === 3 ? 0.016 : 0.034; // intervalos variables, mínimo 16 ms
  }
  const durations = timestamps.map((ts, i) => (i % 13 === 12 || i === n - 1 ? 0 : timestamps[i + 1] - ts));
  return { timestamps, durations };
}

function fakeMediabunny({ video, audio = null, failAtVideoFrame = null, onVideoAdd = null, canEncodeVideo = true, fps = 29.5, corrupt = false, noVideo = false } = {}) {
  const log = { videoAdded: [], audioAdded: [], created: 0, closed: 0, cancelled: false, finalized: false, options: null };
  class Sample {
    constructor(timestamp, duration) {
      this.timestamp = timestamp;
      this.duration = duration;
      this.isClosed = false;
      log.created++;
    }
    setTimestamp(t) { this.timestamp = t; }
    setDuration(d) { this.duration = d; }
    close() { if (!this.isClosed) { this.isClosed = true; log.closed++; } }
  }
  const duration = Math.max(video.timestamps.at(-1) + 1 / 30, audio ? audio.timestamps.at(-1) + 0.02 : 0);
  const videoTrack = {
    displayWidth: 1280, displayHeight: 720, codec: 'vp9',
    canDecode: async () => true,
    computePacketStats: async () => ({ packetCount: video.timestamps.length, averagePacketRate: fps }),
  };
  const audioTrack = audio && { numberOfChannels: 2, sampleRate: 48000, canDecode: async () => true };
  const first = Math.min(video.timestamps[0], audio ? audio.timestamps[0] : Infinity);
  const mb = {
    ALL_FORMATS: [],
    BlobSource: class {},
    Input: class {
      getPrimaryVideoTrack = async () => {
        if (corrupt) throw new Error('EBML header inválido');
        return noVideo ? null : videoTrack;
      };
      getPrimaryAudioTrack = async () => audioTrack;
      computeDuration = async () => duration;
      getFirstTimestamp = async () => first;
      dispose() { log.disposed = true; }
    },
    VideoSampleSink: class { async *samples() { for (let i = 0; i < video.timestamps.length; i++) yield new Sample(video.timestamps[i], video.durations[i]); } },
    AudioSampleSink: class { async *samples() { for (const t of audio.timestamps) yield new Sample(t, 0.02); } },
    VideoSampleSource: class {
      constructor(config) { this.config = config; log.videoConfig = config; }
      async add(sample) {
        if (log.cancelled) throw new Error('Output canceled');
        if (failAtVideoFrame === log.videoAdded.length) throw new Error('fallo del codificador');
        log.videoAdded.push({ timestamp: sample.timestamp, duration: sample.duration });
        this.config.onEncodedPacket?.();
        await onVideoAdd?.(log.videoAdded.length);
        await new Promise((r) => setImmediate(r));
      }
      close() { log.videoClosed = true; }
    },
    AudioSampleSource: class {
      constructor(config) { this.config = config; }
      async add(sample) {
        if (log.cancelled) throw new Error('Output canceled');
        log.audioAdded.push({ timestamp: sample.timestamp });
        this.config.onEncodedPacket?.();
        await new Promise((r) => setImmediate(r));
      }
      close() { log.audioClosed = true; }
    },
    Mp4OutputFormat: class { constructor(options) { log.formatOptions = options; } },
    StreamTarget: class { constructor(writable) { log.writable = writable; } },
    Output: class {
      constructor(options) { log.options = options; }
      addVideoTrack(source, meta) { log.videoMeta = meta; }
      addAudioTrack(source, meta) { log.audioMeta = meta; }
      async start() { log.started = true; }
      async finalize() { log.finalized = true; }
      async cancel() { log.cancelled = true; }
    },
    canEncodeVideo: async () => canEncodeVideo,
  };
  return { mb, log };
}

function fakeTempFiles() {
  const files = new Map();
  const api = {
    files,
    created: 0,
    async createTempFile(id) {
      api.created++;
      const entry = { aborted: false };
      files.set(id, entry);
      return {
        handle: { getFile: async () => new File([new Uint8Array(1234)], `${id}.mp4`, { type: 'video/mp4' }) },
        writable: { abort: async () => { entry.aborted = true; } },
      };
    },
    async removeTempFile(id) { return files.delete(id); },
  };
  return api;
}

const plenty = async () => ({ quota: 50e9, usage: 1e9 });
const converterFor = (mb, tempFiles, nativeAac = false, videoSupport = async () => true) =>
  new Mp4Converter({
    loadMediabunny: async () => mb,
    tempFiles,
    nativeAac: async () => nativeAac,
    videoSupport,
    loadAacEncoder: async () => ({ registerAacEncoder() {} }),
  });

// ---------------------------------------------------------------------------

describe('Mp4Converter (con Mediabunny falso)', () => {
  test('1/12. WebM → MP4: N fotogramas de entrada → N de salida, aunque haya duraciones 0', async () => {
    const video = realisticVideo(300);
    assert.ok(video.durations.filter((d) => d === 0).length >= 23, 'el caso de prueba incluye duraciones 0');
    const { mb, log } = fakeMediabunny({ video });
    const temp = fakeTempFiles();
    const result = await converterFor(mb, temp).convert(new Blob(['webm']), { id: 'rec1', storageEstimate: plenty });

    assert.equal(log.videoAdded.length, 300, 'no se descarta ningún fotograma');
    assert.equal(result.stats.inputVideoFrames, 300);
    assert.equal(result.stats.convertedVideoFrames, 300);
    assert.equal(result.stats.encodedVideoPackets, 300);
    // Duraciones recalculadas desde el siguiente fotograma, todas > 0.
    for (let i = 0; i < 299; i++) {
      assert.ok(Math.abs(log.videoAdded[i].duration - (video.timestamps[i + 1] - video.timestamps[i])) < 1e-9, `duración ${i}`);
    }
    assert.ok(log.videoAdded.at(-1).duration > 0, 'el último fotograma usa la duración media');
    // Timestamps relativos al inicio y estrictamente crecientes.
    assert.equal(log.videoAdded[0].timestamp, 0);
    for (let i = 1; i < 300; i++) assert.ok(log.videoAdded[i].timestamp > log.videoAdded[i - 1].timestamp);
    // Salida incremental con índice al principio (sin BufferTarget / in-memory).
    assert.equal(log.formatOptions.fastStart, 'reserve');
    assert.ok(log.writable, 'StreamTarget sobre el archivo temporal');
    assert.ok(log.videoMeta.maximumPacketCount >= 300);
    assert.equal(log.videoConfig.codec, 'avc');
    assert.ok(log.finalized && log.videoClosed);
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(temp.files.size, 1, 'el temporal se conserva hasta la descarga');
    assert.equal(log.created, log.closed, 'todos los fotogramas se cierran');
  });

  test('2. vídeo sin audio: una sola pista y sin AAC', async () => {
    const { mb, log } = fakeMediabunny({ video: realisticVideo(30) });
    const result = await converterFor(mb, fakeTempFiles()).convert(new Blob(['w']), { id: 'r', storageEstimate: plenty });
    assert.equal(log.audioMeta, undefined);
    assert.equal(result.stats.audioCodec, null);
    assert.equal(result.stats.aacBackend, null);
  });

  test('3/11. vídeo + audio: AAC WASM adelanta el audio el priming (1024 muestras); AAC nativo no', async () => {
    const audio = { timestamps: Array.from({ length: 50 }, (_, i) => i * 0.02) };
    const video = realisticVideo(30, 0);

    const wasm = fakeMediabunny({ video, audio });
    const r1 = await converterFor(wasm.mb, fakeTempFiles(), false).convert(new Blob(['w']), { id: 'a', storageEstimate: plenty });
    assert.equal(r1.stats.aacBackend, 'wasm');
    assert.ok(Math.abs(wasm.log.audioAdded[0].timestamp - -1024 / 48000) < 1e-9, 'audio adelantado ≈ 21,3 ms');
    assert.equal(wasm.log.audioAdded.length, 50);
    assert.ok(wasm.log.audioMeta.maximumPacketCount > 0);

    const native = fakeMediabunny({ video, audio });
    const r2 = await converterFor(native.mb, fakeTempFiles(), true).convert(new Blob(['w']), { id: 'b', storageEstimate: plenty });
    assert.equal(r2.stats.aacBackend, 'webcodecs');
    assert.equal(native.log.audioAdded[0].timestamp, 0, 'sin compensación con AAC nativo');
  });

  test('4. la duración total de los fotogramas coincide con la de la entrada', async () => {
    const video = realisticVideo(120);
    const { mb, log } = fakeMediabunny({ video });
    await converterFor(mb, fakeTempFiles()).convert(new Blob(['w']), { id: 'd', storageEstimate: plenty });
    const total = log.videoAdded.reduce((s, f) => s + f.duration, 0);
    const expected = video.timestamps.at(-1) - video.timestamps[0] + 1 / 29.5;
    assert.ok(Math.abs(total - expected) < 0.001, `${total} ≈ ${expected}`);
  });

  test('6/8. cancelar a mitad: ConversionError(cancelled), encoders cancelados, temporal borrado, fotogramas cerrados', async () => {
    const controller = new AbortController();
    const { mb, log } = fakeMediabunny({
      video: realisticVideo(200),
      audio: { timestamps: Array.from({ length: 300 }, (_, i) => i * 0.02) },
      onVideoAdd: (n) => { if (n === 80) controller.abort(); },
    });
    const temp = fakeTempFiles();
    await assert.rejects(
      converterFor(mb, temp).convert(new Blob(['w']), { id: 'c', signal: controller.signal, storageEstimate: plenty }),
      (e) => e instanceof ConversionError && e.code === 'cancelled',
    );
    assert.ok(log.cancelled, 'Output.cancel() detiene los codificadores');
    assert.ok(!log.finalized, 'no se genera un MP4 parcial');
    assert.equal(temp.files.size, 0, 'temporal eliminado');
    assert.ok(log.videoAdded.length < 200);
    assert.equal(log.created, log.closed, 'ningún fotograma queda abierto');
  });

  test('6. cancelar antes de empezar no crea ningún temporal', async () => {
    const controller = new AbortController();
    controller.abort();
    const { mb } = fakeMediabunny({ video: realisticVideo(10) });
    const temp = fakeTempFiles();
    await assert.rejects(converterFor(mb, temp).convert(new Blob(['w']), { id: 'x', signal: controller.signal }), { code: 'cancelled' });
    assert.equal(temp.created, 0);
  });

  test('7/8. error del codificador: ConversionError(failed) y temporal borrado', async () => {
    const { mb, log } = fakeMediabunny({ video: realisticVideo(50), failAtVideoFrame: 10 });
    const temp = fakeTempFiles();
    await assert.rejects(
      converterFor(mb, temp).convert(new Blob(['w']), { id: 'e', storageEstimate: plenty }),
      (e) => e instanceof ConversionError && e.code === 'failed' && /fallo del codificador/.test(e.message),
    );
    assert.equal(temp.files.size, 0);
    assert.ok(log.cancelled);
    assert.equal(log.created, log.closed);
  });

  test('sin espacio suficiente: no empieza y explica cuánto hace falta', async () => {
    const { mb } = fakeMediabunny({ video: realisticVideo(30) });
    const temp = fakeTempFiles();
    await assert.rejects(
      converterFor(mb, temp).convert(new Blob(['w']), { id: 's', storageEstimate: async () => ({ quota: 100e6, usage: 90e6 }) }),
      (e) => e.code === 'no-space' && /MB/.test(e.message),
    );
    assert.equal(temp.created, 0, 'no se crea el temporal');
  });

  test('sin H.264 disponible: ConversionError(unsupported) sin crear temporal', async () => {
    const { mb } = fakeMediabunny({ video: realisticVideo(10) });
    const temp = fakeTempFiles();
    await assert.rejects(
      converterFor(mb, temp, false, async () => false).convert(new Blob(['w']), { id: 'u', storageEstimate: plenty }),
      { code: 'unsupported' },
    );
    assert.equal(temp.created, 0);
  });

  test('60 fps: nivel H.264 4.2 y FPS se piden al codificador; si no los admite, error claro (sin bajar a 30 en silencio)', async () => {
    const video = { timestamps: Array.from({ length: 120 }, (_, i) => i / 60), durations: Array(120).fill(1 / 60) };
    const asked = [];
    const support = async (cfg) => { asked.push(cfg); return true; };
    const ok = fakeMediabunny({ video, fps: 59.8 });
    ok.mb.Input = class extends ok.mb.Input {};
    const r = await converterFor(ok.mb, fakeTempFiles(), false, support).convert(new Blob(['w']), { id: 'f', storageEstimate: plenty });
    // Vídeo falso de 1280×720 a 60 fps → nivel 3.2 (0x20).
    assert.equal(asked[0].fps, 60);
    assert.equal(asked[0].codec, 'avc1.640020');
    assert.equal(ok.log.videoConfig.fullCodecString, 'avc1.640020');
    assert.equal(r.stats.targetFps, 60);
    assert.equal(ok.log.videoAdded.length, 120, '60 fps → 60 fps: los 120 fotogramas');

    const no = fakeMediabunny({ video, fps: 59.8 });
    await assert.rejects(
      converterFor(no.mb, fakeTempFiles(), false, async () => false).convert(new Blob(['w']), { id: 'g', storageEstimate: plenty }),
      (e) => e.code === 'unsupported' && /60 fps/.test(e.message) && /WebM/.test(e.message),
    );
  });

  test('12. duración 0 en el PRIMER y en el ÚLTIMO fotograma, y timestamps variables a 60 fps', async () => {
    const timestamps = [0, 0.016, 0.033, 0.034, 0.05, 0.083, 0.1, 0.116];
    const durations = [0, 0.017, 0, 0.016, 0.033, 0, 0.016, 0];
    const { mb, log } = fakeMediabunny({ video: { timestamps, durations }, fps: 60 });
    const r = await converterFor(mb, fakeTempFiles()).convert(new Blob(['w']), { id: 'z', storageEstimate: plenty });
    assert.equal(log.videoAdded.length, timestamps.length);
    assert.equal(r.stats.convertedVideoFrames, timestamps.length);
    assert.ok(log.videoAdded.every((f) => f.duration > 0), 'ninguna duración 0 llega al codificador');
    assert.ok(Math.abs(log.videoAdded[0].duration - 0.016) < 1e-9, 'primer fotograma: hasta el siguiente');
    assert.ok(Math.abs(log.videoAdded[2].duration - 0.001) < 1e-9, 'intervalo de 1 ms conservado');
    assert.ok(Math.abs(log.videoAdded.at(-1).duration - 1 / 60) < 1e-9, 'último fotograma: duración nominal');
  });

  for (const percent of [1, 25, 50, 75, 99]) {
    test(`9. cancelar al ${percent} %: sin finalize, sin temporal, sin fotogramas abiertos`, async () => {
      const total = 200;
      const at = Math.max(1, Math.round((total * percent) / 100));
      const controller = new AbortController();
      const { mb, log } = fakeMediabunny({
        video: realisticVideo(total),
        audio: { timestamps: Array.from({ length: 400 }, (_, i) => i * 0.02) },
        onVideoAdd: (n) => { if (n === at) controller.abort(); },
      });
      const temp = fakeTempFiles();
      await assert.rejects(
        converterFor(mb, temp).convert(new Blob(['w']), { id: `c${percent}`, signal: controller.signal, storageEstimate: plenty }),
        { code: 'cancelled' },
      );
      assert.ok(log.cancelled && !log.finalized);
      assert.equal(temp.files.size, 0);
      assert.equal(log.created, log.closed);
      assert.ok(log.videoAdded.length <= at + 1);
    });
  }

  test('10. WebM corrupto: ConversionError(failed) y sin temporal', async () => {
    const { mb } = fakeMediabunny({ video: realisticVideo(10), corrupt: true });
    const temp = fakeTempFiles();
    await assert.rejects(converterFor(mb, temp).convert(new Blob(['basura']), { id: 'k', storageEstimate: plenty }), (e) => e.code === 'failed' && /EBML/.test(e.message));
    assert.equal(temp.created, 0);
  });

  test('10. WebM sin pista de vídeo: ConversionError(unsupported)', async () => {
    const { mb } = fakeMediabunny({ video: realisticVideo(10), noVideo: true });
    await assert.rejects(converterFor(mb, fakeTempFiles()).convert(new Blob(['w']), { id: 'n', storageEstimate: plenty }), { code: 'unsupported' });
  });

  test('10. progreso: preparing → converting (creciente, ≤ 1) → finalizing', async () => {
    const events = [];
    const { mb } = fakeMediabunny({ video: realisticVideo(60), onVideoAdd: () => new Promise((r) => setTimeout(r, 6)) });
    await converterFor(mb, fakeTempFiles()).convert(new Blob(['w']), { id: 'p', storageEstimate: plenty, onProgress: (p) => events.push(p) });
    const phases = [...new Set(events.map((e) => e.phase))];
    assert.deepEqual(phases, [ConversionPhase.PREPARING, ConversionPhase.CONVERTING, ConversionPhase.FINALIZING]);
    const converting = events.filter((e) => e.phase === ConversionPhase.CONVERTING).map((e) => e.progress);
    assert.ok(converting.length >= 2);
    for (let i = 1; i < converting.length; i++) assert.ok(converting[i] >= converting[i - 1]);
    assert.ok(converting.every((p) => p >= 0 && p <= 1));
    assert.equal(events.at(-1).progress, 1);
  });

  test('exige un id para el temporal', async () => {
    await assert.rejects(new Mp4Converter().convert(new Blob(['w']), {}), TypeError);
  });
});

// ---------------------------------------------------------------------------
// Cálculos puros
// ---------------------------------------------------------------------------

describe('Plataforma: selección de códecs (13)', () => {
  const withGlobal = async (name, value, fn) => {
    const previous = globalThis[name];
    globalThis[name] = value;
    try { return await fn(); } finally { if (previous === undefined) delete globalThis[name]; else globalThis[name] = previous; }
  };
  const track = { numberOfChannels: 2, sampleRate: 48000 };

  test('AAC nativo (Windows/macOS): WebCodecs lo admite → «webcodecs» (sin compensación de priming)', async () => {
    const seen = [];
    await withGlobal('AudioEncoder', { isConfigSupported: async (c) => { seen.push(c); return { supported: true }; } }, async () => {
      assert.equal(await nativeAacSupported(track, 128_000), true);
    });
    assert.deepEqual(seen[0], { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000, bitrate: 128_000 });
  });

  test('Linux: WebCodecs no admite AAC, lanza o no existe → WASM', async () => {
    await withGlobal('AudioEncoder', { isConfigSupported: async () => ({ supported: false }) }, async () => {
      assert.equal(await nativeAacSupported(track, 128_000), false);
    });
    await withGlobal('AudioEncoder', { isConfigSupported: async () => { throw new TypeError('codec'); } }, async () => {
      assert.equal(await nativeAacSupported(track, 128_000), false);
    });
    await withGlobal('AudioEncoder', undefined, async () => assert.equal(await nativeAacSupported(track, 128_000), false));
  });

  test('H.264: se consulta a WebCodecs con codec, resolución, FPS y bitrate exactos', async () => {
    const seen = [];
    await withGlobal('VideoEncoder', { isConfigSupported: async (c) => { seen.push(c); return { supported: c.framerate <= 30 }; } }, async () => {
      assert.equal(await h264Supported({ codec: 'avc1.640028', width: 1920, height: 1080, fps: 30, bitrate: 3e6 }), true);
      assert.equal(await h264Supported({ codec: 'avc1.64002a', width: 1920, height: 1080, fps: 60, bitrate: 6e6 }), false);
    });
    assert.equal(seen[1].codec, 'avc1.64002a');
    assert.equal(seen[1].framerate, 60);
    await withGlobal('VideoEncoder', undefined, async () => assert.equal(await h264Supported({ codec: 'x', width: 1, height: 1, fps: 30, bitrate: 1 }), false));
  });
});

describe('Plan de conversión', () => {
  test('2. nivel H.264 según FPS: 720p30 3.1 · 720p60 3.2 · 1080p30 4.0 · 1080p60 4.2', () => {
    const lv = (width, height, fps) => h264Level({ width, height, fps, bitrate: h264Bitrate({ width, height, fps, quality: 'max' }) }).name;
    assert.equal(lv(1280, 720, 30), '3.1');
    assert.equal(lv(1280, 720, 60), '3.2');
    assert.equal(lv(1920, 1080, 30), '4.0');
    assert.equal(lv(1920, 1080, 60), '4.2');
    assert.equal(lv(1918, 992, 60), '4.2');
    assert.equal(lv(2560, 1440, 30), '5.0');
    assert.equal(h264CodecString({ width: 1920, height: 1080, fps: 60, bitrate: 6e6 }), 'avc1.64002a');
    assert.equal(h264CodecString({ width: 1920, height: 1080, fps: 30, bitrate: 3e6 }), 'avc1.640028');
    assert.equal(h264CodecString({ width: 8192, height: 8192, fps: 60, bitrate: 1e6 }), null, 'fuera de rango → null');
    assert.equal(nominalFps(59.8), 60);
    assert.equal(nominalFps(29.2), 30);
    assert.equal(nominalFps(41), 30);
  });

  test('raiseAvcLevel: sube avcC[3] y el level_idc del SPS (720p60: 3.1 → 3.2), nunca baja', () => {
    // avcC real de Chrome (perfil High, constraint 0x0c, nivel 3.1) con 1 SPS y 1 PPS.
    const sps = [0x67, 0x64, 0x0c, 0x1f, 0xac, 0xd9, 0x40];
    const pps = [0x68, 0xeb, 0xe3, 0xcb];
    const avcc = Uint8Array.from([1, 0x64, 0x0c, 0x1f, 0xff, 0xe1, 0, sps.length, ...sps, 1, 0, pps.length, ...pps]);
    const r = raiseAvcLevel(avcc, 0x20);
    assert.equal(r.codec, 'avc1.640c20');
    assert.equal(r.description[3], 0x20, 'AVCLevelIndication');
    assert.equal(r.description[8 + 3], 0x20, 'level_idc del SPS');
    assert.deepEqual([...r.description.slice(8 + 4)], [...avcc.slice(8 + 4)], 'el resto intacto');
    assert.equal(avcc[3], 0x1f, 'no muta el buffer original');
    assert.equal(raiseAvcLevel(avcc, 0x1f), null, 'mismo nivel: nada');
    assert.equal(raiseAvcLevel(avcc, 0x1e), null, 'nunca baja');
    assert.equal(raiseAvcLevel(avcc.buffer, 0x2a).codec, 'avc1.640c2a', 'acepta ArrayBuffer');
    assert.equal(raiseAvcLevel(Uint8Array.from([0, 1, 2]), 0x2a), null, 'formato inesperado → null');
  });

  test('aviso de FPS: 60 pedidos y ~32 entregados → se informa; 60 → nada; 30 pedidos → nada', () => {
    assert.match(lowFpsNote(60, 32.4), /~32 fps/);
    assert.equal(lowFpsNote(60, 58.7), null);
    assert.equal(lowFpsNote(30, 20), null);
    assert.equal(lowFpsNote(60, undefined), null);
  });

  test('13/14. bitrate H.264 inicial para 720p y 1080p (0,06 bpp en «auto»)', () => {
    assert.equal(h264Bitrate({ width: 1280, height: 720, fps: 30 }), 1_658_880);
    assert.equal(h264Bitrate({ width: 1920, height: 1080, fps: 30 }), 3_732_480);
    assert.ok(h264Bitrate({ width: 1920, height: 1080, fps: 30, quality: 'high' }) > 5_000_000);
    assert.ok(h264Bitrate({ width: 1920, height: 1080, fps: 60, quality: 'max' }) <= 20_000_000, 'techo');
    assert.equal(h264Bitrate({ width: 320, height: 180, fps: 30 }), 500_000, 'mínimo');
    assert.equal(h264Bitrate({ width: 1280, height: 720, fps: 0 }), 1_658_880, 'fps desconocidos → 30');
  });

  test('espacio: MP4 estimado × 1,25 + 64 MB; sin espacio → ok=false', () => {
    const est = estimateMp4Bytes({ durationS: 600, videoBitrate: 3_732_480, audioBitrate: 128_000 });
    assert.equal(est, 289_536_000);
    const req = requiredTempBytes(est);
    assert.equal(req, Math.ceil(est * 1.25) + FIXED_MARGIN_BYTES);
    assert.deepEqual(checkSpace({ quota: 1e9, usage: 0 }, req).ok, true);
    assert.deepEqual(checkSpace({ quota: req, usage: 1 }, req).ok, false);
    assert.equal(checkSpace({}, 10).available, 0);
  });

  test('duración de fotograma y timestamps crecientes', () => {
    assert.equal(frameDuration(1, 1.034, 0.033), 1.034 - 1);
    assert.equal(frameDuration(1, 1, 0.033), 0.033, 'timestamp repetido → duración media');
    assert.equal(frameDuration(1, null, 0.033), 0.033, 'último fotograma');
    assert.equal(frameDuration(1, null, 0), 1 / 30);
    assert.equal(monotonicTimestamp(5, null), 5);
    assert.equal(monotonicTimestamp(5, 4), 5);
    assert.equal(monotonicTimestamp(4, 4), 4.001);
  });

  test('paquetes máximos (fastStart reserve) y priming AAC', () => {
    assert.ok(maxVideoPackets(1758) >= 1758);
    assert.ok(maxAacPackets(60, 48000) >= Math.ceil((60 * 48000) / 1024) + 1);
    assert.ok(Math.abs(aacPrimingSeconds(48000) - 0.021333) < 1e-6);
    assert.equal(aacPrimingSeconds(0), 0);
  });

  test('ETA: null al principio; proporcional después; 0 al terminar', () => {
    assert.equal(estimateEtaMs(0.01, 5000), null);
    assert.equal(estimateEtaMs(0.5, 1000), null);
    assert.equal(estimateEtaMs(0.25, 10_000), 30_000);
    assert.equal(estimateEtaMs(1, 10_000), 0);
  });

  test('TrackPacer: la pista adelantada espera y nunca se bloquea si la otra termina', async () => {
    const pacer = new TrackPacer(['video', 'audio'], 1);
    const order = [];
    const video = (async () => {
      for (let t = 0; t <= 5; t++) { await pacer.advance('video', t); order.push(`v${t}`); }
      pacer.finish('video');
    })();
    const audio = (async () => {
      for (let t = 0; t <= 2; t += 0.5) { await pacer.advance('audio', t); order.push(`a${t}`); await new Promise((r) => setImmediate(r)); }
      pacer.finish('audio'); // termina antes: el vídeo debe poder seguir solo
    })();
    await Promise.all([video, audio]);
    assert.ok(order.indexOf('v3') > order.indexOf('a1.5'), 'el vídeo esperó al audio');
    assert.ok(order.includes('v5'), 'sin bloqueo al terminar el audio');
  });
});
