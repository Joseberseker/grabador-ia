const pad = (n) => String(n).padStart(2, '0');

/** 65000 -> "01:05", 3725000 -> "1:02:05" */
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** Tiempo restante aproximado: 45000 -> "≈ 45 s", 125000 -> "≈ 2 min 05 s". */
export function formatEta(ms) {
  if (!(ms >= 0)) return '';
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `≈ ${s} s`;
  return `≈ ${Math.floor(s / 60)} min ${pad(s % 60)} s`;
}

/** 1536 -> "1.5 KB" */
export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** -> "grabacion-2026-10-06_14-39-05.webm" (hora local) */
export function buildFileName(date = new Date(), extension = 'webm') {
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const t = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `grabacion-${d}_${t}.${extension}`;
}
