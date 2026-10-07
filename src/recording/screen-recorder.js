/**
 * Envoltorio sobre MediaRecorder con persistencia progresiva de fragmentos.
 *
 * Cada fragmento (`dataavailable`, cada TIMESLICE_MS) se entrega en orden a
 * `onChunk(blob, seq)` (p. ej. para escribirlo en IndexedDB) y deja de estar
 * referenciado en memoria. `whenStopped()` resuelve cuando MediaRecorder se ha
 * detenido Y todos los fragmentos se han persistido.
 *
 * No adquiere streams ni conoce las APIs de extensión: recibe un MediaStream ya
 * preparado (vídeo + audio mezclado), lo que permite cambiar la fuente o la
 * salida (p. ej. MP4) sin tocarlo.
 */

import { createMediaRecorder } from './video-quality.js';

export const TIMESLICE_MS = 1000;

export class ScreenRecorder {
  #recorder = null;
  #result = null;
  #writes = Promise.resolve();
  #seq = 0; // fragmentos recibidos
  #written = 0; // fragmentos guardados con éxito
  #writeError = null;
  #onChunk;
  #onStopping;
  #onWriteError;
  #RecorderCtor;

  /**
   * @param {{
   *   onChunk: (blob: Blob, seq: number) => Promise<void>,
   *   onStopping?: () => void,
   *   onWriteError?: (error: Error) => void,
   *   RecorderCtor?: typeof MediaRecorder,
   * }} options
   */
  constructor({ onChunk, onStopping, onWriteError, RecorderCtor = globalThis.MediaRecorder }) {
    this.#onChunk = onChunk;
    this.#onStopping = onStopping ?? (() => {});
    this.#onWriteError = onWriteError ?? (() => {});
    this.#RecorderCtor = RecorderCtor;
  }

  static isSupported() {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
      typeof MediaRecorder !== 'undefined'
    );
  }

  /** 'inactive' | 'recording' | 'paused' */
  get state() {
    return this.#recorder?.state ?? 'inactive';
  }

  get chunksWritten() {
    return this.#written;
  }

  /** Empieza a grabar `stream` con la primera combinación de opciones aceptada. */
  start(stream, optionAttempts) {
    if (this.state !== 'inactive') {
      throw new DOMException('Ya hay una grabación en curso.', 'InvalidStateError');
    }
    const { recorder, options } = createMediaRecorder(stream, optionAttempts, this.#RecorderCtor);
    this.#recorder = recorder;
    this.#seq = 0;
    this.#written = 0;
    this.#writes = Promise.resolve();
    this.#writeError = null;

    this.#result = new Promise((resolve, reject) => {
      recorder.addEventListener('dataavailable', (event) => {
        if (!(event.data?.size > 0)) return;
        const seq = this.#seq++;
        const blob = event.data;
        // Encadenado: los fragmentos se guardan estrictamente en orden.
        this.#writes = this.#writes.then(() =>
          this.#writeError
            ? undefined
            : this.#onChunk(blob, seq).then(
                () => {
                  this.#written += 1;
                },
                (error) => this.#failWrite(error),
              ),
        );
      });
      recorder.addEventListener('stop', () => {
        this.#writes.then(() => {
          if (this.#writeError && this.#written === 0) reject(this.#writeError);
          else resolve({ chunks: this.#written, mimeType: recorder.mimeType });
        });
      });
      recorder.addEventListener('error', (event) => {
        reject(event.error ?? new Error('Error de MediaRecorder.'));
      });
    });

    recorder.start(TIMESLICE_MS);
    return { mimeType: recorder.mimeType, options };
  }

  pause() {
    if (this.state !== 'recording') throw new Error('No hay ninguna grabación activa que pausar.');
    this.#recorder.pause();
  }

  resume() {
    if (this.state !== 'paused') throw new Error('La grabación no está en pausa.');
    this.#recorder.resume();
  }

  /** Detiene la grabación (desde 'recording' o 'paused'). Idempotente. */
  stop() {
    if (this.state === 'inactive') return;
    this.#onStopping();
    this.#recorder.stop(); // emite el último dataavailable y luego 'stop'
  }

  whenStopped() {
    return this.#result ?? Promise.reject(new Error('No se ha iniciado ninguna grabación.'));
  }

  #failWrite(error) {
    if (this.#writeError) return;
    this.#writeError = error;
    this.#onWriteError(error);
  }
}
