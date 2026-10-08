/**
 * Lógica pura de la biblioteca: forma del registro, títulos, nombres de archivo,
 * agrupación por día y etiquetas. Sin APIs del navegador (testeable en Node).
 */

export const RECORDING_SCHEMA_VERSION = 1;
export const TITLE_MAX_LENGTH = 120;

const pad = (n) => String(n).padStart(2, '0');

/** «Grabación 2026-10-07 13:42» (hora local). */
export function defaultTitle(date = new Date()) {
  return `Grabación ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Valida un título introducido por el usuario. Se recorta, se colapsan los espacios
 * y se quitan caracteres de control. Los duplicados se permiten (cada grabación
 * tiene un id propio).
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function validateTitle(input) {
  // eslint-disable-next-line no-control-regex
  const value = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, error: 'El nombre no puede estar vacío.' };
  if ([...value].length > TITLE_MAX_LENGTH) {
    return { ok: false, error: `El nombre no puede superar ${TITLE_MAX_LENGTH} caracteres.` };
  }
  return { ok: true, value };
}

/** Nombre de archivo seguro para descargar: sin / \ : * ? " < > | ni puntos al final. */
export function sanitizeFileName(title, extension) {
  const base = String(title ?? '')
    .replace(/[/\\:*?"<>|]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|[. ]+$/g, '')
    .slice(0, 100)
    .trim();
  return `${base || 'grabacion'}.${extension}`;
}

/** Construye el registro de metadatos de una grabación terminada. */
export function buildRecording({
  id, createdAt, title, durationMs, width, height, fps, format, mimeType, fileName, fileSize,
  hasTabAudio = false, hasMicrophone = false, sourceType = null, thumbnailFileName = null, videoCodec = null,
}) {
  if (!id) throw new TypeError('buildRecording: falta id');
  if (!['mp4', 'webm'].includes(format)) throw new TypeError(`buildRecording: formato no válido (${format})`);
  if (!fileName) throw new TypeError('buildRecording: falta fileName');
  const created = createdAt ?? Date.now();
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    id,
    title: validateTitle(title).ok ? validateTitle(title).value : defaultTitle(new Date(created)),
    createdAt: created,
    durationMs: Math.max(0, Math.round(durationMs ?? 0)),
    width: width ?? null,
    height: height ?? null,
    fps: fps ? Math.round(fps) : null,
    format,
    mimeType: mimeType ?? (format === 'mp4' ? 'video/mp4' : 'video/webm'),
    videoCodec,
    fileName,
    fileSize: fileSize ?? 0,
    hasAudio: !!(hasTabAudio || hasMicrophone),
    hasTabAudio: !!hasTabAudio,
    hasMicrophone: !!hasMicrophone,
    sourceType, // 'browser' (pestaña) | 'window' | 'monitor' (pantalla) | null
    thumbnailFileName,
    status: 'ready',
  };
}

/** Más recientes primero. */
export const sortRecordings = (records) => [...records].sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)));

const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Agrupa por día: «Hoy», «Ayer» o la fecha. Mantiene el orden (más recientes primero). */
export function groupByDay(records, now = Date.now()) {
  const today = startOfDay(now);
  const yesterday = today - 86_400_000;
  const groups = [];
  for (const record of sortRecordings(records)) {
    const day = startOfDay(record.createdAt);
    const label = day === today ? 'Hoy' : day === yesterday ? 'Ayer'
      : new Date(day).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
    if (groups.at(-1)?.day !== day) groups.push({ day, label, items: [] });
    groups.at(-1).items.push(record);
  }
  return groups;
}

/** «1080p», «720p» o «1918×992» si no es estándar. */
export function resolutionLabel({ width, height } = {}) {
  if (!width || !height) return null;
  const short = Math.min(width, height);
  for (const p of [2160, 1440, 1080, 720, 480]) if (Math.abs(short - p) <= p * 0.1) return `${p}p`;
  return `${width}×${height}`;
}

export const SOURCE_LABEL = Object.freeze({ browser: 'Pestaña', window: 'Ventana', monitor: 'Pantalla' });

/** «MP4 · 1080p · 30 FPS» */
export function formatSummary(record) {
  return [record.format?.toUpperCase(), resolutionLabel(record), record.fps ? `${record.fps} FPS` : null]
    .filter(Boolean)
    .join(' · ');
}
