/**
 * Cronómetro con pausa. No cuenta el tiempo en pausa.
 * Recibe `now` explícito para ser determinista y testeable.
 *
 * Su `snapshot()` es lo que se guarda en el estado global, y getElapsedMs()
 * (state.js) reconstruye la duración desde cualquier contexto.
 */
export class ElapsedClock {
  #accumulatedMs = 0;
  #segmentStartedAt = null; // null = parado o en pausa

  start(now) {
    this.#accumulatedMs = 0;
    this.#segmentStartedAt = now;
  }

  pause(now) {
    if (this.#segmentStartedAt != null) {
      this.#accumulatedMs += Math.max(0, now - this.#segmentStartedAt);
      this.#segmentStartedAt = null;
    }
  }

  resume(now) {
    if (this.#segmentStartedAt == null) this.#segmentStartedAt = now;
  }

  /** Detiene el reloj y devuelve la duración total grabada. */
  stop(now) {
    this.pause(now);
    return this.#accumulatedMs;
  }

  elapsed(now) {
    return this.#accumulatedMs + (this.#segmentStartedAt == null ? 0 : Math.max(0, now - this.#segmentStartedAt));
  }

  snapshot() {
    return { elapsedMs: this.#accumulatedMs, segmentStartedAt: this.#segmentStartedAt };
  }
}
