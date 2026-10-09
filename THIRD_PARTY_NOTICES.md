# Avisos de terceros

La extensión incluye, sin modificar, estas librerías en `src/vendor/mediabunny/` y `src/vendor/transformers/`. Sus versiones y hashes SHA-256 están en el `VERSIONS.json` de cada carpeta y `npm run validate` los comprueba.

| Componente | Versión | Licencia | Uso |
|---|---|---|---|
| [transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers`, build `transformers.min.js`) | 4.3.1 | Apache-2.0 | Pipeline de reconocimiento de voz (Whisper) para la transcripción local |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (`ort-wasm-simd-threaded.mjs` + `.wasm`, solo CPU) | 1.31.0-dev.20260914-8d85527a0 | MIT | Ejecución del modelo en WebAssembly |
| [Mediabunny](https://github.com/Vanilagy/mediabunny) | 1.61.3 | MPL-2.0 | Demux WebM, mux MP4 y orquestación de WebCodecs |
| [@mediabunny/aac-encoder](https://mediabunny.dev/guide/extensions/aac-encoder) | 1.61.3 | MPL-2.0 (envoltorio) + **LGPL-2.1-or-later** (código de FFmpeg compilado a WASM) | Codificación AAC donde WebCodecs no la ofrece (Linux) |

## Transcripción: librerías y modelos

- **transformers.js** (Apache-2.0, © Hugging Face): licencia en `src/vendor/transformers/LICENSE-transformers-Apache-2.0.txt`.
- **ONNX Runtime Web** (MIT, © Microsoft Corporation): el paquete npm declara MIT pero no incluye el texto, así que se reproduce en `src/vendor/transformers/LICENSE-onnxruntime-MIT.txt`.
- **Modelos Whisper** ([onnx-community/whisper-base](https://huggingface.co/onnx-community/whisper-base) y [onnx-community/whisper-small](https://huggingface.co/onnx-community/whisper-small), conversiones a ONNX de [openai/whisper](https://github.com/openai/whisper)). Licencia: **Apache-2.0** en Hugging Face (`openai/whisper-base`, `openai/whisper-small`); el código y los pesos originales de OpenAI en GitHub son MIT. **No van en el paquete:** se descargan desde Hugging Face solo si el usuario lo acepta, en una revisión fijada.

## MPL-2.0 (Mediabunny)

Licencia de copyleft por archivo. Se distribuyen los archivos sin modificar, con su licencia en `src/vendor/mediabunny/LICENSE-MPL-2.0.txt`. Si alguna vez se modificaran, habría que publicar el código fuente de esos archivos modificados. No afecta al resto del código de la extensión.

## LGPL-2.1+ (codificador AAC de FFmpeg)

`mediabunny-aac-encoder.min.mjs` contiene una compilación a WebAssembly del codificador AAC de [FFmpeg](https://ffmpeg.org) (`libavcodec`), que se distribuye bajo LGPL-2.1-or-later. Para cumplirla:

- La librería va en un archivo propio e independiente del resto del código, y se puede sustituir por otra versión compatible.
- El código fuente correspondiente está disponible en el [repositorio de Mediabunny](https://github.com/Vanilagy/mediabunny) (paquete `aac-encoder`, archivo `bridge.c` y script de compilación) y en [ffmpeg.org](https://ffmpeg.org/download.html).
- Antes de una distribución comercial, revisar con asesoría legal los requisitos de LGPL: aviso, oferta de código fuente y posibilidad de sustitución. **Esto no es asesoría legal.**

## Códecs y patentes

- **H.264** lo codifica **Chrome** mediante WebCodecs: la extensión no distribuye ningún codificador H.264.
- **AAC-LC:** en Windows y macOS lo codifica el sistema operativo (vía Chrome). En Linux, el codificador WASM de FFmpeg. Las patentes esenciales de AAC-LC se consideran expiradas desde 2017, pero conviene confirmarlo con asesoría legal antes de distribuir comercialmente.
