/**
 * Audio de la grabación: pestaña, micrófono o ambos.
 *
 *   plan 'none' → solo vídeo
 *   plan 'tab'  → track de la pestaña directo (sin Web Audio)
 *   plan 'mic'  → track del micrófono directo; un AnalyserNode lo «escucha»
 *                 solo para el indicador de nivel
 *   plan 'mix'  → Web Audio: pestaña + micrófono → MediaStreamAudioDestinationNode
 *
 * Evitar duplicados y eco:
 *  - Nada se conecta a ctx.destination: no reproducimos ni la pestaña ni el
 *    micrófono (Chrome ya sigue reproduciendo la pestaña capturada).
 *  - El micrófono usa echoCancellation, que resta lo que Chrome reproduce por los
 *    altavoces y evita que el audio de la pestaña entre otra vez por el micrófono.
 *  - Cada fuente entra una sola vez en la mezcla.
 */

export const MIC_CONSTRAINTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});

export function planAudio({ tab, mic }) {
  if (tab && mic) return 'mix';
  if (mic) return 'mic';
  if (tab) return 'tab';
  return 'none';
}

/** RMS (0..1) → nivel visual 0..1 en escala de decibelios (-60 dB … 0 dB). */
export function rmsToLevel(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/**
 * Estado de cada fuente para la UI.
 *  tab: 'off' (desactivado en ajustes) | 'on' | 'unavailable' (se pidió pero la fuente no lo da)
 *  mic: 'off' | 'on' | 'error'
 */
export function describeAudio({ settings, tabTrack, micTrack, micError }) {
  return {
    tab: !settings.tabAudio ? 'off' : tabTrack ? 'on' : 'unavailable',
    mic: !settings.micEnabled ? 'off' : micTrack ? 'on' : micError ? 'error' : 'off',
    plan: planAudio({ tab: !!tabTrack, mic: !!micTrack }),
  };
}

/**
 * Construye el grafo de audio. Devuelve el track a grabar (o null), una función
 * `level()` para el indicador y `close()` para liberar recursos.
 */
export function createAudioGraph({ tabTrack = null, micTrack = null, AudioContextCtor = globalThis.AudioContext }) {
  const plan = planAudio({ tab: !!tabTrack, mic: !!micTrack });

  if (plan === 'none' || plan === 'tab') {
    return { plan, track: tabTrack, level: () => 0, close: () => {} };
  }

  const ctx = new AudioContextCtor({ latencyHint: 'interactive' });
  ctx.resume?.().catch(() => {});

  const micSource = ctx.createMediaStreamSource(new MediaStream([micTrack]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  micSource.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  let track = micTrack;
  let destination = null;
  if (plan === 'mix') {
    destination = ctx.createMediaStreamDestination();
    micSource.connect(destination);
    ctx.createMediaStreamSource(new MediaStream([tabTrack])).connect(destination);
    [track] = destination.stream.getAudioTracks();
  }

  return {
    plan,
    track,
    level() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      return rmsToLevel(Math.sqrt(sum / samples.length));
    },
    close() {
      destination?.stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}
