import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { openDatabase } from '../src/shared/database.js';
import { BlockSplitter, StreamingResampler, TARGET_RATE, downmixToMono, rms } from '../src/transcription/audio-resampler.js';
import {
  buildTxt, cleanText, formatTimestamp, isHallucination, segmentAt, toSegments, transcriptToText, transcriptToTimestampedText, txtFileName,
} from '../src/transcription/transcript-format.js';
import { CancelledError, runTranscription } from '../src/transcription/transcription-job.js';
import { createTranscriptRepository, TranscriptStatus } from '../src/transcription/transcript-repository.js';
import { BusyError, createTranscriptionService } from '../src/transcription/transcription-service.js';
import { ErrorCode, TranscriptionError, toErrorInfo } from '../src/transcription/transcription-errors.js';
import { openAudio } from '../src/transcription/audio-reader.js';
import { MODELS, isModelUrl } from '../src/transcription/models.js';

const tone = (freq, rate, seconds, amp = 0.5) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

/** Frecuencia dominante por cruces por cero. */
const zeroCrossFreq = (x, rate) => {
  let crossings = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) crossings++;
  return (crossings / 2) * (rate / x.length);
};

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

describe('Audio: downmix, remuestreo y bloques', () => {
  test('downmix estéreo → mono promedia; mono pasa tal cual', () => {
    const l = Float32Array.from([1, 0.5, -1]);
    const r = Float32Array.from([0, 0.5, 1]);
    assert.deepEqual([...downmixToMono([l, r])], [0.5, 0.5, 0]);
    assert.equal(downmixToMono([l]), l);
  });

  test('48 kHz → 16 kHz: longitud 1/3, conserva un tono de voz y atenúa lo que no cabe', () => {
    const r = new StreamingResampler(48_000);
    const out = r.process(tone(440, 48_000, 1));
    assert.ok(Math.abs(out.length - 16_000) <= 1, `longitud ${out.length}`);
    assert.ok(Math.abs(zeroCrossFreq(out.subarray(200), TARGET_RATE) - 440) < 5, 'el tono de 440 Hz se conserva');
    assert.ok(Math.abs(rms(out, 200) - 0.5 / Math.SQRT2) < 0.02, 'sin pérdida de nivel en la banda de voz');
    const alias = new StreamingResampler(48_000).process(tone(12_000, 48_000, 1));
    assert.ok(rms(alias, 200) < 0.05, `12 kHz (por encima de Nyquist de 16 kHz) atenuado: rms ${rms(alias, 200)}`);
  });

  test('trocear la entrada no cambia el resultado (estado entre llamadas)', () => {
    const input = tone(300, 44_100, 0.5);
    const whole = new StreamingResampler(44_100).process(input);
    const r = new StreamingResampler(44_100);
    const parts = [];
    for (let i = 0; i < input.length; i += 1024) parts.push(...r.process(input.subarray(i, i + 1024)));
    assert.ok(Math.abs(parts.length - whole.length) <= 1);
    const maxDiff = Math.max(...whole.slice(0, parts.length).map((v, i) => Math.abs(v - parts[i])));
    assert.ok(maxDiff < 1e-5, `diferencia máxima ${maxDiff}`);
  });

  test('16 kHz de entrada no se filtra (copia exacta)', () => {
    const input = tone(1000, 16_000, 0.1);
    assert.deepEqual([...new StreamingResampler(16_000).process(input)], [...input]);
  });

  test('bloques: se corta en el tramo más silencioso cerca del final, sin perder muestras', () => {
    const rate = 1000; // tasa baja para que el test sea rápido
    const splitter = new BlockSplitter({ sampleRate: rate, blockSec: 10, searchSec: 3, frameSec: 0.05 });
    const audio = tone(50, rate, 25, 0.5);
    audio.fill(0, 8_400, 8_600); // silencio a los 8,4-8,6 s
    const blocks = [];
    for (let i = 0; i < audio.length; i += 777) blocks.push(...splitter.push(audio.subarray(i, i + 777)));
    const last = splitter.flush();
    if (last) blocks.push(last);
    assert.ok(blocks[0].pcm.length >= 8_400 && blocks[0].pcm.length <= 8_600, `primer corte en el silencio: ${blocks[0].pcm.length}`);
    assert.equal(blocks.reduce((n, b) => n + b.pcm.length, 0), audio.length, 'ninguna muestra perdida ni duplicada');
    for (let i = 1; i < blocks.length; i++) assert.equal(blocks[i].start, blocks[i - 1].start + blocks[i - 1].pcm.length, 'bloques contiguos');
    assert.ok(blocks.every((b) => b.pcm.length <= 10 * rate));
  });

  test('un resto final demasiado corto (< 0,3 s) se descarta', () => {
    const splitter = new BlockSplitter({ sampleRate: 1000, blockSec: 1 });
    splitter.push(new Float32Array(1100));
    assert.equal(splitter.flush(), null);
  });
});

// ---------------------------------------------------------------------------
// Lector de audio (Mediabunny simulado)
// ---------------------------------------------------------------------------

const fakeMediabunny = ({ track = true, decodable = true, samples = [] } = {}) => {
  const disposed = { value: false };
  class Input {
    async getPrimaryAudioTrack() { return track ? { canDecode: async () => decodable } : null; }
    dispose() { disposed.value = true; }
  }
  class AudioSampleSink {
    async *samples() {
      for (const s of samples) {
        yield {
          ...s, numberOfChannels: s.planes.length, numberOfFrames: s.planes[0].length,
          duration: s.planes[0].length / s.sampleRate, copyTo: (dst, { planeIndex }) => dst.set(s.planes[planeIndex]), close() {},
        };
      }
    }
  }
  return { mb: { Input, AudioSampleSink, BlobSource: class {}, ALL_FORMATS: [] }, disposed };
};

describe('Lector de audio', () => {
  test('sin pista de audio → error «no-audio» (sin descargar ni cargar el modelo)', async () => {
    const { mb, disposed } = fakeMediabunny({ track: false });
    await assert.rejects(openAudio(new Blob(), { loadMediabunny: async () => mb }), (e) => e.code === ErrorCode.NO_AUDIO);
    assert.ok(disposed.value, 'se liberó el Input');
  });

  test('audio no decodificable → error «decode»', async () => {
    const { mb } = fakeMediabunny({ decodable: false });
    await assert.rejects(openAudio(new Blob(), { loadMediabunny: async () => mb }), (e) => e.code === ErrorCode.DECODE);
  });

  test('estéreo 48 kHz → bloques de 16 kHz mono con su instante; los huecos se rellenan con silencio', async () => {
    const rate = 48_000;
    const sec = (s) => tone(220, rate, s, 0.3);
    const samples = [
      { timestamp: 0, sampleRate: rate, planes: [sec(1), sec(1)] },
      { timestamp: 1, sampleRate: rate, planes: [sec(1), sec(1)] },
      { timestamp: 3, sampleRate: rate, planes: [sec(1), sec(1)] }, // hueco de 1 s
    ];
    const { mb } = fakeMediabunny({ samples });
    const audio = await openAudio(new Blob(), { loadMediabunny: async () => mb });
    const blocks = [];
    for await (const b of audio.blocks({ blockSec: 60 })) blocks.push(b);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].startSec, 0);
    assert.ok(Math.abs(blocks[0].durationSec - 4) < 0.01, `duración ${blocks[0].durationSec} (3 s de audio + 1 s de hueco)`);
    const gap = blocks[0].pcm.subarray(2.2 * TARGET_RATE, 2.8 * TARGET_RATE);
    assert.ok(rms(gap) < 1e-3, 'el hueco es silencio: las marcas de tiempo posteriores no se desplazan');
  });
});

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

describe('Formato de la transcripción', () => {
  test('conserva tildes, ñ, ¿¡ y puntuación; solo normaliza espacios', () => {
    assert.equal(cleanText('  ¿Qué  tal,\n  señor Muñoz?  ¡Él está aquí!  '), '¿Qué tal, señor Muñoz? ¡Él está aquí!');
  });

  test('salida del pipeline → segmentos absolutos (desplazados por el inicio del bloque)', () => {
    const out = { chunks: [{ timestamp: [0, 4.5], text: ' Hola, ¿cómo estás?' }, { timestamp: [4.5, null], text: ' Muy bien.' }] };
    assert.deepEqual(toSegments(out, 120, 60), [
      { start: 120, end: 124.5, text: 'Hola, ¿cómo estás?' },
      { start: 124.5, end: 180, text: 'Muy bien.' },
    ]);
  });

  test('descarta alucinaciones típicas, vacíos y repeticiones consecutivas (también con el bloque anterior)', () => {
    const out = {
      chunks: [
        { timestamp: [0, 2], text: ' Buenos días.' },
        { timestamp: [2, 4], text: ' Buenos días.' },
        { timestamp: [4, 6], text: ' Subtítulos realizados por la comunidad de Amara.org' },
        { timestamp: [6, 7], text: ' [Música]' },
        { timestamp: [7, 8], text: '   ' },
        { timestamp: [8, 9], text: ' Seguimos.' },
      ],
    };
    assert.deepEqual(toSegments(out, 0, 60, { text: 'Buenos días.' }).map((s) => s.text), ['Seguimos.']);
    assert.ok(isHallucination('¡Suscríbete!'));
    assert.ok(!isHallucination('La música del vídeo es de Juan.'));
  });

  test('sin chunks pero con texto: un único segmento que cubre el bloque', () => {
    assert.deepEqual(toSegments({ text: ' Hola.' }, 10, 5), [{ start: 10, end: 15, text: 'Hola.' }]);
  });

  test('marcas de tiempo, texto plano/con tiempos y .txt', () => {
    assert.equal(formatTimestamp(0), '0:00');
    assert.equal(formatTimestamp(83.9), '1:23');
    assert.equal(formatTimestamp(3723), '1:02:03');
    const segs = [{ start: 0, end: 2, text: 'Hola.' }, { start: 65, end: 70, text: '¿Qué tal?' }];
    assert.equal(transcriptToText(segs), 'Hola. ¿Qué tal?');
    assert.equal(transcriptToTimestampedText(segs), '[0:00] Hola.\n[1:05] ¿Qué tal?');
    assert.equal(buildTxt({ title: 'Reunión', segments: segs, withTimestamps: false }), 'Reunión\n\nHola. ¿Qué tal?\n');
    assert.equal(txtFileName('Demo: CRM/ventas'), 'Demo- CRM-ventas - transcripción.txt');
  });

  test('segmento en un instante (para resaltar el que se está reproduciendo)', () => {
    const segs = [{ start: 0, end: 2, text: 'a' }, { start: 2, end: 5, text: 'b' }, { start: 9, end: 10, text: 'c' }];
    assert.equal(segmentAt(segs, 0), 0);
    assert.equal(segmentAt(segs, 3), 1);
    assert.equal(segmentAt(segs, 7), -1, 'entre segmentos: ninguno');
    assert.equal(segmentAt(segs, 9.5), 2);
    assert.equal(segmentAt([], 1), -1);
  });
});

// ---------------------------------------------------------------------------
// Orquestador
// ---------------------------------------------------------------------------

const speech = (sec) => tone(200, TARGET_RATE, sec, 0.2);
const silence = (sec) => new Float32Array(Math.round(sec * TARGET_RATE));
const blockSource = (list) => async function* ({ startSec }) {
  let t = 0;
  for (const pcm of list) {
    const durationSec = pcm.length / TARGET_RATE;
    if (t >= startSec) yield { startSec: t, durationSec, pcm };
    t += durationSec;
  }
};

describe('Orquestador de la transcripción', () => {
  test('transcribe por bloques, salta los silenciosos y entrega cada bloque con su avance', async () => {
    const calls = [];
    const delivered = [];
    const stats = await runTranscription({
      blocks: blockSource([speech(60), silence(60), speech(30)]),
      transcribe: async (pcm) => {
        calls.push(pcm.length);
        return { chunks: [{ timestamp: [1, 3], text: ` Frase ${calls.length}.` }] };
      },
      onBlock: (r) => delivered.push(r),
    });
    assert.equal(calls.length, 2, 'el bloque en silencio no se manda al modelo (evita alucinaciones y tiempo)');
    assert.deepEqual(delivered.map((d) => d.processedMs), [60_000, 120_000, 150_000]);
    assert.deepEqual(delivered.flatMap((d) => d.segments), [
      { start: 1, end: 3, text: 'Frase 1.' },
      { start: 121, end: 123, text: 'Frase 2.' },
    ]);
    assert.deepEqual(stats, { blocks: 3, silentBlocks: 1, segments: 2 });
  });

  test('reanudar: empieza en el punto guardado y no repite el último segmento', async () => {
    const delivered = [];
    await runTranscription({
      blocks: blockSource([speech(60), speech(60)]),
      transcribe: async () => ({ chunks: [{ timestamp: [0, 2], text: ' Repetida.' }, { timestamp: [2, 4], text: ' Nueva.' }] }),
      startMs: 60_000,
      lastSegment: { text: 'Repetida.' },
      onBlock: (r) => delivered.push(r),
    });
    assert.equal(delivered.length, 1, 'solo el bloque pendiente');
    assert.deepEqual(delivered[0].segments.map((s) => s.text), ['Nueva.']);
  });

  test('cancelar entre bloques detiene el trabajo con CancelledError', async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(runTranscription({
      blocks: blockSource([speech(10), speech(10), speech(10)]),
      transcribe: async () => {
        calls++;
        if (calls === 1) controller.abort();
        return { chunks: [] };
      },
      onBlock: () => {},
      signal: controller.signal,
    }), CancelledError);
    assert.equal(calls, 1);
  });

  test('grabación completamente en silencio: completa sin segmentos y sin llamar al modelo', async () => {
    let calls = 0;
    const stats = await runTranscription({ blocks: blockSource([silence(60), silence(5)]), transcribe: async () => { calls++; }, onBlock: () => {} });
    assert.equal(calls, 0);
    assert.equal(stats.segments, 0);
  });
});

// ---------------------------------------------------------------------------
// Repositorio
// ---------------------------------------------------------------------------

describe('Repositorio de transcripciones', () => {
  const freshRepo = (idb = new IDBFactory()) => createTranscriptRepository({ open: () => openDatabase(idb) });

  test('ciclo: procesando → bloques → completada; persistido por id de grabación', async () => {
    const repo = freshRepo();
    await repo.start('rec-1', { model: 'base', modelRevision: 'abc', durationMs: 90_000 });
    await repo.appendBlock('rec-1', { segments: [{ start: 0, end: 2, text: 'Hola.' }], processedMs: 60_000 });
    await repo.appendBlock('rec-1', { segments: [{ start: 61, end: 62, text: 'Adiós.' }], processedMs: 90_000 });
    const done = await repo.complete('rec-1');
    assert.equal(done.status, TranscriptStatus.COMPLETED);
    assert.equal(done.noSpeech, false);
    assert.deepEqual((await repo.get('rec-1')).segments.map((s) => s.text), ['Hola.', 'Adiós.']);
    assert.equal((await repo.get('rec-1')).processedMs, 90_000);
    assert.deepEqual([...(await repo.statuses())], [['rec-1', 'completed']]);
  });

  test('sin voz → completada con noSpeech; error guarda código y mensaje', async () => {
    const repo = freshRepo();
    await repo.start('a', { model: 'base', modelRevision: 'r' });
    assert.equal((await repo.complete('a')).noSpeech, true);
    await repo.start('b', { model: 'base', modelRevision: 'r' });
    const failed = await repo.fail('b', { code: 'no-audio', message: 'Sin audio' });
    assert.equal(failed.status, 'error');
    assert.deepEqual(failed.error, { code: 'no-audio', message: 'Sin audio' });
  });

  test('escrituras tras borrar (cancelada o grabación eliminada) no resucitan el registro', async () => {
    const repo = freshRepo();
    await repo.start('x', { model: 'base', modelRevision: 'r' });
    assert.equal(await repo.remove('x'), true);
    assert.equal(await repo.appendBlock('x', { segments: [{ start: 0, end: 1, text: 'tarde' }], processedMs: 1 }), null);
    assert.equal(await repo.complete('x'), null);
    assert.equal(await repo.get('x'), null);
    assert.equal(await repo.remove('x'), false);
  });

  test('reanudar conserva segmentos y punto de avance', async () => {
    const repo = freshRepo();
    await repo.start('r', { model: 'base', modelRevision: 'r' });
    await repo.appendBlock('r', { segments: [{ start: 0, end: 1, text: 'Uno.' }], processedMs: 60_000 });
    const resumed = await repo.resume('r');
    assert.equal(resumed.processedMs, 60_000);
    assert.equal(resumed.segments.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Servicio (worker, locks y caché simulados)
// ---------------------------------------------------------------------------

/** LockManager en memoria con la semántica que usamos (exclusivo, ifAvailable, query). */
const fakeLocks = () => {
  const held = new Map();
  return {
    async request(name, { ifAvailable } = {}, cb) {
      if (held.has(name)) {
        if (ifAvailable) return cb(null);
        throw new Error(`lock ${name} ocupado (el test no espera colas)`);
      }
      held.set(name, true);
      try {
        return await cb({ name });
      } finally {
        held.delete(name);
      }
    },
    async query() { return { held: [...held.keys()].map((name) => ({ name })) }; },
    held,
  };
};

/** Worker simulado: responde al «start» con el guion indicado. */
const scriptedWorker = (script) => () => {
  const w = {
    terminated: false,
    received: null,
    onmessage: null,
    postMessage(msg) {
      w.received = msg;
      (async () => {
        for (const step of script(msg)) {
          await new Promise((r) => setTimeout(r, step.delay ?? 1));
          if (w.terminated) return;
          w.onmessage?.({ data: step });
        }
      })();
    },
    terminate() { w.terminated = true; },
  };
  scriptedWorker.last = w;
  return w;
};

const until = async (fn, label) => {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout: ${label}`);
};

const serviceEnv = (script, { records = { rec: { id: 'rec', durationMs: 120_000 } } } = {}) => {
  const idb = new IDBFactory();
  const repo = createTranscriptRepository({ open: () => openDatabase(idb) });
  const locks = fakeLocks();
  const events = [];
  const library = {
    get: async (id) => records[id] ?? null,
    getVideo: async (id) => ({ file: new Blob([id]) }),
  };
  const service = createTranscriptionService({ library, repo, locks, createWorker: scriptedWorker(script), notify: (e) => events.push(e), cacheStorage: null });
  return { repo, locks, events, service, records };
};

const happy = () => [
  { type: 'download', loaded: 50, total: 100 },
  { type: 'ready' },
  { type: 'block', segments: [{ start: 0, end: 3, text: '¿Qué tal?' }], processedMs: 60_000 },
  { type: 'block', segments: [{ start: 61, end: 63, text: 'Bien, gracias.' }], processedMs: 120_000 },
  { type: 'done', stats: {} },
];

describe('Servicio de transcripción', () => {
  test('flujo completo: persiste bloque a bloque y queda completada; libera los locks', async () => {
    const { service, repo, locks, events } = serviceEnv(happy);
    const phases = [];
    service.onChange((s) => s && phases.push(s.phase));
    await service.start('rec', { model: 'base' });
    assert.equal(scriptedWorker.last.received.model.revision, MODELS.base.revision, 'revisión del modelo fijada');
    assert.ok(locks.held.has('transcription:rec'));
    await until(async () => (await repo.get('rec'))?.status === 'completed', 'completada');
    const t = await service.get('rec');
    assert.deepEqual(t.segments.map((s) => s.text), ['¿Qué tal?', 'Bien, gracias.']);
    assert.equal(t.running, false);
    assert.equal(service.active(), null);
    assert.equal(locks.held.size, 0, 'locks liberados');
    assert.ok(phases.includes('downloading') && phases.includes('transcribing'));
    assert.deepEqual(events.map((e) => e.type).filter((x) => x !== 'progress'), ['started', 'finished']);
  });

  test('evita duplicados: una segunda transcripción mientras hay otra en curso → BusyError', async () => {
    const { service } = serviceEnv(() => [{ type: 'ready', delay: 50 }]);
    await service.start('rec');
    await assert.rejects(service.start('rec'), BusyError);
    await service.cancel('rec');
  });

  test('otra pestaña ya tiene el lock del motor → BusyError (sin tocar IndexedDB)', async () => {
    const { service, locks, repo } = serviceEnv(happy);
    locks.held.set('transcription', true);
    await assert.rejects(service.start('rec'), BusyError);
    assert.equal(await repo.get('rec'), null);
  });

  test('cancelar: termina el worker, borra lo parcial y vuelve a «pendiente»', async () => {
    const { service, repo, locks } = serviceEnv(() => [
      { type: 'ready' },
      { type: 'block', segments: [{ start: 0, end: 1, text: 'Parcial.' }], processedMs: 60_000 },
      { type: 'block', segments: [{ start: 60, end: 61, text: 'Nunca llega.' }], processedMs: 120_000, delay: 200 },
    ]);
    await service.start('rec');
    await until(async () => (await repo.get('rec'))?.segments.length === 1, 'primer bloque');
    assert.equal(await service.cancel('rec'), true);
    assert.ok(scriptedWorker.last.terminated);
    assert.equal(await repo.get('rec'), null);
    assert.equal(locks.held.size, 0);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await repo.get('rec'), null, 'ningún bloque tardío resucita la transcripción');
  });

  test('error del worker (sin audio) → estado error con código', async () => {
    const { service, repo } = serviceEnv(() => [{ type: 'error', error: { code: 'no-audio', message: 'Sin audio' } }]);
    await service.start('rec');
    await until(async () => (await repo.get('rec'))?.status === 'error', 'error');
    assert.equal((await repo.get('rec')).error.code, 'no-audio');
  });

  test('si la grabación se elimina durante la transcripción, no queda transcripción huérfana', async () => {
    const env = serviceEnv(() => [{ type: 'ready' }, { type: 'error', error: { code: 'decode', message: 'archivo desaparecido' }, delay: 20 }]);
    await env.service.start('rec');
    delete env.records.rec;
    await until(async () => env.service.active() === null, 'fin');
    assert.equal(await env.repo.get('rec'), null);
  });

  test('grabación inexistente → error not-found y locks libres', async () => {
    const { service, locks } = serviceEnv(happy, { records: {} });
    await assert.rejects(service.start('nope'), (e) => e.code === ErrorCode.NOT_FOUND);
    assert.equal(locks.held.size, 0);
  });

  test('interrumpida (Chrome se cerró): se detecta sin lock y se reanuda desde lo guardado', async () => {
    const { service, repo } = serviceEnv((msg) => [
      { type: 'ready' },
      { type: 'block', segments: [{ start: 60, end: 62, text: 'Segunda parte.' }], processedMs: msg.startMs + 60_000 },
      { type: 'done' },
    ]);
    // Estado que deja un cierre a mitad: «processing» con el primer bloque guardado y sin worker.
    await repo.start('rec', { model: 'small', modelRevision: MODELS.small.revision });
    await repo.appendBlock('rec', { segments: [{ start: 0, end: 2, text: 'Primera parte.' }], processedMs: 60_000 });
    const before = await service.get('rec');
    assert.equal(before.interrupted, true);
    await service.resume('rec');
    const msg = scriptedWorker.last.received;
    assert.equal(msg.startMs, 60_000, 'reanuda donde se quedó');
    assert.equal(msg.model.id, MODELS.small.id, 'con el mismo modelo');
    assert.equal(msg.lastSegment.text, 'Primera parte.');
    await until(async () => (await repo.get('rec'))?.status === 'completed', 'completada');
    assert.deepEqual((await repo.get('rec')).segments.map((s) => s.text), ['Primera parte.', 'Segunda parte.']);
  });

  test('descartar una interrumpida la borra', async () => {
    const { service, repo } = serviceEnv(happy);
    await repo.start('rec', { model: 'base', modelRevision: 'r' });
    assert.equal(await service.cancel('rec'), true);
    assert.equal(await repo.get('rec'), null);
  });
});

describe('Errores y modelos', () => {
  test('toErrorInfo: códigos conocidos, memoria y desconocidos', () => {
    assert.equal(toErrorInfo(new TranscriptionError(ErrorCode.NO_AUDIO)).code, 'no-audio');
    assert.equal(toErrorInfo(new RangeError('Array buffer allocation failed')).code, 'out-of-memory');
    const unknown = toErrorInfo(new Error('boom'));
    assert.equal(unknown.code, 'unknown');
    assert.match(unknown.message, /boom/);
  });

  test('revisiones fijadas (commit completo) y detección de archivos en caché', () => {
    for (const m of Object.values(MODELS)) assert.match(m.revision, /^[0-9a-f]{40}$/);
    const m = MODELS.base;
    assert.ok(isModelUrl(`https://huggingface.co/${m.id}/resolve/${m.revision}/onnx/encoder_model_quantized.onnx`, m));
    assert.ok(!isModelUrl(`https://huggingface.co/${m.id}/resolve/main/onnx/encoder_model_quantized.onnx`, m));
  });
});
