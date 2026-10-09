/**
 * Modelos Whisper disponibles (ONNX cuantizado q8, onnx-community en Hugging Face,
 * licencia Apache-2.0 heredada de openai/whisper). Revisiones FIJADAS: la extensión
 * siempre descarga exactamente los mismos archivos, que se verificaron en la fase 6.
 *
 * Los pesos NO van en el paquete: se descargan una vez, solo cuando el usuario lo
 * acepta, y quedan en la Cache Storage de la extensión. El audio nunca sale del equipo.
 *
 * Velocidad y RAM medidas en Chrome 155 / Linux (portátil x86-64, WASM de 1 hilo) con voz
 * real en español: base ≈ 0,3-0,4 × tiempo real y +0,6 GB; small ≈ 1,15 × y +1,2 GB.
 */

export const MODELS = Object.freeze({
  base: Object.freeze({
    key: 'base',
    id: 'onnx-community/whisper-base',
    revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    label: 'Estándar',
    downloadMb: 79,
    ramMb: 600,
    speed: '≈ 3-4 min por cada 10 min de audio',
  }),
  small: Object.freeze({
    key: 'small',
    id: 'onnx-community/whisper-small',
    revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    label: 'Alta precisión',
    downloadMb: 251,
    ramMb: 1300,
    speed: '≈ 12 min por cada 10 min de audio',
  }),
});

export const DEFAULT_MODEL = 'base';
export const LANGUAGE = 'spanish';

/** Nombre de la caché donde transformers.js guarda los archivos descargados. */
export const MODEL_CACHE = 'transformers-cache';

export const modelByKey = (key) => MODELS[key] ?? MODELS[DEFAULT_MODEL];

/** ¿Es esta URL de la caché un archivo del modelo `model` (en su revisión fijada)? */
export const isModelUrl = (url, model) => url.includes(`/${model.id}/resolve/${model.revision}/`);
