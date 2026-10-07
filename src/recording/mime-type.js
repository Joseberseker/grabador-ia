/** Formatos WebM por orden de preferencia, con y sin pista de audio. */
export const WEBM_CANDIDATES = Object.freeze([
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]);

export const WEBM_VIDEO_ONLY_CANDIDATES = Object.freeze([
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]);

/**
 * Devuelve el primer mimeType soportado, o '' para dejar que el navegador elija.
 * `isTypeSupported` es inyectable para poder testearlo fuera del navegador.
 */
export function pickMimeType(
  isTypeSupported = (type) => MediaRecorder.isTypeSupported(type),
  candidates = WEBM_CANDIDATES,
) {
  return candidates.find((type) => isTypeSupported(type)) ?? '';
}

export function mimeCandidates(hasAudio) {
  return hasAudio ? WEBM_CANDIDATES : WEBM_VIDEO_ONLY_CANDIDATES;
}
