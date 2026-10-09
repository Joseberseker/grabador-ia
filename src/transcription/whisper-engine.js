/**
 * Motor Whisper local: transformers.js + ONNX Runtime Web (WASM, CPU, 1 hilo).
 *
 * - El runtime (JS + WASM) va EMPAQUETADO en src/vendor/transformers: MV3 prohíbe código
 *   remoto y la CSP solo permite 'self' + 'wasm-unsafe-eval'.
 * - Los pesos del modelo son datos: se descargan una vez (revisión fijada) y quedan en la
 *   Cache Storage de la extensión. Solo viajan peticiones de descarga; el audio jamás.
 * - Un solo hilo: el multihilo de WASM exige aislamiento entre orígenes (COOP/COEP) en
 *   todas las páginas de la extensión; se descarta para no alterar el resto de la app.
 */

import { env, pipeline } from '../vendor/transformers/transformers.min.js';
import { LANGUAGE } from './models.js';
import { ErrorCode, TranscriptionError } from './transcription-errors.js';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
// Con true, transformers cargaría el runtime desde una URL blob: (bloqueada por la CSP)
// y duplicaría los 14 MB del WASM en la caché. Se importa directamente del paquete.
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('../vendor/transformers/ort-wasm-simd-threaded.mjs', import.meta.url).href,
  wasm: new URL('../vendor/transformers/ort-wasm-simd-threaded.wasm', import.meta.url).href,
};
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

/**
 * Carga el modelo (descargándolo la primera vez).
 * @param {{ id: string, revision: string }} model
 * @param {(p: { file: string, loaded: number, total: number, status: string }) => void} [onDownload]
 */
export async function loadWhisper(model, onDownload = () => {}) {
  let asr;
  try {
    asr = await pipeline('automatic-speech-recognition', model.id, {
      revision: model.revision,
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.file) onDownload({ file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0, status: p.status });
      },
    });
  } catch (error) {
    const text = String(error?.message ?? error);
    const network = error?.name === 'TypeError' || /fetch|network|Could not locate file|status|ERR_/i.test(text);
    throw new TranscriptionError(network ? ErrorCode.MODEL_DOWNLOAD : ErrorCode.MODEL_LOAD, undefined, { cause: error });
  }

  return {
    /** Transcribe hasta ~60 s de audio a 16 kHz mono. */
    transcribe: (pcm) =>
      asr(pcm, {
        language: LANGUAGE,
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      }),
    dispose: () => asr.dispose?.(),
  };
}
