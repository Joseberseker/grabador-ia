/**
 * Miniatura de una grabación: un fotograma cercano al inicio, reducido a 320×180
 * como máximo (conservando la proporción) y codificado en JPEG (~10–30 KB).
 *
 * Solo se decodifica UN fotograma con Mediabunny (WebCodecs), que ya está cargado
 * en el offscreen para la conversión.
 */

export const THUMBNAIL_MAX = Object.freeze({ width: 320, height: 180 });
export const THUMBNAIL_FILE = 'thumbnail.jpg';
const THUMBNAIL_QUALITY = 0.8;
/** Instante de la miniatura: 1 s, o la mitad si la grabación dura menos de 2 s. */
export const thumbnailTime = (durationS) => (durationS >= 2 ? 1 : Math.max(0, durationS / 2));

export class ThumbnailError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'ThumbnailError';
  }
}

/** Cabe en `max` conservando la proporción, sin ampliar y con dimensiones pares. */
export function thumbnailSize(width, height, max = THUMBNAIL_MAX) {
  if (!(width > 0) || !(height > 0)) throw new ThumbnailError('Dimensiones de vídeo no válidas.');
  const scale = Math.min(1, max.width / width, max.height / height);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

/**
 * @param {Blob} file  vídeo (MP4 o WebM), normalmente un File de OPFS
 * @param {{ loadMediabunny: () => Promise<any>, createCanvas?: (w: number, h: number) => OffscreenCanvas }} deps
 * @returns {Promise<Blob>} JPEG
 */
export async function generateThumbnail(file, { loadMediabunny, createCanvas = (w, h) => new OffscreenCanvas(w, h) }) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new ThumbnailError('El vídeo no se puede decodificar.');
    const size = thumbnailSize(track.displayWidth, track.displayHeight);
    const start = await track.getFirstTimestamp();
    const sink = new mb.CanvasSink(track, { width: size.width, height: size.height, fit: 'contain' });
    const frame = (await sink.getCanvas(start + thumbnailTime(await track.computeDuration()))) ?? (await sink.getCanvas(start));
    if (!frame) throw new ThumbnailError('No se encontró ningún fotograma para la miniatura.');
    const canvas = createCanvas(size.width, size.height);
    canvas.getContext('2d').drawImage(frame.canvas, 0, 0, size.width, size.height);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMBNAIL_QUALITY });
  } catch (error) {
    if (error instanceof ThumbnailError) throw error;
    throw new ThumbnailError(`No se pudo generar la miniatura: ${error?.message ?? error}`, { cause: error });
  } finally {
    input.dispose?.();
  }
}
