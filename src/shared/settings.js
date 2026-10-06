/**
 * Preferencias del usuario, en chrome.storage.local (sobreviven a reinicios).
 * Se aplican a la SIGUIENTE grabación; no cambian una grabación en curso.
 */

export const RESOLUTION_OPTIONS = Object.freeze(['auto', '720p', '1080p']);
export const FPS_OPTIONS = Object.freeze([30, 60]);
export const QUALITY_OPTIONS = Object.freeze(['auto', 'high', 'max']);
export const COUNTDOWN_OPTIONS = Object.freeze([0, 3]);
export const EXPORT_FORMAT_OPTIONS = Object.freeze(['mp4', 'webm']);

export const DEFAULT_SETTINGS = Object.freeze({
  micEnabled: false, // nunca activo por defecto: requiere acción y permiso explícitos
  tabAudio: true,
  resolution: 'auto',
  fps: 30,
  quality: 'auto',
  countdown: 0,
  exportFormat: 'mp4', // MP4 (H.264 + AAC, máxima compatibilidad) o WebM original sin convertir
  autoDownload: true, // además de guardarse en la biblioteca, se descarga al terminar (comportamiento previo)
});

const STORAGE_KEY = 'settings';

/** Corrige valores ausentes o inválidos (p. ej. de versiones antiguas). Pura. */
export function normalizeSettings(raw = {}) {
  const pick = (value, options, fallback) => (options.includes(value) ? value : fallback);
  return {
    micEnabled: raw.micEnabled === true,
    tabAudio: raw.tabAudio !== false,
    resolution: pick(raw.resolution, RESOLUTION_OPTIONS, DEFAULT_SETTINGS.resolution),
    fps: pick(Number(raw.fps), FPS_OPTIONS, DEFAULT_SETTINGS.fps),
    quality: pick(raw.quality, QUALITY_OPTIONS, DEFAULT_SETTINGS.quality),
    countdown: pick(Number(raw.countdown), COUNTDOWN_OPTIONS, DEFAULT_SETTINGS.countdown),
    exportFormat: pick(raw.exportFormat, EXPORT_FORMAT_OPTIONS, DEFAULT_SETTINGS.exportFormat),
    autoDownload: raw.autoDownload !== false,
  };
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeSettings(stored[STORAGE_KEY]);
}

export async function saveSettings(patch) {
  const next = normalizeSettings({ ...(await getSettings()), ...patch });
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export function onSettingsChange(callback) {
  const listener = (changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEY]) callback(normalizeSettings(changes[STORAGE_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
