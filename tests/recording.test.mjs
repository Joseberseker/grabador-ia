import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { patchWebmHeader, setWebmDuration, inspectWebm } from '../src/recording/webm-duration.js';
import {
  buildDisplayMediaOptions,
  constraintAttempts,
  negotiateVideoTrack,
  targetSize,
  videoBitrate,
  audioBitrate,
  recorderOptionAttempts,
  createMediaRecorder,
} from '../src/recording/video-quality.js';
import { planAudio, describeAudio, rmsToLevel, createAudioGraph } from '../src/recording/audio.js';
import { ScreenRecorder } from '../src/recording/screen-recorder.js';
import { pickMimeType, mimeCandidates } from '../src/recording/mime-type.js';
import { normalizeSettings, DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { Status, getCountdownRemaining } from '../src/shared/state.js';

const settings = (patch = {}) => normalizeSettings({ ...DEFAULT_SETTINGS, ...patch });

// ---------------------------------------------------------------------------
// WebM: duración (3B)
// ---------------------------------------------------------------------------

describe('WebM: duración', () => {
  // Primeros 208 bytes reales de un WebM generado por MediaRecorder en Chrome 155.
  const chromeHeader = Uint8Array.from(Buffer.from(readFileSync(new URL('./fixtures/chrome-webm-header.hex', import.meta.url), 'utf8').trim(), 'hex'));

  test('la cabecera real de Chrome no trae Duration y tiene Segment de tamaño desconocido', () => {
    const info = inspectWebm(chromeHeader);
    assert.equal(info.durationMs, null);
    assert.equal(info.segmentSizeUnknown, true);
    assert.equal(info.timecodeScale, 1_000_000);
    assert.deepEqual(info.tracks.map((t) => t.type), ['video', 'audio']);
  });

  test('patchWebmHeader inserta Duration en Info (+11 bytes) sin tocar las pistas', () => {
    const patch = patchWebmHeader(chromeHeader, 12_345);
    assert.ok(patch);
    const patched = new Uint8Array([...patch.head, ...chromeHeader.subarray(patch.replacedBytes)]);
    assert.equal(patched.length, chromeHeader.length + 11);
    const info = inspectWebm(patched);
    assert.ok(Math.abs(info.durationMs - 12_345) < 0.001);
    assert.deepEqual(info.tracks, inspectWebm(chromeHeader).tracks);
  });

  test('si ya existe Duration se sobrescribe sin cambiar la longitud', () => {
    const once = patchWebmHeader(chromeHeader, 1000);
    const patched = new Uint8Array([...once.head, ...chromeHeader.subarray(once.replacedBytes)]);
    const twice = patchWebmHeader(patched, 5000);
    assert.equal(twice.head.length, once.head.length);
    const result = new Uint8Array([...twice.head, ...patched.subarray(twice.replacedBytes)]);
    assert.ok(Math.abs(inspectWebm(result).durationMs - 5000) < 0.001);
  });

  test('no parchea estructuras inesperadas (SeekHead antes de Info, basura, duración inválida)', () => {
    // EBML vacío + Segment desconocido + SeekHead(vacío) + Info(vacío)
    const withSeekHead = Uint8Array.from([
      0x1a, 0x45, 0xdf, 0xa3, 0x80,
      0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      0x11, 0x4d, 0x9b, 0x74, 0x80,
      0x15, 0x49, 0xa9, 0x66, 0x80,
    ]);
    assert.equal(patchWebmHeader(withSeekHead, 1000), null);
    assert.equal(patchWebmHeader(new Uint8Array([1, 2, 3, 4, 5]), 1000), null);
    assert.equal(patchWebmHeader(chromeHeader, 0), null);
    assert.equal(patchWebmHeader(chromeHeader, NaN), null);
  });

  test('con Segment de tamaño conocido también actualiza su tamaño', () => {
    const known = Uint8Array.from([
      0x1a, 0x45, 0xdf, 0xa3, 0x80,
      0x18, 0x53, 0x80, 0x67, 0x85, // Segment, tamaño 5
      0x15, 0x49, 0xa9, 0x66, 0x80, // Info vacío
    ]);
    const patch = patchWebmHeader(known, 2000);
    assert.equal(patch.head[9], 0x80 | (5 + 11));
    assert.equal(patch.head[14], 0x80 | 11);
    assert.ok(Math.abs(inspectWebm(patch.head).durationMs - 2000) < 0.001);
  });

  test('setWebmDuration trabaja sobre Blobs y conserva el resto del archivo', async () => {
    const body = new Uint8Array(5000).fill(7);
    const blob = new Blob([chromeHeader, body], { type: 'video/webm' });
    const out = await setWebmDuration(blob, 4200);
    assert.equal(out.size, blob.size + 11);
    assert.equal(out.type, 'video/webm');
    const bytes = new Uint8Array(await out.arrayBuffer());
    assert.ok(Math.abs(inspectWebm(bytes).durationMs - 4200) < 0.001);
    assert.deepEqual(bytes.subarray(bytes.length - 5000), body);
    const garbage = new Blob(['no es un webm']);
    assert.equal(await setWebmDuration(garbage, 1000), garbage);
  });
});

// ---------------------------------------------------------------------------
// Calidad: resolución, FPS, bitrate (3F)
// ---------------------------------------------------------------------------

/**
 * Track falso. La fuente mide srcW×srcH. Como en la captura de pestaña real de
 * Chrome, `width/height.max` se usa como tamaño objetivo: si es mayor que la
 * fuente, AMPLÍA. Así se comprueba que nunca le pedimos más que la fuente.
 */
function fakeVideoTrack({ srcW = 2560, srcH = 1440, maxFps = 60, rejectSize = false, reported = null }) {
  // `reported`: lo que getSettings() informa al principio (en pestañas, el tamaño de pantalla).
  let current = { ...(reported ?? { width: srcW, height: srcH }), frameRate: 30 };
  return {
    calls: [],
    async applyConstraints(c) {
      this.calls.push(c);
      if (rejectSize && c.width) throw Object.assign(new Error('size'), { name: 'OverconstrainedError' });
      if (c.frameRate?.max > maxFps) throw Object.assign(new Error('fps'), { name: 'OverconstrainedError' });
      const scale = Math.min((c.width?.max ?? srcW) / srcW, (c.height?.max ?? srcH) / srcH);
      current = { width: Math.round(srcW * scale), height: Math.round(srcH * scale), frameRate: c.frameRate?.max ?? 30 };
    },
    getSettings: () => current,
  };
}

describe('Calidad de vídeo', () => {
  test('getDisplayMedia solo recibe FPS max/ideal: ni min/exact ni tamaño', () => {
    for (const resolution of ['auto', '720p', '1080p']) {
      for (const fps of [30, 60]) {
        const opts = buildDisplayMediaOptions(settings({ resolution, fps }));
        const json = JSON.stringify(opts.video);
        assert.ok(!/min|exact/.test(json), json);
        assert.equal(opts.video.frameRate.max, fps);
      }
    }
    assert.equal(buildDisplayMediaOptions(settings({ resolution: '1080p' })).video.width, undefined);
    assert.equal(buildDisplayMediaOptions(settings({ tabAudio: false })).audio, false);
  });

  test('targetSize: cabe en la caja pedida, conserva la proporción y nunca amplía', () => {
    assert.deepEqual(targetSize('1080p', { width: 2560, height: 1440 }), { width: 1920, height: 1080 });
    assert.deepEqual(targetSize('720p', { width: 1920, height: 1200 }), { width: 1152, height: 720 }); // 16:10
    assert.deepEqual(targetSize('720p', { width: 1000, height: 1000 }), { width: 720, height: 720 });
    assert.deepEqual(targetSize('1080p', { width: 780, height: 436 }), { width: 780, height: 436 }, 'la fuente ya cabe: nativo');
    assert.deepEqual(targetSize('auto', { width: 3840, height: 2160 }), { width: 3840, height: 2160 }, 'auto: nativo explícito');
    assert.equal(targetSize('720p', {}), null);
  });

  test('intentos de applyConstraints de más a menos exigente y sin duplicados', () => {
    assert.deepEqual(constraintAttempts(settings({ resolution: '1080p', fps: 60 }), { width: 2560, height: 1440 }).map((a) => a.label),
      ['requested', 'fps-fallback', 'resolution-fallback', 'native']);
    // auto + 30 fps: varios intentos coinciden y se deduplican
    assert.deepEqual(constraintAttempts(settings({ resolution: 'auto', fps: 30 })).map((a) => a.label), ['requested', 'native'], 'sin tamaño conocido');
    const auto = constraintAttempts(settings({ resolution: 'auto', fps: 30 }), { width: 1600, height: 912 });
    assert.deepEqual(auto[0].constraints.width, { max: 1600 }, 'auto fija el tamaño nativo para que Chrome no amplíe');
  });

  test('1080p sobre una fuente de 1440p → 1920×1080 (combinación pedida)', async () => {
    const r = await negotiateVideoTrack(fakeVideoTrack({}), settings({ resolution: '1080p', fps: 60 }));
    assert.deepEqual([r.width, r.height, r.frameRate, r.applied, r.fallback], [1920, 1080, 60, 'requested', false]);
  });

  test('13. 1080p sobre una pestaña de 780×436 → 780×436 (una fuente que amplía no se amplía)', async () => {
    const track = fakeVideoTrack({ srcW: 780, srcH: 436 });
    const r = await negotiateVideoTrack(track, settings({ resolution: '1080p' }));
    assert.deepEqual([r.width, r.height], [780, 436]);
    assert.deepEqual(track.calls[0].width, { max: 780 }, 'se fija el tamaño nativo, nunca la caja de 1080p');
  });

  test('13. el tamaño medido de los fotogramas manda sobre getSettings (pestaña que informa del tamaño de pantalla)', async () => {
    const track = fakeVideoTrack({ srcW: 1600, srcH: 912, reported: { width: 1920, height: 1200 } });
    const fromSettings = await negotiateVideoTrack(track, settings({ resolution: 'auto' }));
    assert.ok(fromSettings.width > 1600, `confiar en getSettings ampliaría (${fromSettings.width}×${fromSettings.height})`);
    const measured = await negotiateVideoTrack(track, settings({ resolution: 'auto' }), { width: 1600, height: 912 });
    assert.deepEqual([measured.width, measured.height], [1600, 912]);
  });

  test('13. resolución no soportada → fallback a la resolución nativa conservando los FPS', async () => {
    const track = fakeVideoTrack({ rejectSize: true });
    const r = await negotiateVideoTrack(track, settings({ resolution: '720p', fps: 60 }));
    assert.equal(r.applied, 'resolution-fallback');
    assert.ok(r.fallback);
    assert.deepEqual([r.width, r.height, r.frameRate], [2560, 1440, 60]);
  });

  test('14. FPS no soportados → fallback a 30 fps conservando la resolución', async () => {
    const r = await negotiateVideoTrack(fakeVideoTrack({ srcW: 1920, srcH: 1080, maxFps: 30 }), settings({ resolution: '720p', fps: 60 }));
    assert.equal(r.applied, 'fps-fallback');
    assert.deepEqual([r.width, r.height, r.frameRate], [1280, 720, 30]);
  });

  test('si el track rechaza todo, se queda como está (applied = none)', async () => {
    const track = { applyConstraints: async () => { throw new Error('no'); }, getSettings: () => ({ width: 800, height: 600, frameRate: 24 }) };
    const r = await negotiateVideoTrack(track, settings({ resolution: '1080p', fps: 60 }));
    assert.deepEqual([r.applied, r.width, r.frameRate, r.fallback], ['none', 800, 24, true]);
  });

  test('bitrate según calidad y resolución REAL', () => {
    assert.equal(videoBitrate('auto', { width: 1920, height: 1080, frameRate: 30 }), undefined);
    const high = videoBitrate('high', { width: 1920, height: 1080, frameRate: 30 });
    const max = videoBitrate('max', { width: 1920, height: 1080, frameRate: 30 });
    assert.ok(high > 5_000_000 && high < 7_000_000, String(high));
    assert.ok(max > high);
    assert.equal(videoBitrate('high', { width: 320, height: 180, frameRate: 30 }), 1_000_000, 'mínimo 1 Mbps');
    assert.ok(videoBitrate('max', { width: 3840, height: 2160, frameRate: 60 }) <= 25_000_000, 'techo');
    assert.equal(audioBitrate('auto'), undefined);
    assert.equal(audioBitrate('max'), 192_000);
  });

  test('MediaRecorder: si una combinación de opciones no se admite, se prueba la siguiente', () => {
    const attempts = recorderOptionAttempts({ mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 8e6, audioBitsPerSecond: undefined });
    assert.deepEqual(attempts, [{ mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 8e6 }, { mimeType: 'video/webm;codecs=vp9' }, {}]);
    class PickyRecorder {
      constructor(stream, options) {
        if (options.videoBitsPerSecond) throw new DOMException('bitrate', 'NotSupportedError');
        this.options = options;
      }
    }
    const { options } = createMediaRecorder({}, attempts, PickyRecorder);
    assert.deepEqual(options, { mimeType: 'video/webm;codecs=vp9' });
    class NeverRecorder { constructor() { throw new DOMException('no', 'NotSupportedError'); } }
    assert.throws(() => createMediaRecorder({}, attempts, NeverRecorder), /no/);
  });

  test('mimeType sin audio no pide el códec Opus', () => {
    assert.equal(pickMimeType(() => true, mimeCandidates(false)), 'video/webm;codecs=vp9');
    assert.equal(pickMimeType(() => true, mimeCandidates(true)), 'video/webm;codecs=vp9,opus');
  });
});

// ---------------------------------------------------------------------------
// Audio: 4 combinaciones, micro rechazado, pestaña sin audio (3C/3D/3E)
// ---------------------------------------------------------------------------

class FakeTrack {
  constructor(kind, label) { this.kind = kind; this.label = label; this.stopped = false; }
  stop() { this.stopped = true; }
}
globalThis.MediaStream ??= class {
  constructor(tracks = []) { this.tracks = tracks; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
  getTracks() { return this.tracks; }
};

class FakeAudioContext {
  static instances = [];
  constructor() {
    this.connections = [];
    this.destination = { name: 'speakers' };
    this.closed = false;
    FakeAudioContext.instances.push(this);
  }
  node(name, extra = {}) {
    return { name, connect: (target) => this.connections.push([name, target.name]), ...extra };
  }
  createMediaStreamSource(stream) { return this.node(`source:${stream.tracks[0].label}`); }
  createAnalyser() { return this.node('analyser', { getFloatTimeDomainData: (buf) => buf.fill(0.5) }); }
  createMediaStreamDestination() {
    const mixed = new FakeTrack('audio', 'mixed');
    return { name: 'mix-destination', stream: new MediaStream([mixed]) };
  }
  async resume() {}
  async close() { this.closed = true; }
}

describe('Audio', () => {
  const tab = new FakeTrack('audio', 'tab');
  const mic = new FakeTrack('audio', 'mic');

  test('1-4. planAudio cubre las cuatro combinaciones', () => {
    assert.equal(planAudio({ tab: false, mic: false }), 'none'); // 1. vídeo solo
    assert.equal(planAudio({ tab: true, mic: false }), 'tab'); // 2. vídeo + pestaña
    assert.equal(planAudio({ tab: false, mic: true }), 'mic'); // 3. vídeo + micrófono
    assert.equal(planAudio({ tab: true, mic: true }), 'mix'); // 4. vídeo + pestaña + micrófono
  });

  test('1. vídeo solo: sin track de audio y sin AudioContext', () => {
    const before = FakeAudioContext.instances.length;
    const g = createAudioGraph({ AudioContextCtor: FakeAudioContext });
    assert.equal(g.track, null);
    assert.equal(FakeAudioContext.instances.length, before);
  });

  test('2. pestaña sola: se usa su track directamente (sin Web Audio)', () => {
    const before = FakeAudioContext.instances.length;
    const g = createAudioGraph({ tabTrack: tab, AudioContextCtor: FakeAudioContext });
    assert.equal(g.track, tab);
    assert.equal(FakeAudioContext.instances.length, before);
  });

  test('3. micrófono solo: track directo + analizador para el indicador', () => {
    const g = createAudioGraph({ micTrack: mic, AudioContextCtor: FakeAudioContext });
    const ctx = FakeAudioContext.instances.at(-1);
    assert.equal(g.track, mic);
    assert.deepEqual(ctx.connections, [['source:mic', 'analyser']]);
    assert.ok(Math.abs(g.level() - 0.9) < 0.01, 'señal de 0,5 (≈ -6 dB) → nivel 0,9');
    g.close();
    assert.ok(ctx.closed);
  });

  test('4. pestaña + micrófono: mezcla Web Audio, cada fuente una vez y nada a los altavoces', () => {
    const g = createAudioGraph({ tabTrack: tab, micTrack: mic, AudioContextCtor: FakeAudioContext });
    const ctx = FakeAudioContext.instances.at(-1);
    assert.equal(g.track.label, 'mixed');
    const toMix = ctx.connections.filter(([, to]) => to === 'mix-destination').map(([from]) => from).sort();
    assert.deepEqual(toMix, ['source:mic', 'source:tab'], 'sin duplicados');
    assert.ok(!ctx.connections.some(([, to]) => to === 'speakers'), 'nada se reproduce (sin eco ni duplicado)');
    g.close();
    assert.ok(g.track.stopped && ctx.closed);
  });

  test('5. micrófono rechazado: se marca error y se graba sin él', () => {
    const d = describeAudio({ settings: settings({ micEnabled: true }), tabTrack: tab, micTrack: null, micError: 'permiso denegado' });
    assert.deepEqual(d, { tab: 'on', mic: 'error', plan: 'tab' });
  });

  test('6. pestaña sin audio: «no disponible» si se pidió; «off» si no', () => {
    assert.deepEqual(describeAudio({ settings: settings({ tabAudio: true }), tabTrack: null, micTrack: null }), { tab: 'unavailable', mic: 'off', plan: 'none' });
    assert.deepEqual(describeAudio({ settings: settings({ tabAudio: false }), tabTrack: null, micTrack: mic }), { tab: 'off', mic: 'off', plan: 'mic' });
    assert.deepEqual(describeAudio({ settings: settings({ micEnabled: true }), tabTrack: tab, micTrack: mic }), { tab: 'on', mic: 'on', plan: 'mix' });
  });

  test('rmsToLevel: silencio 0, señal plena 1, escala en dB', () => {
    assert.equal(rmsToLevel(0), 0);
    assert.equal(rmsToLevel(1), 1);
    assert.equal(rmsToLevel(0.001), 0); // -60 dB
    assert.ok(Math.abs(rmsToLevel(0.0316) - 0.5) < 0.01); // ≈ -30 dB
  });
});

// ---------------------------------------------------------------------------
// ScreenRecorder: persistencia ordenada, pausa, parada en pausa (3A)
// ---------------------------------------------------------------------------

class FakeRecorder extends EventTarget {
  static last = null;
  constructor(stream, options) {
    super();
    this.state = 'inactive';
    this.mimeType = options.mimeType ?? 'video/webm';
    FakeRecorder.last = this;
  }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.emit('final');
    this.dispatchEvent(new Event('stop'));
  }
  emit(text) {
    const event = new Event('dataavailable');
    event.data = new Blob([text]);
    this.dispatchEvent(event);
  }
}

describe('ScreenRecorder + persistencia', () => {
  test('11. los fragmentos se persisten en orden aunque las escrituras tarden distinto', async () => {
    const stored = [];
    const rec = new ScreenRecorder({
      RecorderCtor: FakeRecorder,
      onChunk: async (blob, seq) => {
        await new Promise((r) => setTimeout(r, (3 - seq) * 15)); // la primera escritura es la más lenta
        stored.push([seq, await blob.text()]);
      },
    });
    rec.start({}, [{ mimeType: 'video/webm' }]);
    FakeRecorder.last.emit('a');
    FakeRecorder.last.emit('b');
    FakeRecorder.last.emit('c');
    rec.stop();
    const result = await rec.whenStopped();
    assert.equal(result.chunks, 4);
    assert.deepEqual(stored, [[0, 'a'], [1, 'b'], [2, 'c'], [3, 'final']]);
  });

  test('7-8. pausar, reanudar y detener mientras está pausado', async () => {
    const stored = [];
    const rec = new ScreenRecorder({ RecorderCtor: FakeRecorder, onChunk: async (b) => stored.push(await b.text()) });
    rec.start({}, [{}]);
    FakeRecorder.last.emit('1');
    rec.pause();
    assert.equal(rec.state, 'paused');
    assert.throws(() => rec.pause(), /pausar/);
    rec.resume();
    assert.equal(rec.state, 'recording');
    FakeRecorder.last.emit('2');
    rec.pause();
    rec.stop(); // detener en pausa
    await rec.whenStopped();
    assert.equal(rec.state, 'inactive');
    assert.deepEqual(stored, ['1', '2', 'final']);
    rec.stop(); // idempotente
  });

  test('error de escritura (p. ej. cuota): se avisa una vez y se dejan de escribir fragmentos', async () => {
    const errors = [];
    const written = [];
    const rec = new ScreenRecorder({
      RecorderCtor: FakeRecorder,
      onChunk: async (blob, seq) => {
        if (seq === 1) throw new DOMException('lleno', 'QuotaExceededError');
        written.push(seq);
      },
      onWriteError: (e) => errors.push(e.name),
    });
    rec.start({}, [{}]);
    FakeRecorder.last.emit('a');
    FakeRecorder.last.emit('b');
    FakeRecorder.last.emit('c');
    rec.stop();
    const result = await rec.whenStopped();
    assert.deepEqual(errors, ['QuotaExceededError']);
    assert.deepEqual(written, [0]);
    assert.equal(result.chunks, 1, 'solo cuenta lo guardado');
  });

  test('si falla la escritura del primer fragmento, whenStopped rechaza (no hay nada que guardar)', async () => {
    const rec = new ScreenRecorder({
      RecorderCtor: FakeRecorder,
      onChunk: async () => { throw new DOMException('lleno', 'QuotaExceededError'); },
    });
    rec.start({}, [{}]);
    FakeRecorder.last.emit('a');
    FakeRecorder.last.emit('b');
    rec.stop();
    await assert.rejects(rec.whenStopped(), { name: 'QuotaExceededError' });
  });
});

// ---------------------------------------------------------------------------
// Ajustes y cuenta regresiva (3F/3G)
// ---------------------------------------------------------------------------

test('normalizeSettings: micrófono OFF por defecto y valores inválidos corregidos', () => {
  assert.equal(normalizeSettings({}).micEnabled, false);
  assert.equal(normalizeSettings({ micEnabled: 'yes' }).micEnabled, false, 'solo true explícito');
  assert.deepEqual(normalizeSettings({ resolution: '4k', fps: 144, quality: 'ultra', countdown: 10 }), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings({ fps: '60', countdown: '3', tabAudio: false }), { ...DEFAULT_SETTINGS, fps: 60, countdown: 3, tabAudio: false });
});

test('cuenta regresiva: 3 → 2 → 1 → 0', () => {
  const s = { status: Status.COUNTDOWN, countdownEndsAt: 10_000 };
  assert.equal(getCountdownRemaining(s, 7_000), 3);
  assert.equal(getCountdownRemaining(s, 7_001), 3);
  assert.equal(getCountdownRemaining(s, 8_500), 2);
  assert.equal(getCountdownRemaining(s, 9_999), 1);
  assert.equal(getCountdownRemaining(s, 10_000), 0);
  assert.equal(getCountdownRemaining({ ...s, status: Status.RECORDING }, 8_000), 0);
});
