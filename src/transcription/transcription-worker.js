/**
 * Worker de transcripción (módulo). Todo el trabajo pesado ocurre aquí: lectura y
 * decodificación del audio, remuestreo e inferencia de Whisper. La página solo recibe
 * mensajes pequeños, así que la interfaz nunca se bloquea.
 *
 * Protocolo:
 *   ← { type: 'start', file, model: {id, revision}, startMs, lastSegment }
 *   → { type: 'download', loaded, total }      descarga/carga del modelo
 *   → { type: 'ready' }                        modelo listo
 *   → { type: 'block', segments, processedMs } bloque transcrito (la página lo persiste)
 *   → { type: 'done', stats } | { type: 'error', error: { code, message } }
 *
 * Cancelar = la página termina el worker (terminate). La inferencia de un bloque no es
 * interrumpible desde dentro; terminar el worker libera la memoria al instante.
 */

import { loadWhisper } from './whisper-engine.js';
import { openAudio } from './audio-reader.js';
import { runTranscription } from './transcription-job.js';
import { toErrorInfo } from './transcription-errors.js';

const files = new Map(); // archivo → { loaded, total } para un progreso agregado

self.onmessage = async ({ data }) => {
  if (data?.type !== 'start') return;
  let audio = null;
  try {
    // Se abre el audio ANTES de cargar el modelo: una grabación sin audio falla al
    // instante, sin descargar nada.
    audio = await openAudio(data.file);
    const engine = await loadWhisper(data.model, ({ file, loaded, total }) => {
      if (total) files.set(file, { loaded, total });
      let sumLoaded = 0;
      let sumTotal = 0;
      for (const f of files.values()) {
        sumLoaded += f.loaded;
        sumTotal += f.total;
      }
      self.postMessage({ type: 'download', loaded: sumLoaded, total: sumTotal });
    });
    self.postMessage({ type: 'ready' });
    const stats = await runTranscription({
      blocks: audio.blocks,
      transcribe: engine.transcribe,
      startMs: data.startMs ?? 0,
      lastSegment: data.lastSegment ?? null,
      onBlock: (result) => self.postMessage({ type: 'block', ...result }),
    });
    self.postMessage({ type: 'done', stats });
  } catch (error) {
    console.error('[transcripción]', error);
    self.postMessage({ type: 'error', error: toErrorInfo(error) });
  } finally {
    audio?.dispose();
  }
};
