/** Errores de transcripción con un código estable (se guarda en IndexedDB y decide el mensaje de la UI). */

export const ErrorCode = Object.freeze({
  NO_AUDIO: 'no-audio', // la grabación no tiene pista de audio
  DECODE: 'decode', // Chrome no puede decodificar el audio
  MODEL_DOWNLOAD: 'model-download', // sin conexión o descarga del modelo fallida
  MODEL_LOAD: 'model-load', // el runtime o el modelo no se pudieron inicializar
  OUT_OF_MEMORY: 'out-of-memory',
  NOT_FOUND: 'not-found', // la grabación ya no existe
  UNKNOWN: 'unknown',
});

export const ERROR_MESSAGES = Object.freeze({
  [ErrorCode.NO_AUDIO]: 'Esta grabación no tiene audio: no hay nada que transcribir.',
  [ErrorCode.DECODE]: 'Chrome no pudo leer el audio de esta grabación.',
  [ErrorCode.MODEL_DOWNLOAD]: 'No se pudo descargar el modelo de transcripción. Comprueba tu conexión e inténtalo de nuevo.',
  [ErrorCode.MODEL_LOAD]: 'No se pudo iniciar el modelo de transcripción en este equipo.',
  [ErrorCode.OUT_OF_MEMORY]: 'No hay memoria suficiente para transcribir. Cierra otras pestañas o usa el modelo estándar.',
  [ErrorCode.NOT_FOUND]: 'La grabación ya no existe.',
  [ErrorCode.UNKNOWN]: 'La transcripción falló por un error inesperado.',
});

export class TranscriptionError extends Error {
  constructor(code, message = ERROR_MESSAGES[code] ?? ERROR_MESSAGES[ErrorCode.UNKNOWN], { cause } = {}) {
    super(message, { cause });
    this.name = 'TranscriptionError';
    this.code = code;
  }
}

/** Normaliza cualquier error a { code, message } serializable. */
export function toErrorInfo(error) {
  if (error instanceof TranscriptionError || (error?.code && ERROR_MESSAGES[error.code])) {
    return { code: error.code, message: error.message || ERROR_MESSAGES[error.code] };
  }
  const text = String(error?.message ?? error ?? '');
  if (error?.name === 'RangeError' || /out of memory|memory access out of bounds|Array buffer allocation failed/i.test(text)) {
    return { code: ErrorCode.OUT_OF_MEMORY, message: ERROR_MESSAGES[ErrorCode.OUT_OF_MEMORY] };
  }
  return { code: ErrorCode.UNKNOWN, message: `${ERROR_MESSAGES[ErrorCode.UNKNOWN]} (${text.slice(0, 200)})` };
}
