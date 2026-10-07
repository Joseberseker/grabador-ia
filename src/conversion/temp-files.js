/**
 * Archivos temporales de conversión en OPFS (Origin Private File System).
 *
 * El MP4 se escribe aquí de forma incremental, de modo que nunca está entero
 * en RAM. El File que se obtiene al final está respaldado por disco.
 *
 * Todo vive en un único directorio: limpiar huérfanos (p. ej. si Chrome se
 * cerró en mitad de una conversión) es borrar lo que haya en él.
 */

const DIR_NAME = 'conversion-temp';

async function tempDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR_NAME, { create: true });
}

const fileName = (id) => `${id}.mp4`;

/** Crea (o reemplaza) el temporal y abre un stream de escritura con posiciones. */
export async function createTempFile(id) {
  const dir = await tempDir();
  const handle = await dir.getFileHandle(fileName(id), { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  return { name: fileName(id), handle, writable };
}

/** Handle del temporal ya escrito (para moverlo a la biblioteca sin copiarlo). */
export async function getTempFileHandle(id) {
  const dir = await tempDir();
  return { handle: await dir.getFileHandle(fileName(id)), dir };
}

export async function removeTempFile(id) {
  try {
    await (await tempDir()).removeEntry(fileName(id));
    return true;
  } catch (error) {
    if (error?.name === 'NotFoundError') return false;
    throw error;
  }
}

export async function listTempFiles() {
  const dir = await tempDir();
  const files = [];
  for await (const [name, handle] of dir.entries()) {
    const size = handle.kind === 'file' ? (await handle.getFile()).size : 0;
    files.push({ name, size });
  }
  return files;
}

/** Borra todo el directorio temporal salvo `keepIds`. Devuelve los nombres borrados. */
export async function cleanupTempFiles({ keepIds = [] } = {}) {
  const keep = new Set(keepIds.map(fileName));
  const dir = await tempDir();
  const removed = [];
  for await (const [name] of dir.entries()) {
    if (keep.has(name)) continue;
    // También los .crswap que deja createWritable si se interrumpió.
    await dir.removeEntry(name, { recursive: true }).catch(() => {});
    removed.push(name);
  }
  return removed;
}
