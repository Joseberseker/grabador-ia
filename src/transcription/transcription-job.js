/**
 * Orquestador de una transcripción: recorre los bloques de audio, salta los silenciosos,
 * transcribe el resto y entrega los segmentos bloque a bloque. No sabe nada de IndexedDB,
 * Workers ni del modelo concreto: todo se inyecta (testeable en Node con dobles).
 */

import { rms } from './audio-resampler.js';
import { toSegments } from './transcript-format.js';

/** Por debajo de este RMS (≈ -54 dBFS) el bloque se considera silencio: Whisper alucina con él. */
export const SILENCE_RMS = 0.002;
export const BLOCK_SEC = 60;

export class CancelledError extends Error {
  constructor() {
    super('Transcripción cancelada');
    this.name = 'CancelledError';
  }
}

/**
 * @param {object} p
 * @param {(opts: { startSec: number, blockSec: number }) => AsyncIterable<{ startSec: number, durationSec: number, pcm: Float32Array }>} p.blocks
 * @param {(pcm: Float32Array) => Promise<{ text?: string, chunks?: any[] }>} p.transcribe
 * @param {(result: { segments: Array<{start:number,end:number,text:string}>, processedMs: number }) => Promise<void>|void} p.onBlock
 * @param {(progress: { processedMs: number }) => void} [p.onProgress]
 * @param {number} [p.startMs]        punto de reanudación (lo ya procesado)
 * @param {{ text: string } | null} [p.lastSegment] último segmento guardado (evita repetirlo al reanudar)
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{ blocks: number, silentBlocks: number, segments: number }>}
 */
export async function runTranscription({
  blocks, transcribe, onBlock, onProgress = () => {}, startMs = 0, lastSegment = null, signal, blockSec = BLOCK_SEC, silenceRms = SILENCE_RMS,
}) {
  const check = () => {
    if (signal?.aborted) throw new CancelledError();
  };
  const stats = { blocks: 0, silentBlocks: 0, segments: 0 };
  let previous = lastSegment;
  check();
  for await (const block of blocks({ startSec: startMs / 1000, blockSec })) {
    check();
    let segments = [];
    if (rms(block.pcm) < silenceRms) {
      stats.silentBlocks++;
    } else {
      const output = await transcribe(block.pcm);
      check();
      segments = toSegments(output, block.startSec, block.durationSec, previous);
    }
    const processedMs = Math.round((block.startSec + block.durationSec) * 1000);
    await onBlock({ segments, processedMs });
    if (segments.length) previous = segments.at(-1);
    stats.blocks++;
    stats.segments += segments.length;
    onProgress({ processedMs });
  }
  return stats;
}
