import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { DB_NAME, DB_VERSION, STORES, openDatabase } from '../src/shared/database.js';
import { createLibraryRepository, RecordingNotFoundError } from '../src/library/library-repository.js';
import { createLibraryFiles } from '../src/library/library-files.js';
import { createLibrary, TitleError } from '../src/library/library-service.js';
import { createTranscriptRepository } from '../src/transcription/transcript-repository.js';
import { generateThumbnail, thumbnailSize, thumbnailTime, ThumbnailError, THUMBNAIL_FILE } from '../src/library/thumbnail.js';
import {
  buildRecording, defaultTitle, formatSummary, groupByDay, resolutionLabel, sanitizeFileName, sortRecordings, validateTitle,
} from '../src/library/recording-meta.js';

// ---------------------------------------------------------------------------
// Dobles
// ---------------------------------------------------------------------------

/** OPFS en memoria con la API que usamos (incluido move() y createWritable con stream). */
class FakeFile {
  constructor(name, dir) { this.kind = 'file'; this.name = name; this.dir = dir; this.data = new Uint8Array(0); }
  async getFile() {
    if (!this.dir.children.has(this.name)) throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
    return new File([this.data], this.name);
  }
  async createWritable() {
    const parts = [];
    const handle = this;
    return new WritableStream({
      write(chunk) { parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)); },
      close() { handle.data = new Uint8Array(Buffer.concat(parts)); },
    });
  }
  async move(dir, name) {
    this.dir.children.delete(this.name);
    this.name = name;
    this.dir = dir;
    dir.children.set(name, this);
    FakeFile.moves++;
  }
}
FakeFile.moves = 0;
class FakeDir {
  constructor(name = '') { this.kind = 'directory'; this.name = name; this.children = new Map(); }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw Object.assign(new Error(name), { name: 'NotFoundError' });
      this.children.set(name, new FakeDir(name));
    }
    return this.children.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw Object.assign(new Error(name), { name: 'NotFoundError' });
      this.children.set(name, new FakeFile(name, this));
    }
    return this.children.get(name);
  }
  async removeEntry(name, { recursive = false } = {}) {
    const entry = this.children.get(name);
    if (!entry) throw Object.assign(new Error(name), { name: 'NotFoundError' });
    if (entry.kind === 'directory' && entry.children.size && !recursive) throw Object.assign(new Error('not empty'), { name: 'InvalidModificationError' });
    this.children.delete(name);
  }
  async *entries() { yield* this.children.entries(); }
}

const fresh = () => {
  const idb = new IDBFactory();
  const root = new FakeDir();
  const repo = createLibraryRepository({ open: () => openDatabase(idb) });
  const files = createLibraryFiles({ getRoot: async () => root });
  const transcripts = createTranscriptRepository({ open: () => openDatabase(idb) });
  return { idb, root, repo, files, transcripts };
};

const meta = (patch = {}) => ({
  createdAt: Date.UTC(2026, 9, 7, 11, 42), durationMs: 151_000, width: 1918, height: 992, fps: 30,
  mimeType: 'video/mp4', hasTabAudio: true, hasMicrophone: false, sourceType: 'browser', ...patch,
});
const record = (id, patch = {}) => buildRecording({ id, format: 'mp4', fileName: 'recording.mp4', fileSize: 10, ...meta(patch) });

// ---------------------------------------------------------------------------
// Metadatos (puros)
// ---------------------------------------------------------------------------

describe('Metadatos', () => {
  test('título por defecto y validación (vacío, largo, control, espacios)', () => {
    assert.equal(defaultTitle(new Date(2026, 9, 7, 13, 42)), 'Grabación 2026-10-07 13:42');
    assert.deepEqual(validateTitle('  Demo   del CRM Pocki  '), { ok: true, value: 'Demo del CRM Pocki' });
    assert.equal(validateTitle('   ').ok, false);
    assert.equal(validateTitle('').ok, false);
    assert.equal(validateTitle(null).ok, false);
    assert.equal(validateTitle('a'.repeat(121)).ok, false);
    assert.equal(validateTitle('a'.repeat(120)).ok, true);
    assert.equal(validateTitle('línea\nnueva\ttab').value, 'línea nueva tab');
    assert.equal(validateTitle('Informe: Q3 / ventas?').value, 'Informe: Q3 / ventas?', 'el título admite cualquier texto');
  });

  test('nombre de archivo de descarga seguro', () => {
    assert.equal(sanitizeFileName('Informe: Q3 / ventas?', 'mp4'), 'Informe- Q3 - ventas-.mp4');
    assert.equal(sanitizeFileName('...', 'webm'), 'grabacion.webm');
    assert.equal(sanitizeFileName('  Demo del CRM Pocki  ', 'mp4'), 'Demo del CRM Pocki.mp4');
    assert.equal(sanitizeFileName('a'.repeat(300), 'mp4').length, 104);
    assert.equal(sanitizeFileName('<>|*"', 'mp4'), '-----.mp4');
  });

  test('buildRecording: campos del modelo y validaciones', () => {
    const r = record('r1');
    assert.equal(r.title, 'Grabación 2026-10-07 ' + new Date(Date.UTC(2026, 9, 7, 11, 42)).toTimeString().slice(0, 5));
    assert.deepEqual(
      [r.format, r.mimeType, r.hasAudio, r.hasTabAudio, r.hasMicrophone, r.sourceType, r.status, r.fps, r.schemaVersion],
      ['mp4', 'video/mp4', true, true, false, 'browser', 'ready', 30, 1],
    );
    assert.equal(record('r2', { hasTabAudio: false }).hasAudio, false);
    assert.throws(() => buildRecording({ id: 'x', format: 'avi', fileName: 'a' }), /formato/);
    assert.throws(() => buildRecording({ format: 'mp4', fileName: 'a' }), /id/);
  });

  test('orden (más recientes primero) y agrupación Hoy / Ayer / fecha', () => {
    const now = new Date(2026, 9, 7, 18, 0).getTime();
    const items = [
      record('viejo', { createdAt: new Date(2026, 9, 1, 9).getTime() }),
      record('hoy', { createdAt: new Date(2026, 9, 7, 10).getTime() }),
      record('ayer', { createdAt: new Date(2026, 9, 6, 23, 59).getTime() }),
      record('hoy2', { createdAt: new Date(2026, 9, 7, 17).getTime() }),
    ];
    assert.deepEqual(sortRecordings(items).map((r) => r.id), ['hoy2', 'hoy', 'ayer', 'viejo']);
    const groups = groupByDay(items, now);
    assert.deepEqual(groups.map((g) => g.label.slice(0, 4)), ['Hoy', 'Ayer', '1 de']);
    assert.deepEqual(groups[0].items.map((r) => r.id), ['hoy2', 'hoy']);
  });

  test('etiquetas de resolución y resumen', () => {
    assert.equal(resolutionLabel({ width: 1918, height: 992 }), '1080p'); // 992 está a <10 % de 1080
    assert.equal(resolutionLabel({ width: 1280, height: 662 }), '720p');
    assert.equal(resolutionLabel({ width: 2560, height: 1440 }), '1440p');
    assert.equal(resolutionLabel({ width: 500, height: 300 }), '500×300');
    assert.equal(resolutionLabel({}), null);
    assert.equal(formatSummary(record('x')), 'MP4 · 1080p · 30 FPS');
  });
});

// ---------------------------------------------------------------------------
// Repositorio (IndexedDB real en Node mediante fake-indexeddb)
// ---------------------------------------------------------------------------

describe('Repositorio', () => {
  test('crear, recuperar, listar ordenado, actualizar título y eliminar', async () => {
    const { repo } = fresh();
    await repo.add(record('a', { createdAt: 1000 }));
    await repo.add(record('b', { createdAt: 3000 }));
    await repo.add(record('c', { createdAt: 2000 }));
    assert.equal((await repo.get('b')).id, 'b');
    assert.deepEqual((await repo.list()).map((r) => r.id), ['b', 'c', 'a']);
    const renamed = await repo.update('a', { title: 'Demo del CRM Pocki' });
    assert.equal(renamed.title, 'Demo del CRM Pocki');
    assert.equal((await repo.get('a')).title, 'Demo del CRM Pocki', 'persiste');
    assert.equal(await repo.remove('c'), true);
    assert.equal(await repo.count(), 2);
  });

  test('grabación inexistente: get → null, update → RecordingNotFoundError, remove → false; id duplicado → error', async () => {
    const { repo } = fresh();
    assert.equal(await repo.get('nope'), null);
    await assert.rejects(repo.update('nope', { title: 'x' }), RecordingNotFoundError);
    assert.equal(await repo.remove('nope'), false);
    await repo.add(record('dup'));
    await assert.rejects(repo.add(record('dup')), { name: 'ConstraintError' });
  });

  test('100 grabaciones: listar devuelve solo metadatos, ordenados', async () => {
    const { repo } = fresh();
    for (let i = 0; i < 100; i++) await repo.add(record(`r${i}`, { createdAt: i }));
    const list = await repo.list();
    assert.equal(list.length, 100);
    assert.equal(list[0].id, 'r99');
    assert.ok(list.every((r) => !('blob' in r) && !('data' in r)), 'sin vídeos en los metadatos');
  });
});

describe('Migración de IndexedDB', () => {
  test('v1 (fases 3–4) → v2: conserva sesiones y fragmentos y añade la biblioteca', async () => {
    const idb = new IDBFactory();
    // Base de datos tal como la dejaban las fases anteriores (versión 1).
    await new Promise((resolve, reject) => {
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('recordings', { keyPath: 'id' }).put({ id: 'sesion-antigua', createdAt: 1, mimeType: 'video/webm' });
        db.createObjectStore('chunks', { keyPath: ['recordingId', 'seq'] }).put({ recordingId: 'sesion-antigua', seq: 0, blob: 'datos' });
      };
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
    const db = await openDatabase(idb);
    assert.equal(db.version, DB_VERSION);
    assert.deepEqual([...db.objectStoreNames].sort(), [STORES.SESSIONS, STORES.CHUNKS, STORES.LIBRARY, STORES.TRANSCRIPTS].sort());
    const tx = db.transaction(['recordings', 'chunks', 'library']);
    const get = (store, key) => new Promise((r) => { const q = tx.objectStore(store).get(key); q.onsuccess = () => r(q.result); });
    assert.equal((await get('recordings', 'sesion-antigua')).mimeType, 'video/webm', 'sesión conservada');
    assert.equal((await get('chunks', ['sesion-antigua', 0])).blob, 'datos', 'fragmento conservado');
    assert.deepEqual([...tx.objectStore('library').indexNames], ['createdAt']);
  });

  test('base nueva: se crea directamente en v3 con los cuatro almacenes', async () => {
    const db = await openDatabase(new IDBFactory());
    assert.equal(db.version, 3);
    assert.equal(db.objectStoreNames.length, 4);
  });

  test('migración v2 → v3: conserva la biblioteca y añade «transcripts» vacío', async () => {
    const idb = new IDBFactory();
    await new Promise((resolve, reject) => {
      const req = idb.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('recordings', { keyPath: 'id' });
        db.createObjectStore('chunks', { keyPath: ['recordingId', 'seq'] });
        const lib = db.createObjectStore('library', { keyPath: 'id' });
        lib.createIndex('createdAt', 'createdAt');
        lib.put(record('grabacion-fase-5'));
      };
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
    const db = await openDatabase(idb);
    assert.equal(db.version, 3);
    const repo = createLibraryRepository({ open: () => openDatabase(idb) });
    assert.equal((await repo.get('grabacion-fase-5'))?.title, record('grabacion-fase-5').title, 'grabación antigua intacta');
    const count = await new Promise((r) => { const q = db.transaction('transcripts').objectStore('transcripts').count(); q.onsuccess = () => r(q.result); });
    assert.equal(count, 0, 'las grabaciones antiguas quedan sin transcripción (no se procesa nada automáticamente)');
  });

  test('base ya en la versión actual: abrir de nuevo no altera los datos', async () => {
    const idb = new IDBFactory();
    const repo = createLibraryRepository({ open: () => openDatabase(idb) });
    await repo.add(record('persistente'));
    (await openDatabase(idb)).close();
    // Reapertura «en frío» (como tras reiniciar Chrome): misma versión, sin migración.
    const value = await new Promise((resolve, reject) => {
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => reject(new Error('no debería migrar'));
      req.onsuccess = () => {
        const q = req.result.transaction('library').objectStore('library').get('persistente');
        q.onsuccess = () => resolve(q.result);
      };
    });
    assert.equal(value?.id, 'persistente');
  });
});

// ---------------------------------------------------------------------------
// Archivos (OPFS falso)
// ---------------------------------------------------------------------------

describe('Archivos de la biblioteca', () => {
  test('guardar por stream, recuperar, mover sin copia y borrar la carpeta completa', async () => {
    const { root, files } = fresh();
    const webm = await files.writeBlob('r1', 'recording.webm', new Blob([new Uint8Array(5000).fill(7)]));
    assert.equal(webm.size, 5000);
    assert.equal((await files.getFile('r1', 'recording.webm')).size, 5000);

    const temp = await root.getDirectoryHandle('conversion-temp', { create: true });
    const tempFile = await temp.getFileHandle('r2.mp4', { create: true });
    const w = await tempFile.createWritable();
    await new Blob([new Uint8Array(1234)]).stream().pipeTo(w);
    const before = FakeFile.moves;
    const mp4 = await files.adoptFile('r2', tempFile, 'recording.mp4', { sourceDir: temp });
    assert.equal(mp4.size, 1234);
    assert.equal(FakeFile.moves, before + 1, 'se movió (sin copiar)');
    assert.equal(temp.children.size, 0, 'el temporal ya no está en conversion-temp');

    assert.deepEqual((await files.listIds()).sort(), ['r1', 'r2']);
    assert.equal(await files.remove('r1'), true);
    assert.equal(await files.getFile('r1', 'recording.webm'), null);
    assert.equal(await files.remove('r1'), false, 'borrar dos veces no falla');
    assert.deepEqual(await files.listIds(), ['r2']);
  });

  test('sin move(): copia por stream y borra el original', async () => {
    const { root, files } = fresh();
    const temp = await root.getDirectoryHandle('conversion-temp', { create: true });
    const handle = await temp.getFileHandle('x.mp4', { create: true });
    await new Blob([new Uint8Array(99)]).stream().pipeTo(await handle.createWritable());
    const noMove = { name: handle.name, getFile: () => handle.getFile() };
    const file = await files.adoptFile('x', noMove, 'recording.mp4', { sourceDir: temp });
    assert.equal(file.size, 99);
    assert.equal(temp.children.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Miniatura
// ---------------------------------------------------------------------------

function fakeMb({ decodable = true, frame = true, width = 1920, height = 1080 } = {}) {
  const calls = {};
  return {
    calls,
    mb: {
      ALL_FORMATS: [],
      BlobSource: class {},
      Input: class {
        getPrimaryVideoTrack = async () => ({
          displayWidth: width, displayHeight: height, canDecode: async () => decodable,
          getFirstTimestamp: async () => 0.007, computeDuration: async () => 60,
        });
        dispose() {}
      },
      CanvasSink: class {
        constructor(track, opts) { calls.sinkOptions = opts; }
        async getCanvas(t) { calls.time = t; return frame ? { canvas: { fake: true } } : null; }
      },
    },
  };
}
const fakeCanvas = (w, h) => ({
  width: w, height: h,
  getContext: () => ({ drawImage() {} }),
  convertToBlob: async ({ type }) => new Blob([new Uint8Array(Math.round((w * h) / 8))], { type }),
});

describe('Miniatura', () => {
  test('tamaño razonable: cabe en 320×180, conserva la proporción y nunca amplía', () => {
    assert.deepEqual(thumbnailSize(1920, 1080), { width: 320, height: 180 });
    assert.deepEqual(thumbnailSize(1918, 992), { width: 320, height: 166 });
    assert.deepEqual(thumbnailSize(1080, 1920), { width: 102, height: 180 });
    assert.deepEqual(thumbnailSize(200, 100), { width: 200, height: 100 });
    assert.throws(() => thumbnailSize(0, 100), ThumbnailError);
    assert.equal(thumbnailTime(60), 1);
    assert.equal(thumbnailTime(1), 0.5);
  });

  test('genera un JPEG pequeño a partir de un fotograma cercano al inicio', async () => {
    const { mb, calls } = fakeMb();
    const blob = await generateThumbnail(new Blob(['v']), { loadMediabunny: async () => mb, createCanvas: fakeCanvas });
    assert.equal(blob.type, 'image/jpeg');
    assert.ok(blob.size < 50_000);
    assert.deepEqual([calls.sinkOptions.width, calls.sinkOptions.height], [320, 180]);
    assert.ok(Math.abs(calls.time - 1.007) < 1e-9, '1 s después del primer fotograma');
  });

  test('error si el vídeo no se puede decodificar o no hay fotogramas', async () => {
    await assert.rejects(generateThumbnail(new Blob(['v']), { loadMediabunny: async () => fakeMb({ decodable: false }).mb, createCanvas: fakeCanvas }), ThumbnailError);
    await assert.rejects(generateThumbnail(new Blob(['v']), { loadMediabunny: async () => fakeMb({ frame: false }).mb, createCanvas: fakeCanvas }), ThumbnailError);
  });
});

// ---------------------------------------------------------------------------
// Servicio (repositorio + archivos + miniatura)
// ---------------------------------------------------------------------------

describe('Biblioteca', () => {
  const library = (env, makeThumbnail = async () => new Blob([new Uint8Array(900)], { type: 'image/jpeg' })) => {
    const events = [];
    return { events, lib: createLibrary({ repo: env.repo, files: env.files, transcripts: env.transcripts, makeThumbnail, notify: (e) => events.push(e) }) };
  };

  test('guardar (WebM por stream): vídeo + miniatura + metadatos; recuperar el File', async () => {
    const env = fresh();
    const { lib, events } = library(env);
    const { record: r } = await lib.save({ id: 'w1', format: 'webm', meta: meta({ mimeType: 'video/webm' }), video: { blob: new Blob([new Uint8Array(4096)]) } });
    assert.equal(r.fileSize, 4096);
    assert.equal(r.thumbnailFileName, THUMBNAIL_FILE);
    const { file } = await lib.getVideo('w1');
    assert.equal(file.size, 4096);
    assert.equal((await lib.getThumbnail(r)).size, 900);
    assert.deepEqual(events, [{ type: 'saved', id: 'w1' }]);
  });

  test('si la miniatura falla, la grabación se guarda igual (sin miniatura)', async () => {
    const env = fresh();
    const { lib } = library(env, async () => { throw new ThumbnailError('no'); });
    const { record: r } = await lib.save({ id: 'n1', format: 'mp4', meta: meta(), video: { blob: new Blob(['x']) } });
    assert.equal(r.thumbnailFileName, null);
    assert.equal(await lib.getThumbnail(r), null);
  });

  test('si guardar falla, no queda basura en OPFS ni en IndexedDB', async () => {
    const env = fresh();
    const { lib } = library(env);
    await lib.save({ id: 'dup', format: 'mp4', meta: meta(), video: { blob: new Blob(['x']) } });
    await assert.rejects(lib.save({ id: 'dup', format: 'mp4', meta: meta(), video: { blob: new Blob(['y']) } }));
    assert.deepEqual(await env.files.listIds(), [], 'la carpeta del intento fallido se borró');
    // (la grabación original con el mismo id también: un id repetido nunca ocurre en producción)
  });

  test('renombrar valida y persiste; eliminar borra vídeo, miniatura y metadatos', async () => {
    const env = fresh();
    const { lib, events } = library(env);
    await lib.save({ id: 'r1', format: 'mp4', meta: meta(), video: { blob: new Blob(['v']) } });
    await assert.rejects(lib.rename('r1', '   '), TitleError);
    await assert.rejects(lib.rename('nope', 'x'), RecordingNotFoundError);
    assert.equal((await lib.rename('r1', '  Demo del CRM Pocki ')).title, 'Demo del CRM Pocki');
    assert.equal((await lib.get('r1')).title, 'Demo del CRM Pocki');
    assert.equal(await lib.remove('r1'), true);
    assert.equal(await lib.get('r1'), null);
    assert.deepEqual(await env.files.listIds(), [], 'ni vídeo ni miniatura');
    assert.equal(await env.repo.count(), 0);
    await assert.rejects(lib.getVideo('r1'), RecordingNotFoundError);
    assert.deepEqual(events.map((e) => e.type), ['saved', 'renamed', 'removed']);
  });

  test('reconcile: borra carpetas sin registro y registros sin vídeo; conserva lo correcto', async () => {
    const env = fresh();
    const { lib } = library(env);
    await lib.save({ id: 'ok', format: 'mp4', meta: meta(), video: { blob: new Blob(['v']) } });
    await env.files.writeBlob('huerfana', 'recording.mp4', new Blob(['v'])); // cuelgue antes de los metadatos
    await env.repo.add(record('colgante')); // metadatos sin vídeo
    const result = await lib.reconcile();
    assert.deepEqual(result, { orphanDirs: ['huerfana'], dangling: ['colgante'], orphanTranscripts: [] });
    assert.deepEqual(await env.files.listIds(), ['ok']);
    assert.deepEqual((await lib.list()).map((r) => r.id), ['ok']);
  });

  test('eliminar una grabación borra también su transcripción (y no toca las demás)', async () => {
    const env = fresh();
    const { lib } = library(env);
    for (const id of ['a', 'b']) {
      await lib.save({ id, format: 'mp4', meta: meta(), video: { blob: new Blob(['v']) } });
      await env.transcripts.start(id, { model: 'base', modelRevision: 'rev' });
      await env.transcripts.appendBlock(id, { segments: [{ start: 0, end: 1, text: 'Hola.' }], processedMs: 1000 });
    }
    await lib.remove('a');
    assert.equal(await env.transcripts.get('a'), null, 'transcripción de la grabación eliminada borrada');
    assert.equal((await env.transcripts.get('b')).segments[0].text, 'Hola.', 'la otra transcripción sigue');
  });

  test('reconcile: borra transcripciones huérfanas (grabación inexistente o sin vídeo)', async () => {
    const env = fresh();
    const { lib } = library(env);
    await lib.save({ id: 'ok', format: 'mp4', meta: meta(), video: { blob: new Blob(['v']) } });
    await env.repo.add(record('colgante'));
    for (const id of ['ok', 'colgante', 'fantasma']) await env.transcripts.start(id, { model: 'base', modelRevision: 'rev' });
    const result = await lib.reconcile();
    assert.deepEqual(result.orphanTranscripts.sort(), ['colgante', 'fantasma']);
    assert.deepEqual(await env.transcripts.listIds(), ['ok']);
  });
});
