/**
 * VideoConverter: WebM (VP9/Opus) → MP4 (H.264 + AAC), 100 % local.
 *
 *   Mediabunny: demux WebM → VideoSampleSink / AudioSampleSink (decodifica con WebCodecs)
 *   → VideoSampleSource (H.264, WebCodecs) / AudioSampleSource (AAC: WebCodecs o WASM)
 *   → Mp4OutputFormat (fastStart: 'reserve') → StreamTarget → archivo temporal OPFS
 *
 * Por qué no se usa Conversion.execute() de Mediabunny: descarta los fotogramas
 * cuya duración demuxada es 0 (los WebM de MediaRecorder no tienen BlockDuration),
 * lo que en nuestras grabaciones supone un 7,6 % de fotogramas. Este bucle propio
 * recalcula la duración de cada fotograma a partir del siguiente y conserva
 * todos los fotogramas.
 *
 * Memoria: la salida se escribe incrementalmente en disco y las colas de los
 * códecs están acotadas, así que el pico no crece con la duración.
 */

import { ConversionError, ConversionPhase, VideoConverter, throwIfAborted } from './video-converter.js';
import {
  TrackPacer,
  aacBitrate,
  aacPrimingSeconds,
  checkSpace,
  estimateEtaMs,
  estimateMp4Bytes,
  frameDuration,
  h264Bitrate,
  maxAacPackets,
  maxVideoPackets,
  monotonicTimestamp,
  requiredTempBytes,
} from './conversion-plan.js';
import * as opfsTempFiles from './temp-files.js';

const MEDIABUNNY = '../vendor/mediabunny/mediabunny.min.mjs';
const AAC_ENCODER = '../vendor/mediabunny/mediabunny-aac-encoder.min.mjs';
const OUTPUT_CHUNK_BYTES = 8 * 1024 * 1024;
const KEYFRAME_INTERVAL_S = 2;
const PROGRESS_INTERVAL_MS = 250;
const MB = 1024 * 1024;

let mediabunnyPromise = null;
let wasmAacRegistered = false;

/** Carga perezosa: la grabación no paga el coste de cargar ~1,7 MB de librerías. */
const loadMediabunny = () => (mediabunnyPromise ??= import(MEDIABUNNY));

async function nativeAacSupported(audioTrack, bitrate) {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    const { supported } = await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2',
      numberOfChannels: audioTrack.numberOfChannels,
      sampleRate: audioTrack.sampleRate,
      bitrate,
    });
    return supported === true;
  } catch {
    return false;
  }
}

export class Mp4Converter extends VideoConverter {
  #load;
  #tempFiles;
  #nativeAac;
  #loadAacEncoder;

  /** Las dependencias son inyectables para poder testear el bucle sin navegador. */
  constructor({
    loadMediabunny: load = loadMediabunny,
    tempFiles = opfsTempFiles,
    nativeAac = nativeAacSupported,
    loadAacEncoder = () => import(AAC_ENCODER),
  } = {}) {
    super();
    this.#load = load;
    this.#tempFiles = tempFiles;
    this.#nativeAac = nativeAac;
    this.#loadAacEncoder = loadAacEncoder;
  }

  async canConvert() {
    const mb = await this.#load();
    return mb.canEncodeVideo('avc');
  }

  /**
   * @param {Blob} webm
   * @param {import('./video-converter.js').ConvertOptions & {
   *   aacPrimingCompensation?: boolean, videoBitrate?: number,
   *   storageEstimate?: () => Promise<{ quota: number, usage: number }>,
   * }} options
   */
  async convert(webm, options = {}) {
    const {
      id,
      quality = 'auto',
      signal,
      onProgress = () => {},
      aacPrimingCompensation = true,
      videoBitrate: videoBitrateOverride,
      storageEstimate = () => navigator.storage.estimate(),
    } = options;
    if (!id) throw new TypeError('convert(): falta options.id');

    const startedAt = performance.now();
    const report = (phase, progress = null) =>
      onProgress({ phase, progress, etaMs: progress == null ? null : estimateEtaMs(progress, performance.now() - startedAt) });

    report(ConversionPhase.PREPARING, 0);
    throwIfAborted(signal);
    const mb = await this.#load();
    const input = new mb.Input({ source: new mb.BlobSource(webm), formats: mb.ALL_FORMATS });
    let output = null;
    let temp = null;
    const onAbort = () => output?.cancel().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // --- 1. Analizar la entrada ------------------------------------------
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) throw new ConversionError('unsupported', 'La grabación no contiene vídeo.');
      if (!(await videoTrack.canDecode())) {
        throw new ConversionError('unsupported', `Este navegador no puede decodificar el vídeo (${videoTrack.codec}).`);
      }
      let audioTrack = await input.getPrimaryAudioTrack();
      if (audioTrack && !(await audioTrack.canDecode())) audioTrack = null; // se exporta sin audio antes que fallar

      const durationS = await input.computeDuration();
      const videoStats = await videoTrack.computePacketStats();
      throwIfAborted(signal);
      const width = videoTrack.displayWidth;
      const height = videoTrack.displayHeight;
      const fps = videoStats.averagePacketRate;
      const videoBitrate = videoBitrateOverride ?? h264Bitrate({ width, height, fps, quality });
      const audioBitrate = audioTrack ? aacBitrate(quality) : 0;

      // --- 2. Soporte de códecs ---------------------------------------------
      if (!(await mb.canEncodeVideo('avc', { width, height, bitrate: videoBitrate }))) {
        throw new ConversionError('unsupported', `Este navegador no puede codificar H.264 a ${width}×${height}.`);
      }
      let aacBackend = null;
      if (audioTrack) {
        // Windows/macOS: AAC nativo de WebCodecs. Linux: no existe → codificador WASM.
        // Se pregunta a WebCodecs directamente: una vez registrado el codificador WASM,
        // mb.canEncodeAudio('aac') devuelve true y ya no distingue (comprobado).
        aacBackend = (await this.#nativeAac(audioTrack, audioBitrate)) ? 'webcodecs' : 'wasm';
        if (aacBackend === 'wasm' && !wasmAacRegistered) {
          (await this.#loadAacEncoder()).registerAacEncoder();
          wasmAacRegistered = true;
        }
      }

      // --- 3. Espacio temporal -----------------------------------------------
      const estimate = estimateMp4Bytes({ durationS, videoBitrate, audioBitrate });
      const space = checkSpace(await storageEstimate(), requiredTempBytes(estimate));
      if (!space.ok) {
        throw new ConversionError('no-space',
          `No hay espacio suficiente para convertir: se necesitan unos ${Math.ceil(space.required / MB)} MB ` +
          `y hay ${Math.floor(space.available / MB)} MB disponibles. Libera espacio o descarga el WebM.`);
      }
      throwIfAborted(signal);

      // --- 4. Salida incremental a OPFS con índice al principio ---------------
      temp = await this.#tempFiles.createTempFile(id);
      output = new mb.Output({
        format: new mb.Mp4OutputFormat({ fastStart: 'reserve' }),
        target: new mb.StreamTarget(temp.writable, { chunked: true, chunkSize: OUTPUT_CHUNK_BYTES }),
      });
      let encodedVideoPackets = 0;
      const videoSource = new mb.VideoSampleSource({
        codec: 'avc',
        bitrate: videoBitrate,
        keyFrameInterval: KEYFRAME_INTERVAL_S,
        latencyMode: 'quality',
        // Si la fuente cambió de tamaño a mitad (p. ej. «compartir esta pestaña en su lugar»),
        // se encaja en el tamaño inicial en vez de fallar.
        sizeChangeBehavior: 'contain',
        onEncodedPacket: () => { encodedVideoPackets++; },
      });
      output.addVideoTrack(videoSource, { maximumPacketCount: maxVideoPackets(videoStats.packetCount) });

      let audioSource = null;
      let encodedAudioPackets = 0;
      if (audioTrack) {
        audioSource = new mb.AudioSampleSource({
          codec: 'aac',
          bitrate: audioBitrate,
          onEncodedPacket: () => { encodedAudioPackets++; },
        });
        output.addAudioTrack(audioSource, { maximumPacketCount: maxAacPackets(durationS, audioTrack.sampleRate) });
      }
      await output.start();

      // --- 5. Bombear muestras -------------------------------------------------
      const start = await input.getFirstTimestamp();
      const pacer = new TrackPacer(audioTrack ? ['video', 'audio'] : ['video']);
      const audioShift = aacBackend === 'wasm' && aacPrimingCompensation ? aacPrimingSeconds(audioTrack.sampleRate) : 0;
      let lastReport = 0;
      const progressAt = (timestamp) => {
        const now = performance.now();
        if (now - lastReport < PROGRESS_INTERVAL_MS) return;
        lastReport = now;
        report(ConversionPhase.CONVERTING, Math.min(0.99, Math.max(0, timestamp / durationS)));
      };
      report(ConversionPhase.CONVERTING, 0);

      const pumpVideo = async () => {
        const fallbackDuration = 1 / (fps > 0 ? fps : 30);
        let pending = null;
        let lastTimestamp = null;
        let frames = 0;
        const emit = async (sample, nextTimestamp) => {
          const duration = frameDuration(sample.timestamp, nextTimestamp, fallbackDuration);
          const timestamp = monotonicTimestamp(sample.timestamp - start, lastTimestamp);
          lastTimestamp = timestamp;
          sample.setTimestamp(timestamp);
          sample.setDuration(duration);
          await pacer.advance('video', timestamp);
          await videoSource.add(sample);
          frames++;
          progressAt(timestamp + duration);
        };
        try {
          for await (const sample of new mb.VideoSampleSink(videoTrack).samples()) {
            if (signal?.aborted) {
              sample.close();
              break;
            }
            // El fotograma nuevo pasa a «pendiente» ANTES de codificar el anterior: si la
            // codificación falla, el finally de abajo lo cierra (sin fugas de VideoFrame).
            const previous = pending;
            pending = sample;
            if (previous) {
              try {
                await emit(previous, sample.timestamp);
              } finally {
                previous.close();
              }
            }
          }
          if (pending && !signal?.aborted) await emit(pending, null);
        } finally {
          pending?.close();
          pacer.finish('video');
        }
        videoSource.close();
        return frames;
      };

      const pumpAudio = async () => {
        if (!audioTrack) return 0;
        let samples = 0;
        try {
          for await (const sample of new mb.AudioSampleSink(audioTrack).samples()) {
            try {
              if (signal?.aborted) break;
              const timestamp = sample.timestamp - start - audioShift;
              sample.setTimestamp(timestamp);
              await pacer.advance('audio', timestamp);
              await audioSource.add(sample);
              samples++;
            } finally {
              sample.close();
            }
          }
        } finally {
          pacer.finish('audio');
        }
        audioSource.close();
        return samples;
      };

      const [videoFrames] = await Promise.all([pumpVideo(), pumpAudio()]);
      throwIfAborted(signal);

      // --- 6. Cerrar el contenedor (escribe el moov en el espacio reservado) ---
      report(ConversionPhase.FINALIZING, 1);
      await output.finalize();
      const file = await temp.handle.getFile();

      return {
        file,
        mimeType: 'video/mp4',
        stats: {
          container: 'mp4',
          fastStart: 'reserve',
          videoCodec: 'avc',
          audioCodec: audioTrack ? 'aac' : null,
          aacBackend,
          width,
          height,
          inputFps: Math.round(fps * 10) / 10,
          durationS,
          videoBitrate,
          audioBitrate,
          inputVideoFrames: videoStats.packetCount,
          convertedVideoFrames: videoFrames,
          encodedVideoPackets,
          encodedAudioPackets,
          audioPrimingCompensationS: audioShift,
          estimatedBytes: estimate,
          outputBytes: file.size,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
      };
    } catch (error) {
      await output?.cancel().catch(() => {});
      await temp?.writable.abort().catch(() => {});
      await this.#tempFiles.removeTempFile(id).catch(() => {});
      if (signal?.aborted) throw new ConversionError('cancelled', 'Conversión cancelada.', { cause: error });
      if (error instanceof ConversionError) throw error;
      throw new ConversionError('failed', `La conversión a MP4 falló: ${error?.message ?? error}`, { cause: error });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      input.dispose?.();
    }
  }
}
