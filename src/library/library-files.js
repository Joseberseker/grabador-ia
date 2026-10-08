/**
 * Archivos de la biblioteca en OPFS (Origin Private File System):
 *
 *   library/<id>/recording.mp4 | recording.webm   el vídeo
 *   library/<id>/thumbnail.jpg                    la miniatura
 *
 * Nada pasa por RAM entera: el MP4 se MUEVE desde el temporal de conversión
 * (sin copiar), el WebM se escribe por stream desde los fragmentos de IndexedDB,
 * y la lectura devuelve File respaldados por disco (preview y descarga hacen
 * streaming).
 */

const ROOT_DIR = 'library';

/** @param {{ getRoot?: () => Promise<FileSystemDirectoryHandle> }} [deps] */
export function createLibraryFiles({ getRoot = () => navigator.storage.getDirectory() } = {}) {
  const libraryDir = async () => (await getRoot()).getDirectoryHandle(ROOT_DIR, { create: true });
  const recordingDir = async (id, create = false) => (await libraryDir()).getDirectoryHandle(id, { create });

  /** Escribe un Blob por stream (no lo lee entero en memoria). */
  async function writeBlob(id, name, blob) {
    const handle = await (await recordingDir(id, true)).getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await blob.stream().pipeTo(writable); // pipeTo cierra el writable al terminar
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    return handle.getFile();
  }

  /**
   * Incorpora un archivo de OPFS (p. ej. el MP4 temporal de conversión) moviéndolo:
   * sin copia y sin pasar por RAM. Si el navegador no admite move(), copia por stream
   * y borra el original.
   */
  async function adoptFile(id, sourceHandle, name, { sourceDir = null } = {}) {
    const dir = await recordingDir(id, true);
    if (typeof sourceHandle.move === 'function') {
      try {
        await sourceHandle.move(dir, name);
        return (await dir.getFileHandle(name)).getFile();
      } catch (error) {
        if (error?.name !== 'NotSupportedError' && error?.name !== 'TypeError') throw error;
      }
    }
    const file = await writeBlob(id, name, await sourceHandle.getFile());
    await sourceDir?.removeEntry(sourceHandle.name).catch(() => {});
    return file;
  }

  async function getFile(id, name) {
    try {
      return await (await (await recordingDir(id)).getFileHandle(name)).getFile();
    } catch (error) {
      if (error?.name === 'NotFoundError') return null;
      throw error;
    }
  }

  /** Borra la carpeta completa de la grabación (vídeo + miniatura). */
  async function remove(id) {
    try {
      await (await libraryDir()).removeEntry(id, { recursive: true });
      return true;
    } catch (error) {
      if (error?.name === 'NotFoundError') return false;
      throw error;
    }
  }

  /** Ids con carpeta en OPFS (para detectar huérfanos). */
  async function listIds() {
    const ids = [];
    for await (const [name, handle] of (await libraryDir()).entries()) {
      if (handle.kind === 'directory') ids.push(name);
    }
    return ids;
  }

  return { writeBlob, adoptFile, getFile, remove, listIds };
}
