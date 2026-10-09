/**
 * Utilidades puras de texto para las transcripciones (sin DOM ni modelo: testeables en Node).
 * El texto se guarda tal como lo produce Whisper (UTF-8, con tildes, ñ, ¿¡ y puntuación);
 * aquí solo se normalizan espacios y se filtran alucinaciones conocidas.
 */

import { sanitizeFileName } from '../library/recording-meta.js';

/** Frases que Whisper «inventa» con silencio, música o ruido (vienen de subtítulos de entrenamiento). */
const HALLUCINATIONS = [
  /subt[ií]tulos? (realizados? )?(por|de) la comunidad de amara\.org/i,
  /^subt[ií]tulos? (por|de|realizados por) /i,
  /^¡?suscr[ií]bete( al canal)?!?\.?$/i,
  /^gracias por ver( el v[ií]deo)?\.?!?$/i,
  /^[[(*]?\s*(m[uú]sica|aplausos|risas)\s*[\])*]?\.?$/i,
  /^\.+$/,
];

export const isHallucination = (text) => HALLUCINATIONS.some((re) => re.test(text.trim()));

/** Colapsa espacios (Whisper antepone uno a cada fragmento) sin tocar letras ni puntuación. */
export const cleanText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

const round = (seconds) => Math.round(seconds * 100) / 100;

/**
 * Convierte la salida del pipeline de transformers.js ({ text, chunks: [{ timestamp: [s, e], text }] })
 * en segmentos absolutos de la grabación.
 * @param {{ text?: string, chunks?: Array<{ timestamp: [number, number|null], text: string }> }} output
 * @param {number} offsetSec   inicio del bloque dentro de la grabación
 * @param {number} blockSec    duración del bloque (cierra el último fragmento si no trae fin)
 * @param {{ text: string } | null} [previous] último segmento ya guardado (para descartar repeticiones)
 */
export function toSegments(output, offsetSec, blockSec, previous = null) {
  const chunks = output?.chunks?.length ? output.chunks : output?.text ? [{ timestamp: [0, blockSec], text: output.text }] : [];
  const segments = [];
  let last = previous ? cleanText(previous.text) : null;
  for (const chunk of chunks) {
    const text = cleanText(chunk.text);
    if (!text || isHallucination(text)) continue;
    if (text === last) continue; // bucle de repetición típico de Whisper
    const [s, e] = chunk.timestamp ?? [0, blockSec];
    const start = Math.min(Math.max(0, s ?? 0), blockSec);
    const end = Math.min(Math.max(start, e ?? blockSec), blockSec);
    segments.push({ start: round(offsetSec + start), end: round(offsetSec + end), text });
    last = text;
  }
  return segments;
}

/** 83.4 → "1:23"; 3723 → "1:02:03" (como el reproductor). */
export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Texto corrido (para copiar o descargar sin marcas de tiempo). */
export const transcriptToText = (segments) => cleanText(segments.map((s) => s.text).join(' '));

/** Una línea por segmento: «[1:23] texto». */
export const transcriptToTimestampedText = (segments) =>
  segments.map((s) => `[${formatTimestamp(s.start)}] ${s.text}`).join('\n');

/** Contenido del .txt descargable. */
export function buildTxt({ title, segments, withTimestamps }) {
  const body = withTimestamps ? transcriptToTimestampedText(segments) : transcriptToText(segments);
  return `${title}\n\n${body}\n`;
}

/** Nombre del .txt a partir del título de la grabación (mismas reglas que el vídeo). */
export const txtFileName = (title) => sanitizeFileName(`${String(title ?? '').slice(0, 80)} - transcripción`, 'txt');

/** Índice del segmento que contiene el instante `t` (búsqueda binaria; -1 si ninguno). */
export function segmentAt(segments, t) {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && t < Math.max(segments[found].end, segments[found].start + 0.5) ? found : -1;
}
