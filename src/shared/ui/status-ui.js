import { ExportPhase, Status } from '../state.js';

/** Icono y etiqueta visibles de cada estado. */
export const STATUS_UI = Object.freeze({
  [Status.IDLE]: { icon: '●', label: 'LISTO' },
  [Status.SELECTING]: { icon: '◌', label: 'ELIGE QUÉ GRABAR' },
  [Status.COUNTDOWN]: { icon: '⏱', label: 'PREPARADO' },
  [Status.RECORDING]: { icon: '🔴', label: 'GRABANDO' },
  [Status.PAUSED]: { icon: '⏸', label: 'PAUSADO' },
  [Status.SAVING]: { icon: '⋯', label: 'GUARDANDO' },
  [Status.EXPORTING]: { icon: '⚙', label: 'CONVIRTIENDO' },
  [Status.EXPORT_FAILED]: { icon: '⚠', label: 'ERROR' },
  [Status.FINISHED]: { icon: '✓', label: 'FINALIZADO' },
});

const EXPORT_PHASE_LABEL = Object.freeze({
  [ExportPhase.PREPARING]: 'PREPARANDO',
  [ExportPhase.CONVERTING]: 'CONVIRTIENDO',
  [ExportPhase.FINALIZING]: 'FINALIZANDO',
  [ExportPhase.SAVING]: 'GUARDANDO',
  [ExportPhase.DOWNLOADING]: 'DESCARGANDO',
});

/** Icono y etiqueta del estado, incluida la fase de exportación. */
export function statusUi(state) {
  const base = STATUS_UI[state?.status] ?? { icon: '?', label: String(state?.status) };
  if (state?.status === Status.EXPORTING) {
    return { icon: base.icon, label: EXPORT_PHASE_LABEL[state.export?.phase] ?? base.label };
  }
  if (state?.status === Status.EXPORT_FAILED && state.export?.cancelled) return { icon: '⊘', label: 'CANCELADO' };
  return base;
}

/**
 * Qué botones se ven en cada estado. Un único lugar para la máquina de estados
 * de la UI, compartido por popup y controlador.
 */
export const VISIBLE_ACTIONS = Object.freeze({
  [Status.IDLE]: ['start'],
  [Status.SELECTING]: ['cancel'],
  [Status.COUNTDOWN]: ['cancel'],
  [Status.RECORDING]: ['pause', 'stop'],
  [Status.PAUSED]: ['resume', 'stop'],
  [Status.SAVING]: [],
  [Status.EXPORTING]: ['cancel-export'],
  [Status.EXPORT_FAILED]: ['retry-export', 'download-webm', 'discard'],
  [Status.FINISHED]: ['start'],
});

/** Texto de cada fuente de audio para la UI. */
export const AUDIO_UI = Object.freeze({
  mic: Object.freeze({ on: '● ON', off: '○ OFF', error: '⚠ Sin acceso' }),
  tab: Object.freeze({ on: '● ON', off: '○ OFF', unavailable: '— No disponible' }),
});
