/**
 * Cálculos puros de la conversión a MP4 (sin APIs del navegador: testeables en Node).
 */

// ---------------------------------------------------------------------------
// Bitrate H.264
// ---------------------------------------------------------------------------

/**
 * Bits por píxel y fotograma de H.264 según la calidad. Elegidos con la prueba
 * de la Fase 4B (ver README): con «auto», el texto de pantalla sigue nítido
 * con archivos claramente menores que el preset «high» del benchmark.
 */
export const H264_BITS_PER_PIXEL = Object.freeze({ auto: 0.06, high: 0.09, max: 0.14 });
const MIN_VIDEO_BPS = 500_000;
const MAX_VIDEO_BPS = 20_000_000;

export function h264Bitrate({ width, height, fps, quality = 'auto' }) {
  const bpp = H264_BITS_PER_PIXEL[quality] ?? H264_BITS_PER_PIXEL.auto;
  const frameRate = fps > 0 ? Math.min(fps, 60) : 30;
  const bps = width * height * frameRate * bpp;
  return Math.round(Math.min(MAX_VIDEO_BPS, Math.max(MIN_VIDEO_BPS, bps)));
}

export const aacBitrate = (quality = 'auto') => (quality === 'max' ? 192_000 : 128_000);

// ---------------------------------------------------------------------------
// Espacio temporal
// ---------------------------------------------------------------------------

/** Holgura sobre el tamaño estimado: el modo VBR de H.264 puede superar el objetivo. */
export const SIZE_SAFETY_FACTOR = 1.25;
/** Margen fijo: índice MP4 reservado, archivo swap de OPFS y otros datos de la extensión. */
export const FIXED_MARGIN_BYTES = 64 * 1024 * 1024;

export function estimateMp4Bytes({ durationS, videoBitrate, audioBitrate = 0 }) {
  return Math.ceil((durationS * (videoBitrate + audioBitrate)) / 8);
}

/**
 * Espacio temporal necesario en el almacenamiento de la extensión. El WebM de
 * entrada ya está en IndexedDB (ya cuenta como «usado»), así que solo se suma
 * el MP4 temporal con holgura y el margen fijo.
 */
export function requiredTempBytes(estimate) {
  return Math.ceil(estimate * SIZE_SAFETY_FACTOR) + FIXED_MARGIN_BYTES;
}

export function checkSpace({ quota, usage }, required) {
  const available = Math.max(0, (quota ?? 0) - (usage ?? 0));
  return { ok: available >= required, available, required };
}

// ---------------------------------------------------------------------------
// Pistas: número máximo de paquetes (necesario para fastStart: 'reserve')
// ---------------------------------------------------------------------------

export const AAC_FRAME_SAMPLES = 1024;

/** Vídeo: un paquete por fotograma de entrada (la conversión es 1:1) más margen. */
export const maxVideoPackets = (inputPackets) => Math.ceil(inputPackets * 1.02) + 16;

/** AAC: 1024 muestras por paquete, más priming y margen. */
export const maxAacPackets = (durationS, sampleRate) =>
  Math.ceil((durationS * sampleRate) / AAC_FRAME_SAMPLES * 1.02) + 32;

// ---------------------------------------------------------------------------
// Tiempo de fotogramas
// ---------------------------------------------------------------------------

/**
 * Duración de un fotograma a partir del siguiente. Los WebM de MediaRecorder no
 * escriben BlockDuration y el demuxer deja a 0 la duración de algunos bloques
 * (7,6 % en nuestras grabaciones). La conversión estándar de Mediabunny descarta
 * esos fotogramas, así que la duración se recalcula aquí.
 */
export function frameDuration(timestamp, nextTimestamp, fallback) {
  if (nextTimestamp != null) {
    const delta = nextTimestamp - timestamp;
    if (delta > 0) return delta;
  }
  return fallback > 0 ? fallback : 1 / 30;
}

/** Timestamp de salida estrictamente creciente (requisito del contenedor MP4). */
export function monotonicTimestamp(timestamp, previous) {
  return previous != null && timestamp <= previous ? previous + 0.001 : timestamp;
}

/**
 * Compensación del retardo del codificador AAC: 1024 muestras de «priming»
 * (≈ 21 ms a 48 kHz). Se adelanta el audio y el muxer lo reajusta con una edit list.
 */
export const aacPrimingSeconds = (sampleRate) => (sampleRate > 0 ? AAC_FRAME_SAMPLES / sampleRate : 0);

// ---------------------------------------------------------------------------
// Progreso
// ---------------------------------------------------------------------------

/** Tiempo restante estimado (ms) o null si aún no es fiable. */
export function estimateEtaMs(progress, elapsedMs) {
  if (!(progress >= 0.03) || !(elapsedMs >= 1500) || progress >= 1) return progress >= 1 ? 0 : null;
  return Math.round((elapsedMs * (1 - progress)) / progress);
}

/**
 * Mantiene las pistas a la par (como mucho `maxLeadS` segundos de diferencia)
 * para que el MP4 quede intercalado y no se acumulen muestras de una sola pista.
 */
export class TrackPacer {
  #positions = new Map();
  #finished = new Set();
  #waiters = [];
  #maxLeadS;

  constructor(tracks, maxLeadS = 1) {
    for (const track of tracks) this.#positions.set(track, -Infinity);
    this.#maxLeadS = maxLeadS;
  }

  /** Registra la posición de `track` y espera si va demasiado adelantada. */
  async advance(track, timestamp) {
    this.#positions.set(track, timestamp);
    this.#wake();
    while (this.#isAhead(track)) {
      await new Promise((resolve) => this.#waiters.push(resolve));
    }
  }

  finish(track) {
    this.#finished.add(track);
    this.#wake();
  }

  #isAhead(track) {
    const position = this.#positions.get(track);
    for (const [other, otherPosition] of this.#positions) {
      if (other !== track && !this.#finished.has(other) && position - otherPosition > this.#maxLeadS) return true;
    }
    return false;
  }

  #wake() {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}
