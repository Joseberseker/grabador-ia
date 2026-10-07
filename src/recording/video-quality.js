/**
 * Resolución, FPS y bitrate de forma segura.
 *
 * - getDisplayMedia se llama SIN restricciones de tamaño (solo FPS max/ideal,
 *   que nunca provocan OverconstrainedError). Comprobado en Chrome 155: en
 *   captura de pestaña, `width/height.max` funciona como tamaño objetivo y Chrome
 *   AMPLÍA una pestaña de 780 px a 1920×1080.
 * - Se mide el tamaño REAL de los fotogramas (measureFrameSize). En captura de
 *   pestaña, getSettings() informa del tamaño de la pantalla y no del contenido.
 * - Con ese tamaño se calcula el objetivo: el pedido, como mucho, y nunca mayor
 *   que la fuente, conservando la proporción. Se fija SIEMPRE de forma explícita
 *   (también en «Automática»): comprobado en Chrome 155, un applyConstraints sin
 *   tamaño hace que la captura de pestaña vuelva al tamaño de la pantalla, es
 *   decir, que amplíe. Luego se negocia con track.applyConstraints(), de más a
 *   menos exigente. Reintentar getDisplayMedia no es una opción: volvería a abrir el
 *   selector.
 * - MediaRecorder se crea probando opciones de más a menos específicas.
 */

export const RESOLUTIONS = Object.freeze({
  auto: null,
  '720p': Object.freeze({ width: 1280, height: 720 }),
  '1080p': Object.freeze({ width: 1920, height: 1080 }),
});

const FALLBACK_FPS = 30;

const even = (n) => Math.max(2, Math.round(n / 2) * 2); // los códecs prefieren dimensiones pares

/**
 * Tamaño objetivo: cabe en la resolución pedida, conserva la proporción y nunca
 * supera la fuente (si ya cabe, es el tamaño nativo). null = fuente desconocida.
 */
export function targetSize(resolution, native) {
  if (!native?.width || !native?.height) return null;
  const box = RESOLUTIONS[resolution];
  const scale = box ? Math.min(1, box.width / native.width, box.height / native.height) : 1;
  if (scale === 1) return { width: native.width, height: native.height };
  return { width: even(native.width * scale), height: even(native.height * scale) };
}

function sizeConstraints(target) {
  return target ? { width: { max: target.width }, height: { max: target.height } } : {};
}

const fpsConstraints = (fps) => ({ frameRate: { ideal: fps, max: fps } });

/** Opciones de getDisplayMedia para unos ajustes (sin tamaño: ver cabecera). */
export function buildDisplayMediaOptions(settings) {
  return {
    video: { ...fpsConstraints(settings.fps) },
    audio: settings.tabAudio, // false = Chrome ni siquiera ofrece compartir audio
    surfaceSwitching: 'include',
    systemAudio: 'include', // ignorado donde no existe (Linux)
  };
}

/** Combinaciones a probar con applyConstraints, de más a menos exigente y sin duplicados. */
export function constraintAttempts(settings, native = null) {
  const size = sizeConstraints(targetSize(settings.resolution, native));
  const candidates = [
    { label: 'requested', constraints: { ...size, ...fpsConstraints(settings.fps) } },
    { label: 'fps-fallback', constraints: { ...size, ...fpsConstraints(FALLBACK_FPS) } },
    { label: 'resolution-fallback', constraints: { ...fpsConstraints(settings.fps) } },
    { label: 'native', constraints: {} },
  ];
  const seen = new Set();
  return candidates.filter(({ constraints }) => {
    const key = JSON.stringify(constraints);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Tamaño real de los fotogramas del track, leído con un <video> fuera del DOM.
 * Si no se puede medir a tiempo, usa getSettings().
 */
export async function measureFrameSize(track, { doc = globalThis.document, timeoutMs = 2000 } = {}) {
  const fallback = () => {
    const s = track.getSettings?.() ?? {};
    return { width: s.width, height: s.height };
  };
  if (!doc) return fallback();
  const video = doc.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  try {
    const size = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      video.addEventListener('loadedmetadata', () => {
        clearTimeout(timer);
        resolve(video.videoWidth ? { width: video.videoWidth, height: video.videoHeight } : null);
      });
      video.play?.().catch(() => {});
    });
    return size ?? fallback();
  } finally {
    video.pause?.();
    video.srcObject = null;
  }
}

/**
 * Aplica la mejor combinación que el track acepte y describe el resultado.
 * `native` = tamaño real de la fuente (measureFrameSize); por defecto, getSettings().
 * @returns {Promise<{ width, height, frameRate, native, applied: string, fallback: boolean }>}
 */
export async function negotiateVideoTrack(track, settings, native = null) {
  if (!native?.width) {
    const initial = track.getSettings?.() ?? {};
    native = { width: initial.width, height: initial.height };
  }
  let applied = 'none';
  for (const attempt of constraintAttempts(settings, native)) {
    try {
      await track.applyConstraints(attempt.constraints);
      applied = attempt.label;
      break;
    } catch {
      // combinación no soportada: probamos la siguiente
    }
  }
  const s = track.getSettings?.() ?? {};
  return {
    width: s.width ?? null,
    height: s.height ?? null,
    frameRate: s.frameRate ? Math.round(s.frameRate) : null,
    native,
    applied,
    fallback: applied !== 'requested',
  };
}

/** Bitrate de vídeo según la calidad y la resolución/FPS REALES. undefined = el navegador decide. */
export function videoBitrate(quality, { width, height, frameRate } = {}) {
  if (quality === 'auto' || !width || !height) return undefined;
  const pixelsPerSecond = width * height * (frameRate || FALLBACK_FPS);
  const bitsPerPixel = quality === 'max' ? 0.2 : 0.1; // 1080p30: alta ≈ 6,2 Mbps, máxima ≈ 12,4 Mbps
  const ceiling = quality === 'max' ? 25_000_000 : 12_000_000;
  return Math.round(Math.min(ceiling, Math.max(1_000_000, pixelsPerSecond * bitsPerPixel)));
}

export function audioBitrate(quality) {
  return { high: 128_000, max: 192_000 }[quality];
}

/** Opciones de MediaRecorder de más a menos específicas, sin claves undefined ni duplicados. */
export function recorderOptionAttempts({ mimeType, videoBitsPerSecond, audioBitsPerSecond }) {
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
  const candidates = [
    clean({ mimeType, videoBitsPerSecond, audioBitsPerSecond }),
    clean({ mimeType }),
    {},
  ];
  const seen = new Set();
  return candidates.filter((o) => {
    const key = JSON.stringify(o);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Crea el MediaRecorder con la primera combinación de opciones aceptada. */
export function createMediaRecorder(stream, attempts, RecorderCtor = globalThis.MediaRecorder) {
  let lastError;
  for (const options of attempts) {
    try {
      return { recorder: new RecorderCtor(stream, options), options };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('No se pudo crear MediaRecorder.');
}
