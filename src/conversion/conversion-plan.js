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
// Nivel H.264 (perfil High) según resolución, FPS y bitrate
// ---------------------------------------------------------------------------

/**
 * Límites de la norma H.264 (Tabla A-1): macrobloques por fotograma (MaxFS),
 * macrobloques por segundo (MaxMBPS) y bitrate máximo del perfil High
 * (MaxBR × 1,25). Mediabunny elige el nivel sin tener en cuenta los FPS
 * (1080p60 saldría como nivel 4.0, que solo admite 1080p30), así que se
 * calcula aquí y se le pasa como codec string completo.
 */
export const H264_LEVELS = Object.freeze([
  { level: 0x1e, name: '3.0', maxFs: 1620, maxMbps: 40_500, maxBr: 12_500_000 },
  { level: 0x1f, name: '3.1', maxFs: 3600, maxMbps: 108_000, maxBr: 17_500_000 },
  { level: 0x20, name: '3.2', maxFs: 5120, maxMbps: 216_000, maxBr: 25_000_000 },
  { level: 0x28, name: '4.0', maxFs: 8192, maxMbps: 245_760, maxBr: 25_000_000 },
  { level: 0x29, name: '4.1', maxFs: 8192, maxMbps: 245_760, maxBr: 62_500_000 },
  { level: 0x2a, name: '4.2', maxFs: 8704, maxMbps: 522_240, maxBr: 62_500_000 },
  { level: 0x32, name: '5.0', maxFs: 22_080, maxMbps: 589_824, maxBr: 168_750_000 },
  { level: 0x33, name: '5.1', maxFs: 36_864, maxMbps: 983_040, maxBr: 300_000_000 },
  { level: 0x34, name: '5.2', maxFs: 36_864, maxMbps: 2_073_600, maxBr: 300_000_000 },
]);

export function h264Level({ width, height, fps, bitrate }) {
  const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = frameMbs * Math.ceil(fps > 0 ? fps : 30);
  return H264_LEVELS.find((l) => frameMbs <= l.maxFs && mbps <= l.maxMbps && bitrate <= l.maxBr) ?? null;
}

/** «avc1.6400XX»: perfil High (0x64), sin restricciones, nivel según FPS. null si no cabe en 5.2. */
export function h264CodecString(params) {
  const level = h264Level(params);
  return level ? `avc1.6400${level.level.toString(16).padStart(2, '0')}` : null;
}

/** FPS de la entrada para nivel/bitrate: se redondea al valor nominal más cercano (30 o 60). */
export const nominalFps = (averageFps) => (averageFps > 45 ? 60 : 30);

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

/** Si se pidieron 60 fps y la captura entregó bastantes menos, se dice (nunca en silencio). */
export function lowFpsNote(requestedFps, actualFps) {
  if (!(requestedFps >= 60) || !(actualFps > 0) || actualFps >= requestedFps * 0.85) return null;
  return `Pediste ${requestedFps} fps, pero la captura entregó ~${Math.round(actualFps)} fps ` +
    '(Chrome solo envía fotogramas cuando el contenido cambia, o el equipo no alcanzó 60 fps). ' +
    'El MP4 conserva todos los fotogramas grabados.';
}

/**
 * Sube el nivel declarado en un avcC (AVCDecoderConfigurationRecord) y en sus SPS.
 *
 * El codificador H.264 de Chrome calcula el nivel solo con la resolución e ignora
 * el pedido: 720p60 sale como nivel 3.1 (comprobado), que solo admite 720p30.
 * Subir level_idc es seguro (todos los límites del nivel superior son ≥) y son
 * bytes en posiciones fijas: avcC[3] y el 4.º byte de cada SPS (cabecera NAL,
 * profile_idc, constraint flags, level_idc). Nunca baja el nivel.
 *
 * @returns {{ description: Uint8Array, codec: string } | null} null si no hace falta o el formato no es el esperado.
 */
export function raiseAvcLevel(description, levelIdc) {
  const src = description instanceof Uint8Array ? description
    : ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
      : new Uint8Array(description);
  if (src.length < 7 || src[0] !== 1 || src[3] >= levelIdc) return null;
  const out = new Uint8Array(src); // copia: no se toca el buffer del codificador
  out[3] = levelIdc;
  const spsCount = out[5] & 0x1f;
  let pos = 6;
  for (let i = 0; i < spsCount; i++) {
    if (pos + 2 > out.length) return null;
    const len = (out[pos] << 8) | out[pos + 1];
    const nal = pos + 2;
    if (len < 4 || nal + len > out.length || (out[nal] & 0x1f) !== 7) return null;
    if (out[nal + 3] < levelIdc) out[nal + 3] = levelIdc;
    pos = nal + len;
  }
  const hex = (b) => b.toString(16).padStart(2, '0');
  return { description: out, codec: `avc1.${hex(out[1])}${hex(out[2])}${hex(levelIdc)}` };
}
