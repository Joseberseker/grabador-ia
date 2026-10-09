/**
 * Lee el audio de una grabación (MP4/AAC o WebM/Opus) desde su File de OPFS y lo entrega
 * en bloques de ~60 s a 16 kHz mono. Mediabunny lee el archivo por partes (BlobSource) y
 * decodifica con WebCodecs (AudioDecoder): el vídeo nunca se carga entero en memoria y
 * la pista de vídeo ni siquiera se decodifica. Funciona dentro de un Worker.
 */

import { BlockSplitter, StreamingResampler, TARGET_RATE, downmixToMono } from './audio-resampler.js';
import { ErrorCode, TranscriptionError } from './transcription-errors.js';

const MEDIABUNNY = '../vendor/mediabunny/mediabunny.min.mjs';
const defaultLoad = () => import(MEDIABUNNY);

/** Huecos mayores que esto (p. ej. pistas con discontinuidades) se rellenan con silencio. */
const GAP_SEC = 0.1;

/**
 * @param {Blob} file
 * @param {{ loadMediabunny?: () => Promise<any> }} [deps]
 * @returns {Promise<{ blocks: (opts: { startSec?: number, blockSec?: number }) => AsyncGenerator<{ startSec: number, durationSec: number, pcm: Float32Array }>, dispose: () => void }>}
 */
export async function openAudio(file, { loadMediabunny = defaultLoad } = {}) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  let track;
  try {
    track = await input.getPrimaryAudioTrack();
  } catch (error) {
    input.dispose();
    throw new TranscriptionError(ErrorCode.DECODE, undefined, { cause: error });
  }
  if (!track) {
    input.dispose();
    throw new TranscriptionError(ErrorCode.NO_AUDIO);
  }
  if (!(await track.canDecode())) {
    input.dispose();
    throw new TranscriptionError(ErrorCode.DECODE);
  }

  async function* blocks({ startSec = 0, blockSec = 60 } = {}) {
    const sink = new mb.AudioSampleSink(track);
    const splitter = new BlockSplitter({ blockSec });
    let resampler = null;
    let origin = null; // instante (s) de la primera muestra de salida
    let expected = null; // instante esperado de la siguiente muestra de entrada
    const emit = (block) => ({ startSec: origin + block.start / TARGET_RATE, durationSec: block.pcm.length / TARGET_RATE, pcm: block.pcm });

    for await (const sample of sink.samples(startSec)) {
      let mono;
      try {
        const frames = sample.numberOfFrames;
        const planes = [];
        for (let c = 0; c < sample.numberOfChannels; c++) {
          const plane = new Float32Array(frames);
          sample.copyTo(plane, { format: 'f32-planar', planeIndex: c });
          planes.push(plane);
        }
        mono = downmixToMono(planes);
        if (!resampler) {
          resampler = new StreamingResampler(sample.sampleRate);
          origin = Math.max(0, sample.timestamp);
          expected = sample.timestamp;
        }
        const gap = sample.timestamp - expected;
        if (gap > GAP_SEC) {
          const silence = new Float32Array(Math.round(gap * sample.sampleRate));
          for (const block of splitter.push(resampler.process(silence))) yield emit(block);
        }
        expected = sample.timestamp + sample.duration;
      } catch (error) {
        throw error instanceof TranscriptionError ? error : new TranscriptionError(ErrorCode.DECODE, undefined, { cause: error });
      } finally {
        sample.close();
      }
      for (const block of splitter.push(resampler.process(mono))) yield emit(block);
    }
    const last = splitter.flush();
    if (last && origin !== null) yield emit(last);
  }

  return { blocks, dispose: () => input.dispose() };
}
