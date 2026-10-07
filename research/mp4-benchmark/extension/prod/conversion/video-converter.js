/**
 * Contrato de conversión de vídeo.
 *
 *   RecordingSession → WebM (Blob) → VideoConverter.convert() → archivo final → descarga
 *
 * RecordingSession no conoce ninguna implementación. Quien la usa (el offscreen)
 * recibe un VideoConverter, de modo que cambiar WebCodecs+Mediabunny por otra
 * tecnología solo exige otra clase que cumpla este contrato.
 *
 * Toda implementación debe:
 *  - informar del progreso con onProgress({ phase, progress, etaMs });
 *  - respetar `signal` (AbortSignal) y rechazar con ConversionError('cancelled');
 *  - liberar SIEMPRE codificadores, fotogramas y temporales, también al fallar o cancelar;
 *  - no hacer ninguna petición de red.
 */

export const ConversionPhase = Object.freeze({
  PREPARING: 'preparing', // analizar la entrada, comprobar soporte y espacio
  CONVERTING: 'converting', // decodificar → codificar → escribir
  FINALIZING: 'finalizing', // cerrar el contenedor (índice moov)
});

export class ConversionError extends Error {
  /**
   * @param {'unsupported' | 'cancelled' | 'failed' | 'no-space'} code
   * @param {string} message mensaje para el usuario
   */
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = 'ConversionError';
    this.code = code;
  }
}

/**
 * @typedef {Object} ConvertOptions
 * @property {string} id                         identificador (nombre del temporal)
 * @property {'auto' | 'high' | 'max'} [quality]
 * @property {AbortSignal} [signal]
 * @property {(p: { phase: string, progress: number | null, etaMs: number | null }) => void} [onProgress]
 *
 * @typedef {Object} ConvertResult
 * @property {File} file                         respaldado por disco (no ocupa RAM)
 * @property {string} mimeType
 * @property {Object} stats                      códecs, fotogramas, bitrate, etc.
 */

export class VideoConverter {
  /** ¿Puede convertir en este navegador/sistema? Sin efectos secundarios. */
  async canConvert() {
    throw new Error('VideoConverter.canConvert() no implementado');
  }

  /**
   * @param {Blob} input
   * @param {ConvertOptions} options
   * @returns {Promise<ConvertResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async convert(input, options) {
    throw new Error('VideoConverter.convert() no implementado');
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new ConversionError('cancelled', 'Conversión cancelada.');
}
