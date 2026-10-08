# Investigación: transcripción local (Fase 6)

Benchmark aislado (no entra en `dist/`) que comparó Whisper tiny/base/small (ONNX q8, transformers.js 4.3.1 + ONNX Runtime Web WASM) en una extensión MV3 con la CSP del proyecto.

- `extension/`: extensión mínima de benchmark. Necesita `npm install` y copiar a `extension/vendor/` `transformers.min.js` y `ort-wasm-simd-threaded.{mjs,wasm}`. El audio de prueba está en `tests/fixtures/audio/`.
- `run.mjs`: lanza Chrome con perfil propio y mide la carga, la inferencia y el RSS. `results/*.json` y `*.log` guardan los resultados (60 s de voz real en español).
- Conclusiones, ya aplicadas en `src/transcription/`:
  - **base** (q8, 79 MB) es el mejor equilibrio por defecto; **small** (251 MB) ofrece mucha más calidad, pero va ~3× más lento.
  - El multihilo (COOP/COEP) acelera ~1,7–1,8×, pero obliga a aislar todas las páginas de la extensión: se descarta por ahora.
  - **Web Speech** con `processLocally` no transcribe archivos (`start(track)` → `aborted`): se descarta.
