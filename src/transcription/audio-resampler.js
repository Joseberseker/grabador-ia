/**
 * Procesado de audio para Whisper, en streaming y sin dependencias (funciona en Workers,
 * donde no existe OfflineAudioContext):
 *
 *   downmix → mono · StreamingResampler → 16 kHz · BlockSplitter → bloques de ~60 s
 *
 * Memoria acotada: nunca se tiene el audio completo, solo el bloque en curso
 * (60 s × 16 kHz × 4 B ≈ 3,8 MB).
 */

export const TARGET_RATE = 16_000;

/** Media de los canales planos (Float32Array por canal). */
export function downmixToMono(planes) {
  if (planes.length === 1) return planes[0];
  const out = new Float32Array(planes[0].length);
  for (const plane of planes) for (let i = 0; i < out.length; i++) out[i] += plane[i];
  const k = 1 / planes.length;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

/** Valor cuadrático medio de `samples[from, to)`. */
export function rms(samples, from = 0, to = samples.length) {
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (to - from));
}

/** Filtro paso bajo FIR (sinc con ventana de Hann). `cutoff` en ciclos por muestra (0-0,5). */
function lowPass(taps, cutoff) {
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    h[i] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)));
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum; // ganancia unidad en continua
  return h;
}

/**
 * Remuestreo en streaming (cualquier tasa → 16 kHz): filtro antialiasing FIR evaluado solo
 * en las posiciones necesarias + interpolación lineal. Conserva estado entre llamadas,
 * así que trocear la entrada no altera el resultado.
 */
export class StreamingResampler {
  constructor(inRate, outRate = TARGET_RATE, { taps = 63 } = {}) {
    this.step = inRate / outRate;
    this.filter = inRate > outRate ? lowPass(taps, (0.45 * outRate) / inRate) : null;
    this.history = new Float32Array(this.filter ? taps - 1 : 0); // últimas muestras de la llamada anterior
    this.t = 0; // instante de la siguiente salida, en muestras de la entrada actual (-1 = muestra previa)
    this.prev = 0; // última muestra filtrada de la llamada anterior
  }

  /** @param {Float32Array} input @returns {Float32Array} */
  process(input) {
    const n = input.length;
    if (!n) return new Float32Array(0);
    let value;
    if (this.filter) {
      const h = this.filter;
      const buf = new Float32Array(this.history.length + n);
      buf.set(this.history);
      buf.set(input, this.history.length);
      value = (j) => {
        let acc = 0;
        for (let k = 0; k < h.length; k++) acc += h[k] * buf[j + k];
        return acc;
      };
      this.history = buf.slice(buf.length - this.history.length);
    } else {
      value = (j) => input[j];
    }
    const out = new Float32Array(Math.ceil((n - this.t) / this.step) + 1);
    let count = 0;
    let t = this.t;
    let cacheIndex = -2;
    let cacheValue = 0;
    const at = (i) => {
      if (i < 0) return this.prev;
      if (i !== cacheIndex) {
        cacheIndex = i;
        cacheValue = value(i);
      }
      return cacheValue;
    };
    while (t <= n - 1) {
      const i = Math.floor(t);
      const frac = t - i;
      const a = at(i);
      const b = frac > 0 ? value(i + 1) : a;
      out[count++] = a + (b - a) * frac;
      t += this.step;
    }
    this.t = t - n;
    this.prev = value(n - 1);
    return out.subarray(0, count);
  }
}

/**
 * Agrupa audio de 16 kHz en bloques de ~`blockSec`. El corte se hace en el tramo más
 * silencioso de los últimos `searchSec` segundos del bloque, para no partir palabras
 * (así no hace falta solapar bloques ni deduplicar texto).
 */
export class BlockSplitter {
  constructor({ sampleRate = TARGET_RATE, blockSec = 60, searchSec = 5, frameSec = 0.05, minSec = 0.3 } = {}) {
    this.blockLen = Math.round(blockSec * sampleRate);
    this.searchLen = Math.min(Math.round(searchSec * sampleRate), this.blockLen - 1);
    this.frameLen = Math.max(1, Math.round(frameSec * sampleRate));
    this.minLen = Math.round(minSec * sampleRate);
    this.buffer = new Float32Array(this.blockLen * 2);
    this.length = 0;
    this.emitted = 0; // muestras ya entregadas (posición del inicio del buffer)
  }

  /** @returns {Array<{ start: number, pcm: Float32Array }>} bloques completos (start en muestras) */
  push(samples) {
    const blocks = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(samples.length - offset, this.buffer.length - this.length);
      this.buffer.set(samples.subarray(offset, offset + take), this.length);
      this.length += take;
      offset += take;
      while (this.length >= this.blockLen) blocks.push(this.#cut(this.#quietestPoint()));
    }
    return blocks;
  }

  /** Último bloque (o null si lo que queda es demasiado corto para contener habla). */
  flush() {
    if (this.length < this.minLen) {
      this.emitted += this.length;
      this.length = 0;
      return null;
    }
    return this.#cut(this.length);
  }

  #quietestPoint() {
    let best = this.blockLen;
    let bestRms = Infinity;
    for (let end = this.blockLen; end - this.frameLen >= this.blockLen - this.searchLen; end -= this.frameLen) {
      const value = rms(this.buffer, end - this.frameLen, end);
      if (value < bestRms) {
        bestRms = value;
        best = end - (this.frameLen >> 1); // centro del tramo silencioso
      }
    }
    return best;
  }

  #cut(at) {
    const block = { start: this.emitted, pcm: this.buffer.slice(0, at) };
    this.buffer.copyWithin(0, at, this.length);
    this.length -= at;
    this.emitted += at;
    return block;
  }
}
