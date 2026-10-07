/**
 * Una grabación completa, de principio a fin:
 *
 *   getDisplayMedia (selector de Chrome)
 *   → negociar resolución/FPS → micrófono (opcional) → grafo de audio
 *   → cuenta regresiva (opcional) → MediaRecorder → fragmentos a IndexedDB
 *   → detener → unir fragmentos → escribir la duración → Blob final
 *
 * No usa APIs de extensión: comunica todo con `emit(event, payload)`. Esto
 * permite moverla de contexto o testearla con dobles.
 *
 * Eventos: 'countdown' | 'started' | 'saving' | 'finished' | 'failed' | 'warning'
 */

import { ElapsedClock } from '../shared/elapsed-clock.js';
import { toUserError, isUserCancellation, UNSUPPORTED_ERROR } from '../shared/errors.js';
import { ScreenRecorder } from './screen-recorder.js';
import { MIC_CONSTRAINTS, createAudioGraph, describeAudio } from './audio.js';
import { pickMimeType, mimeCandidates } from './mime-type.js';
import {
  audioBitrate,
  buildDisplayMediaOptions,
  measureFrameSize,
  negotiateVideoTrack,
  recorderOptionAttempts,
  videoBitrate,
} from './video-quality.js';
import { setWebmDuration } from './webm-duration.js';
import * as defaultStore from './chunk-store.js';

const LEVEL_INTERVAL_MS = 100;

const MIC_ERRORS = {
  NotAllowedError: 'permiso de micrófono denegado',
  NotFoundError: 'no se encontró ningún micrófono',
  NotReadableError: 'el micrófono está ocupado o el sistema lo bloquea',
  OverconstrainedError: 'el micrófono no admite la configuración pedida',
};

export class RecordingSession {
  #id;
  #settings;
  #emit;
  #onLevel;
  #store;
  #media;
  #clock = new ElapsedClock();
  #recorder = null;
  #display = null;
  #mic = null;
  #audio = null;
  #levelTimer = null;
  #abortCountdown = null;
  #phase = 'idle'; // idle | acquiring | countdown | recording | finishing | done
  #startedAt = null;

  constructor({ id, settings, emit, onLevel = () => {}, store = defaultStore, media = globalThis.navigator?.mediaDevices }) {
    this.#id = id;
    this.#settings = settings;
    this.#emit = emit;
    this.#onLevel = onLevel;
    this.#store = store;
    this.#media = media;
  }

  get startedAt() {
    return this.#startedAt;
  }

  async run() {
    if (!ScreenRecorder.isSupported()) return this.#fail(UNSUPPORTED_ERROR);
    this.#phase = 'acquiring';

    // 1. Selector nativo de Chrome.
    try {
      this.#display = await this.#media.getDisplayMedia(buildDisplayMediaOptions(this.#settings));
    } catch (error) {
      const userError = toUserError(error);
      return this.#fail(userError, isUserCancellation(userError));
    }
    const [videoTrack] = this.#display.getVideoTracks();
    videoTrack.addEventListener('ended', () => this.#onCaptureEnded());

    // 2. Resolución y FPS con fallback (sin volver a abrir el selector).
    const video = await negotiateVideoTrack(videoTrack, this.#settings, await measureFrameSize(videoTrack));
    // Tipo de fuente para la biblioteca: 'browser' (pestaña) | 'window' | 'monitor' (pantalla).
    video.displaySurface = videoTrack.getSettings?.().displaySurface ?? null;

    // 3. Micrófono, solo si el usuario lo activó (el permiso ya se concedió en una página visible).
    let micError = null;
    if (this.#settings.micEnabled) {
      try {
        this.#mic = await this.#media.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
        this.#mic.getAudioTracks()[0]?.addEventListener('ended', () => this.#onMicLost());
      } catch (error) {
        micError = MIC_ERRORS[error?.name] ?? error?.message ?? 'error desconocido';
      }
    }
    if (this.#phase !== 'acquiring') return this.#cleanup(); // cancelado mientras tanto

    // 4. Grafo de audio: ninguno, pestaña, micrófono o mezcla.
    const tabTrack = this.#settings.tabAudio ? this.#display.getAudioTracks()[0] ?? null : null;
    const micTrack = this.#mic?.getAudioTracks()[0] ?? null;
    const audio = describeAudio({ settings: this.#settings, tabTrack, micTrack, micError });
    this.#audio = createAudioGraph({ tabTrack, micTrack });
    if (micTrack) this.#startLevelMeter();

    const notices = [];
    if (micError) notices.push(`Micrófono no disponible (${micError}): se graba sin micrófono.`);
    if (audio.tab === 'unavailable') notices.push('La fuente elegida no comparte audio.');
    if (video.fallback && video.applied !== 'native') {
      notices.push(`Calidad ajustada a lo que admite la captura (${video.width}×${video.height} · ${video.frameRate} fps).`);
    }

    // 5. Cuenta regresiva: la captura ya está activa, pero aún no se graba nada.
    if (this.#settings.countdown > 0) {
      this.#phase = 'countdown';
      const endsAt = Date.now() + this.#settings.countdown * 1000;
      this.#emit('countdown', { endsAt, seconds: this.#settings.countdown, audio, video });
      const completed = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(true), endsAt - Date.now());
        this.#abortCountdown = () => {
          clearTimeout(timer);
          resolve(false);
        };
      });
      this.#abortCountdown = null;
      if (!completed) {
        this.#cleanup();
        return this.#fail({ code: 'CountdownCancelled', message: 'Cuenta regresiva cancelada. No se ha grabado nada.' }, true);
      }
    }

    // 6. MediaRecorder sobre vídeo + audio final, con fragmentos a IndexedDB.
    const tracks = [videoTrack, ...(this.#audio.track ? [this.#audio.track] : [])];
    const stream = new MediaStream(tracks);
    const hasAudio = !!this.#audio.track;
    const mimeType = pickMimeType(undefined, mimeCandidates(hasAudio));
    const attempts = recorderOptionAttempts({
      mimeType,
      videoBitsPerSecond: videoBitrate(this.#settings.quality, video),
      audioBitsPerSecond: hasAudio ? audioBitrate(this.#settings.quality) : undefined,
    });

    this.#recorder = new ScreenRecorder({
      onChunk: (blob, seq) => this.#store.appendChunk(this.#id, seq, blob),
      onWriteError: (error) => {
        this.#emit('warning', {
          message: `No se pudo guardar la grabación en disco (${error.name || error.message}). Se detiene y se guarda lo grabado.`,
        });
        this.stop();
      },
    });

    let started;
    try {
      await this.#store.createRecording(this.#id, { mimeType });
      started = this.#recorder.start(stream, attempts);
    } catch (error) {
      this.#cleanup();
      return this.#fail(toUserError(error));
    }

    this.#phase = 'recording';
    this.#startedAt = new Date();
    this.#clock.start(this.#startedAt.getTime());
    this.#emit('started', {
      ...this.#clock.snapshot(),
      audio,
      video: { ...video, mimeType: started.mimeType, videoBitsPerSecond: started.options.videoBitsPerSecond ?? null },
      notice: notices.join(' ') || null,
    });

    // 7. Esperar a que termine (botón, atajo, «Dejar de compartir»…).
    let result;
    try {
      result = await this.#recorder.whenStopped();
    } catch (error) {
      this.#cleanup();
      return this.#fail(toUserError(error));
    }
    this.#cleanup();

    if (result.chunks === 0) {
      return this.#fail({ code: 'EmptyRecording', message: 'La grabación está vacía. Inténtalo de nuevo.' });
    }

    // 8. Archivo final: fragmentos de IndexedDB + duración en la cabecera.
    const durationMs = this.#clock.elapsed(Date.now());
    let blob;
    try {
      const assembled = await this.#store.assembleRecording(this.#id, result.mimeType || 'video/webm');
      blob = await setWebmDuration(assembled, durationMs);
    } catch (error) {
      return this.#fail(toUserError(error));
    }
    this.#phase = 'done';
    this.#emit('finished', { blob, durationMs, chunks: result.chunks });
    return blob;
  }

  pause() {
    this.#recorder.pause();
    this.#clock.pause(Date.now());
    return this.#clock.snapshot();
  }

  resume() {
    this.#recorder.resume();
    this.#clock.resume(Date.now());
    return this.#clock.snapshot();
  }

  /** Detener: durante la cuenta regresiva equivale a cancelar. */
  stop() {
    if (this.#phase === 'countdown') return this.cancel();
    if (this.#phase !== 'recording') return;
    this.#phase = 'finishing';
    this.#emit('saving', { durationMs: this.#clock.stop(Date.now()) });
    this.#recorder.stop();
  }

  cancel() {
    if (this.#phase === 'countdown') this.#abortCountdown?.();
    else if (this.#phase === 'acquiring') this.#phase = 'cancelled';
  }

  #onCaptureEnded() {
    // «Dejar de compartir», cierre de la pestaña/ventana capturada, etc.
    if (this.#phase === 'countdown') this.cancel();
    else this.stop();
  }

  #onMicLost() {
    if (this.#phase === 'recording' || this.#phase === 'countdown') {
      this.#emit('warning', { message: 'El micrófono se desconectó. La grabación continúa sin él.', micLost: true });
    }
  }

  #startLevelMeter() {
    this.#levelTimer = setInterval(() => this.#onLevel(this.#audio?.level() ?? 0), LEVEL_INTERVAL_MS);
  }

  /** Para TODOS los tracks (pantalla, pestaña, micrófono, mezcla) y libera Web Audio. */
  #cleanup() {
    clearInterval(this.#levelTimer);
    this.#levelTimer = null;
    this.#onLevel(0);
    for (const stream of [this.#display, this.#mic]) stream?.getTracks().forEach((t) => t.stop());
    this.#audio?.close();
    this.#audio = null;
  }

  #fail(error, cancelled = false) {
    this.#phase = 'done';
    this.#emit('failed', { error, cancelled });
    return null;
  }
}
