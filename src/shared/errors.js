/**
 * Traduce los errores de getDisplayMedia / MediaRecorder a mensajes claros.
 * Devuelve un objeto serializable `{ code, message }` apto para chrome.storage.
 */

const MESSAGES = {
  NotAllowedError:
    'Grabación cancelada: no se seleccionó nada para compartir. ' +
    'Si no cancelaste tú, revisa que el sistema permita a Chrome capturar la pantalla.',
  InvalidStateError: 'Chrome no pudo abrir el selector de pantalla en este momento. Inténtalo de nuevo.',
  NotFoundError: 'No se encontró ninguna fuente de captura disponible.',
  NotReadableError:
    'No se pudo acceder a la fuente seleccionada. Puede que otra aplicación la esté usando ' +
    'o que el sistema operativo lo impida (en Linux/Wayland, revisa el portal de captura).',
  AbortError: 'La captura se interrumpió antes de empezar. Inténtalo de nuevo.',
  NotSupportedError: 'Este navegador no permite grabar con la configuración solicitada.',
  SecurityError: 'Chrome bloqueó la captura por motivos de seguridad.',
  TypeError: 'Este navegador no soporta la captura de pantalla con estas opciones.',
};

export const UNSUPPORTED_ERROR = Object.freeze({
  code: 'Unsupported',
  message:
    'Tu navegador no soporta getDisplayMedia o MediaRecorder. Actualiza Chrome a una versión reciente.',
});

export function toUserError(error) {
  const code = error?.name || 'UnknownError';
  const message =
    MESSAGES[code] ??
    `Error inesperado: ${error?.message || String(error) || 'desconocido'}`;
  return { code, message };
}

/** El usuario cerró el selector sin elegir nada (no es un fallo real). */
export function isUserCancellation(userError) {
  return userError?.code === 'NotAllowedError';
}
