/**
 * Biblioteca de grabaciones: une metadatos (IndexedDB), archivos (OPFS) y miniaturas.
 *
 * Orden de guardado, pensado para cuelgues: 1) vídeo en OPFS, 2) miniatura,
 * 3) metadatos. Si Chrome muere antes del paso 3 queda una carpeta sin registro,
 * que reconcile() borra al arrancar. Si falta el vídeo de un registro, también se
 * elimina el registro. Nunca hay un registro «listo» sin su vídeo.
 *
 * La transcripción (fase 6) depende de la grabación: se borra con ella y reconcile()
 * elimina las que hayan quedado huérfanas.
 *
 * Cambios → BroadcastChannel: popup, controlador y biblioteca se actualizan solos.
 */

import { createLibraryRepository, RecordingNotFoundError } from './library-repository.js';
import { createLibraryFiles } from './library-files.js';
import { generateThumbnail, THUMBNAIL_FILE } from './thumbnail.js';
import { buildRecording, validateTitle } from './recording-meta.js';
import { createTranscriptRepository } from '../transcription/transcript-repository.js';

export const LIBRARY_CHANNEL = 'recorder-library';

export class TitleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TitleError';
  }
}

const broadcast = (event) => {
  try {
    const channel = new BroadcastChannel(LIBRARY_CHANNEL);
    channel.postMessage(event);
    channel.close();
  } catch {
    // BroadcastChannel no disponible (tests): sin notificación
  }
};

export function createLibrary({
  repo = createLibraryRepository(),
  files = createLibraryFiles(),
  transcripts = createTranscriptRepository(),
  loadMediabunny = null,
  makeThumbnail = (file) => generateThumbnail(file, { loadMediabunny }),
  notify = broadcast,
} = {}) {
  /**
   * Guarda una grabación terminada.
   * @param {{ id: string, format: 'mp4'|'webm', meta: object,
   *           video: { handle: FileSystemFileHandle, sourceDir?: FileSystemDirectoryHandle } | { blob: Blob } }} params
   * @returns {Promise<{ record: object, file: File }>}
   */
  async function save({ id, format, meta, video }) {
    const fileName = `recording.${format}`;
    try {
      const file = video.handle
        ? await files.adoptFile(id, video.handle, fileName, { sourceDir: video.sourceDir })
        : await files.writeBlob(id, fileName, video.blob);
      let thumbnailFileName = null;
      try {
        await files.writeBlob(id, THUMBNAIL_FILE, await makeThumbnail(file));
        thumbnailFileName = THUMBNAIL_FILE;
      } catch (error) {
        // Sin miniatura la grabación sigue siendo válida: la UI muestra un marcador.
        console.warn('[library] miniatura no generada:', error?.message ?? error);
      }
      const record = buildRecording({ ...meta, id, format, fileName, fileSize: file.size, thumbnailFileName });
      await repo.add(record);
      notify({ type: 'saved', id });
      return { record, file };
    } catch (error) {
      await files.remove(id).catch(() => {});
      throw error;
    }
  }

  async function getVideo(id) {
    const record = await repo.get(id);
    if (!record) throw new RecordingNotFoundError(id);
    const file = await files.getFile(id, record.fileName);
    if (!file) throw new Error(`El archivo de «${record.title}» no está disponible.`);
    return { record, file };
  }

  const getThumbnail = (record) => (record?.thumbnailFileName ? files.getFile(record.id, record.thumbnailFileName) : Promise.resolve(null));

  async function rename(id, title) {
    const result = validateTitle(title);
    if (!result.ok) throw new TitleError(result.error);
    const record = await repo.update(id, { title: result.value });
    notify({ type: 'renamed', id });
    return record;
  }

  /** Borra vídeo, miniatura, metadatos y transcripción. Devuelve false si no existía. */
  async function remove(id) {
    await files.remove(id);
    const existed = await repo.remove(id);
    await transcripts.remove(id);
    notify({ type: 'removed', id });
    return existed;
  }

  /** Coherencia OPFS ↔ IndexedDB tras un cuelgue (solo con la extensión inactiva). */
  async function reconcile() {
    const records = await repo.list();
    const known = new Set(records.map((r) => r.id));
    const orphanDirs = (await files.listIds()).filter((id) => !known.has(id));
    for (const id of orphanDirs) await files.remove(id);
    const dangling = [];
    for (const record of records) {
      if (!(await files.getFile(record.id, record.fileName))) {
        await repo.remove(record.id);
        await files.remove(record.id);
        dangling.push(record.id);
      }
    }
    const alive = new Set(records.map((r) => r.id).filter((id) => !dangling.includes(id)));
    const orphanTranscripts = (await transcripts.listIds()).filter((id) => !alive.has(id));
    for (const id of orphanTranscripts) await transcripts.remove(id);
    if (orphanDirs.length || dangling.length || orphanTranscripts.length) notify({ type: 'reconciled' });
    return { orphanDirs, dangling, orphanTranscripts };
  }

  return { save, list: () => repo.list(), get: (id) => repo.get(id), getVideo, getThumbnail, rename, remove, reconcile };
}
