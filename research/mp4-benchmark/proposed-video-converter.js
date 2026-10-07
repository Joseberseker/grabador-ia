/**
 * PROPUESTA (Fase 4A) — NO es código de producción ni está conectado a la extensión.
 * Boceto de la abstracción VideoConverter para la Fase 4B.
 *
 *   RecordingSession → WebM Blob → VideoConverter.convert() → MP4 Blob → descarga
 *
 * RecordingSession no sabe qué implementación se usa: recibe un `converter` que
 * cumple este contrato. Cambiar de WebCodecs a FFmpeg.wasm (o a otra) solo exige
 * otra clase con el mismo contrato.
 */

/**
 * @typedef {Object} ConvertOptions
 * @property {'mp4'} container
 * @property {'h264'} videoCodec
 * @property {'aac' | 'opus'} audioCodec
 * @property {'auto' | 'high' | 'max'} quality
 * @property {AbortSignal} [signal]                 Cancelación (AbortController del llamador)
 * @property {(progress: number) => void} [onProgress]  0..1
 */

/**
 * @typedef {Object} ConvertResult
 * @property {Blob} blob            MP4 final (respaldado por disco cuando sea posible)
 * @property {number} durationMs
 * @property {string} videoCodec    p. ej. 'avc1.640028'
 * @property {string} audioCodec    p. ej. 'mp4a.40.2'
 * @property {string[]} notes       p. ej. 'AAC por WASM: WebCodecs no lo soporta en este sistema'
 */

/** Errores tipados para que la UI muestre mensajes claros. */
export class ConversionError extends Error {
  /** @param {'unsupported' | 'cancelled' | 'failed' | 'too-large'} code */
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'ConversionError';
    this.code = code;
  }
}

/** Contrato que toda implementación debe cumplir. */
export class VideoConverter {
  /** ¿Puede convertir con estas opciones en este navegador/SO? (sin efectos secundarios) */
  // eslint-disable-next-line no-unused-vars
  async canConvert(options) {
    throw new Error('no implementado');
  }

  /**
   * @param {Blob} webm
   * @param {ConvertOptions} options
   * @returns {Promise<ConvertResult>}
   * Debe: emitir progreso, respetar `signal` (rechazar con ConversionError('cancelled')),
   * liberar codificadores/workers/memoria SIEMPRE (también al fallar o cancelar)
   * y no hacer ninguna petición de red.
   */
  // eslint-disable-next-line no-unused-vars
  async convert(webm, options) {
    throw new Error('no implementado');
  }
}

/**
 * Implementación recomendada (boceto): WebCodecs + Mediabunny.
 * H.264 por WebCodecs (lo aporta Chrome); AAC por WebCodecs si existe
 * (Windows/macOS) o por @mediabunny/aac-encoder (WASM) si no (Linux).
 */
export class WebCodecsMp4Converter extends VideoConverter {
  constructor({ mediabunny, loadAacEncoder }) {
    super();
    this.MB = mediabunny;
    this.loadAacEncoder = loadAacEncoder; // import() perezoso: solo se carga si hace falta
  }

  async canConvert({ videoCodec }) {
    return videoCodec === 'h264' && (await this.MB.canEncodeVideo('avc'));
  }

  async convert(webm, { audioCodec = 'aac', quality = 'auto', signal, onProgress = () => {} }) {
    const MB = this.MB;
    const notes = [];
    if (signal?.aborted) throw new ConversionError('cancelled', 'Conversión cancelada.');
    if (!(await this.canConvert({ videoCodec: 'h264' }))) {
      throw new ConversionError('unsupported', 'Este navegador no puede codificar H.264.');
    }
    if (audioCodec === 'aac' && !(await MB.canEncodeAudio('aac'))) {
      (await this.loadAacEncoder()).registerAacEncoder();
      notes.push('AAC por WASM: WebCodecs no lo soporta en este sistema.');
    }

    const input = new MB.Input({ source: new MB.BlobSource(webm), formats: MB.ALL_FORMATS });
    // Producción: StreamTarget hacia IndexedDB/OPFS para no retener el MP4 en RAM.
    const target = new MB.BufferTarget();
    const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const bitrate = { auto: MB.QUALITY_MEDIUM, high: MB.QUALITY_HIGH, max: MB.QUALITY_VERY_HIGH }[quality];
    const conversion = await MB.Conversion.init({
      input,
      output,
      video: { codec: 'avc', bitrate, forceTranscode: true },
      audio: { codec: audioCodec, bitrate: 128_000 },
    });
    if (!conversion.isValid) {
      throw new ConversionError('unsupported', 'No se puede convertir este archivo: ' +
        conversion.discardedTracks.map((t) => t.reason).join(', '));
    }

    const onAbort = () => conversion.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    conversion.onProgress = (p) => onProgress(p);
    try {
      await conversion.execute();
    } catch (error) {
      if (signal?.aborted) throw new ConversionError('cancelled', 'Conversión cancelada.', error);
      throw new ConversionError('failed', `La conversión falló: ${error.message}`, error);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      input.dispose?.();
    }

    const track = await new MB.Input({ source: new MB.BufferSource(target.buffer), formats: MB.ALL_FORMATS }).getPrimaryVideoTrack();
    return {
      blob: new Blob([target.buffer], { type: 'video/mp4' }),
      durationMs: (await track.computeDuration()) * 1000,
      videoCodec: await track.getCodecParameterString(),
      audioCodec,
      notes,
    };
  }
}
