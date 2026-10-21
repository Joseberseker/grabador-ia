# Grabador de Pantalla — Extensión de Chrome

Extensión de Chrome (Manifest V3) que graba una **pestaña, una ventana o la pantalla completa** y la exporta a **MP4 (H.264 + AAC)** o al **WebM original**. Incluye pausa, micrófono opcional mezclado con el audio de la pestaña, indicador de nivel, calidad configurable, cuenta regresiva y un controlador flotante.
Todo ocurre en tu equipo, también la conversión a MP4 y la **transcripción** opcional del audio (Whisper local): no hay backend ni se sube ningún vídeo o audio. La única petición de red es la descarga única del modelo de transcripción, y solo si la aceptas.

- JavaScript, HTML y CSS vanilla (módulos ES), sin bundler.
- Dependencias de ejecución, empaquetadas en `src/vendor/` (ver [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)): [Mediabunny](https://github.com/Vanilagy/mediabunny) y su codificador AAC; para la transcripción, [transformers.js](https://github.com/huggingface/transformers.js) y el runtime WASM de [ONNX Runtime Web](https://onnxruntime.ai).
- Permisos: `storage`, `offscreen`, `downloads`. El micrófono se pide aparte, solo si lo activas.

## Funcionalidades

- 🎥 Graba **pestaña, ventana o pantalla completa** con el selector nativo de Chrome.
- ⏸ **Pausa y reanuda**, con controlador flotante (ventana o Picture-in-Picture) y atajos de teclado.
- 🎙️ **Micrófono opcional**, mezclado con el audio de la pestaña, con indicador de nivel.
- ⚙️ **Calidad configurable**: resolución (Automática · 720p · 1080p), FPS (30 · 60) y calidad (Automática · Alta · Máxima).
- ⏱️ **Cuenta regresiva** opcional de 3 segundos.
- 📼 Exporta a **MP4 (H.264 + AAC)** o conserva el **WebM** original; la conversión se puede cancelar.
- 📁 **Biblioteca local** («Mis grabaciones»): lista por días, preview, renombrar, descargar y eliminar.
- 📝 **Transcripción local** opcional con Whisper (español), con marcas de tiempo, copiar y exportar `.txt`.
- 🔒 **100 % local**: sin backend, sin subir vídeo ni audio.

**Contenido:** [Capturas](#capturas-de-pantalla) · [Instalación](#instalación) · [Uso](#uso) · [Build y tests](#build-validaciones-y-tests) · [Estructura](#estructura-del-proyecto) · [Arquitectura](#arquitectura) · [Linux](#ubuntu--linux-qué-se-puede-capturar) · [Privacidad](#seguridad-y-privacidad) · [Limitaciones](#limitaciones-conocidas-v06)

## Capturas de pantalla

Guarda las imágenes en [`docs/screenshots/`](docs/screenshots/) con los nombres indicados.

### Popup y ajustes

> 📸 **Captura pendiente — popup de la extensión con los ajustes (micrófono, resolución, FPS, calidad, formato, cuenta regresiva)**
> Guárdala como `docs/screenshots/01-popup-ajustes.png` y reemplaza este bloque por:
> `![Popup y ajustes](docs/screenshots/01-popup-ajustes.png)`

<!-- ![Popup y ajustes](docs/screenshots/01-popup-ajustes.png) -->

### Selector de fuente

> 📸 **Captura pendiente — selector nativo de Chrome para elegir pestaña, ventana o pantalla**
> Guárdala como `docs/screenshots/02-selector-fuente.png` y reemplaza este bloque por:
> `![Selector de fuente](docs/screenshots/02-selector-fuente.png)`

<!-- ![Selector de fuente](docs/screenshots/02-selector-fuente.png) -->

### Controlador de grabación

> 📸 **Captura pendiente — controlador flotante grabando, con duración, nivel del micrófono y botones Pausar / Detener**
> Guárdala como `docs/screenshots/03-controlador-grabando.png` y reemplaza este bloque por:
> `![Controlador grabando](docs/screenshots/03-controlador-grabando.png)`

<!-- ![Controlador grabando](docs/screenshots/03-controlador-grabando.png) -->

### Cuenta regresiva y pausa

> 📸 **Captura pendiente — cuenta regresiva 3 → 2 → 1 y/o grabación en pausa**
> Guárdala como `docs/screenshots/04-cuenta-regresiva-pausa.png` y reemplaza este bloque por:
> `![Cuenta regresiva y pausa](docs/screenshots/04-cuenta-regresiva-pausa.png)`

<!-- ![Cuenta regresiva y pausa](docs/screenshots/04-cuenta-regresiva-pausa.png) -->

### Conversión a MP4

> 📸 **Captura pendiente — progreso de conversión a MP4 (porcentaje, tiempo restante y botón Cancelar)**
> Guárdala como `docs/screenshots/05-conversion-mp4.png` y reemplaza este bloque por:
> `![Conversión a MP4](docs/screenshots/05-conversion-mp4.png)`

<!-- ![Conversión a MP4](docs/screenshots/05-conversion-mp4.png) -->

### Grabación lista

> 📸 **Captura pendiente — pantalla «Grabación lista» con miniatura y botones Ver / Descargar / Mis grabaciones**
> Guárdala como `docs/screenshots/06-grabacion-lista.png` y reemplaza este bloque por:
> `![Grabación lista](docs/screenshots/06-grabacion-lista.png)`

<!-- ![Grabación lista](docs/screenshots/06-grabacion-lista.png) -->

### Biblioteca «Mis grabaciones»

> 📸 **Captura pendiente — biblioteca con las grabaciones agrupadas por día y el preview**
> Guárdala como `docs/screenshots/07-biblioteca.png` y reemplaza este bloque por:
> `![Biblioteca](docs/screenshots/07-biblioteca.png)`

<!-- ![Biblioteca](docs/screenshots/07-biblioteca.png) -->

### Transcripción

> 📸 **Captura pendiente — panel de transcripción junto al vídeo (modelo, progreso, texto con minutos, Copiar y .txt)**
> Guárdala como `docs/screenshots/08-transcripcion.png` y reemplaza este bloque por:
> `![Transcripción](docs/screenshots/08-transcripcion.png)`

<!-- ![Transcripción](docs/screenshots/08-transcripcion.png) -->

---

## Instalación

### Requisitos

- Google Chrome **116 o superior** (para ejecutar la extensión). Para el E2E, Chrome 137+.
- Node.js **22.2 o superior** y npm (solo para compilar el paquete).

### Paso a paso: añadir la extensión a Chrome

**1. Obtén el código y las dependencias**

```bash
git clone <URL-de-este-repositorio> grabador-ia
cd grabador-ia
npm install          # dependencias de desarrollo (tests, E2E, vendors)
```

**2. Genera el paquete `dist/`**

```bash
npm run build        # genera dist/ (solo lo necesario para ejecutar la extensión)
npm run package      # opcional: genera release/grabador-de-pantalla-<versión>.zip
```

> 📸 **Captura pendiente — terminal con `npm run build` terminado sin errores**
> Guárdala como `docs/screenshots/09-build-terminal.png` y reemplaza este bloque por:
> `![Build en la terminal](docs/screenshots/09-build-terminal.png)`

<!-- ![Build en la terminal](docs/screenshots/09-build-terminal.png) -->

**3. Abre la página de extensiones** — escribe `chrome://extensions` en la barra de direcciones.

> 📸 **Captura pendiente — página chrome://extensions**
> Guárdala como `docs/screenshots/10-chrome-extensions.png` y reemplaza este bloque por:
> `![chrome://extensions](docs/screenshots/10-chrome-extensions.png)`

<!-- ![chrome://extensions](docs/screenshots/10-chrome-extensions.png) -->

**4. Activa el «Modo de desarrollador»** — interruptor en la esquina superior derecha.

> 📸 **Captura pendiente — interruptor «Modo de desarrollador» activado y barra con «Cargar descomprimida»**
> Guárdala como `docs/screenshots/11-modo-desarrollador.png` y reemplaza este bloque por:
> `![Modo de desarrollador](docs/screenshots/11-modo-desarrollador.png)`

<!-- ![Modo de desarrollador](docs/screenshots/11-modo-desarrollador.png) -->

**5. Pulsa «Cargar descomprimida»** y selecciona la carpeta **`dist/`** (también vale el ZIP de `release/` ya descomprimido).

> 📸 **Captura pendiente — selector de carpetas con `dist/` seleccionada**
> Guárdala como `docs/screenshots/12-cargar-descomprimida.png` y reemplaza este bloque por:
> `![Cargar descomprimida](docs/screenshots/12-cargar-descomprimida.png)`

<!-- ![Cargar descomprimida](docs/screenshots/12-cargar-descomprimida.png) -->

**6. Verifica que aparece la tarjeta «Grabador de Pantalla»** (versión 0.6.0) y sin errores.

> 📸 **Captura pendiente — tarjeta de la extensión instalada en chrome://extensions**
> Guárdala como `docs/screenshots/13-tarjeta-extension.png` y reemplaza este bloque por:
> `![Tarjeta de la extensión](docs/screenshots/13-tarjeta-extension.png)`

<!-- ![Tarjeta de la extensión](docs/screenshots/13-tarjeta-extension.png) -->

**7. Fija la extensión en la barra** — icono de piezas de puzzle 🧩 → chincheta junto a «Grabador de Pantalla».

> 📸 **Captura pendiente — menú de extensiones con la chincheta para fijar el icono**
> Guárdala como `docs/screenshots/14-fijar-extension.png` y reemplaza este bloque por:
> `![Fijar la extensión](docs/screenshots/14-fijar-extension.png)`

<!-- ![Fijar la extensión](docs/screenshots/14-fijar-extension.png) -->

**8. Listo.** Haz clic en el icono para abrir el popup. Si vas a usar el micrófono, Chrome pedirá el permiso la primera vez que lo actives.

> - Tras cada `npm run build`, pulsa ↻ en la tarjeta de la extensión para recargarla.
> - **No cargues la raíz del repositorio**: incluiría `node_modules/` y `research/`. El paquete es `dist/`.
> - Los atajos (<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> / <kbd>P</kbd>) se pueden cambiar en `chrome://extensions/shortcuts`.

## Uso

1. Icono de la extensión → elige los ajustes (se guardan para las próximas grabaciones):

   | Ajuste | Opciones |
   |---|---|
   | 🎙️ Micrófono | OFF / ON. La primera vez se abre una pestaña que pide el permiso. |
   | 🔊 Audio de la pestaña | ON / OFF |
   | Resolución | Automática · 720p · 1080p (nunca se amplía la fuente) |
   | FPS | 30 · 60 |
   | Calidad | Automática · Alta · Máxima |
   | Formato | **MP4 (H.264 + AAC)** (por defecto) · WebM (original, sin convertir) |
   | ⬇ Descargar al terminar | ON (por defecto) / OFF: la grabación siempre se guarda en la biblioteca |
   | Cuenta regresiva | Sin cuenta regresiva · 3 segundos |

2. **● Iniciar grabación** → selector nativo de Chrome → elige pestaña, ventana o pantalla.
3. Si hay cuenta regresiva, se ve **3 → 2 → 1** en el controlador y en el badge, y después **🔴 GRABANDO**.
4. El controlador muestra la duración, el estado de cada audio y el nivel del micrófono, junto a **⏸ Pausar / ▶ Reanudar / ■ Detener**.
5. Al detener:
   - **MP4:** se convierte en tu equipo. Verás PREPARANDO → CONVIRTIENDO (porcentaje y tiempo restante) → FINALIZANDO → DESCARGANDO, y se descarga `grabacion-AAAA-MM-DD_HH-MM-SS.mp4`. Puedes **cancelar** en cualquier momento.
   - Si cancelas o la conversión falla, el WebM sigue disponible: **↻ Reintentar MP4 · ⬇ WebM · Descartar**.
   - **WebM:** se descarga directamente, sin convertir.
6. **✓ Grabación lista:** miniatura, título y duración, con **▶ Ver grabación · ⬇ Descargar · Mis grabaciones**. Toda grabación terminada queda en la **biblioteca** («📁 Mis grabaciones» en el popup): lista por días, preview, renombrar, descargar y eliminar.

7. **📝 Transcribir** (opcional): en «Mis grabaciones», abre una grabación. El panel **Transcripción**, junto al vídeo, permite elegir el modelo (**Estándar** o **Alta precisión**) y pulsar **Transcribir**. La primera vez se pide permiso para descargar el modelo. Después verás el progreso y el tiempo restante, con **Cancelar**. El texto aparece por fragmentos con su minuto; al pulsar uno, el vídeo salta a ese instante. Puedes **📋 Copiar**, **⬇ .txt** (con o sin marcas de tiempo) y **↻ Volver a transcribir**. Nunca se transcribe nada automáticamente.

Atajos: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> inicia o detiene, y <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> pausa o reanuda. Se cambian en `chrome://extensions/shortcuts`.

## Build, validaciones y tests

```bash
npm run validate   # manifest, permisos, CSP, rutas, atajos, integridad de src/vendor, sin red
npm test           # tests unitarios (node:test), incluido el conversor con un Mediabunny falso
npm run build      # dist/: allowlist + referencias completas + sin archivos prohibidos + validador sobre dist/
npm run package    # build + ZIP reproducible en release/
npm run e2e        # build + E2E en Chrome real CARGANDO dist/ + cuelgue (e2e-crash) + biblioteca (e2e-library) + transcripción (e2e-transcription)
```

- `build` copia **solo** `manifest.json`, `icons/`, `src/` (incluido `src/vendor/`) y `THIRD_PARTY_NOTICES.md`. Falla si falta algo referenciado (HTML, imports estáticos o dinámicos, vendors), si hay código que nadie referencia o si aparece algo prohibido (`node_modules`, `research`, tests, vídeos, logs, archivos ocultos).
- El E2E graba con un micrófono falso de Chrome y una pestaña animada con tono de 440 Hz. Analiza cada archivo descargado: pistas, códecs, nivel H.264, fotogramas, duración, seek, audio decodificado, `moov` al principio, limpieza de OPFS/IndexedDB, cancelaciones, falta de espacio, cierre del controlador y cuelgue de Chrome a mitad de conversión.
- `e2e-transcription` graba una pestaña que reproduce **voz humana real en español** (Wikipedia hablada, CC BY-SA, `tests/fixtures/audio/`) y la transcribe con el **modelo Whisper real**. Usa un perfil persistente en `.cache/` para descargar el modelo (~76 MB) solo la primera vez. Con `E2E_FRESH_PROFILE=1` usa un perfil limpio y prueba también la primera descarga. Necesita conexión a Hugging Face la primera vez.
- Requisitos: `google-chrome` 137 o superior (o `CHROME_BIN`) y Node 22.2 o superior (`zlib.crc32` para el ZIP).

## Estructura del proyecto

```
├── manifest.json, icons/         → paquete
├── src/                          → paquete (código de la extensión + src/vendor)
├── THIRD_PARTY_NOTICES.md        → paquete
├── scripts/                      build, package, validate, e2e, e2e-crash, vendor-deps
├── tests/                        tests unitarios (+ fixtures/audio para el E2E de transcripción)
├── docs/                         informes de QA y capturas (docs/screenshots/)
├── research/                     benchmarks e investigación (NUNCA entra en dist/)
├── dist/                         generado por npm run build (no versionado)
└── release/                      ZIP generado por npm run package (no versionado)
```

---

## Arquitectura

```
Popup / Controlador (ventana o PiP) / Atajos
        │ comandos                         ▲ storage.onChanged     ▲ BroadcastChannel
        ▼                                  │ (estado)              │ (nivel de micro, ~10 Hz)
  Service worker ──── chrome.storage.session                       │
  (coordinador)   ──OFFSCREEN_*──▶  Offscreen document ────────────┘
        ▲                           └ RecordingSession
        └──── eventos REC_* ─────────   getDisplayMedia → negociar resolución/FPS
                                        → micrófono → grafo de audio → cuenta regresiva
                                        → MediaRecorder → fragmentos → IndexedDB
                                        → WebM (Blob en disco) → Duration
                                    └ VideoConverter (Mp4Converter)          [solo si Formato = MP4]
                                        WebM → demux (Mediabunny) → decodificar (WebCodecs)
                                        → H.264 (WebCodecs) + AAC (WebCodecs o WASM)
                                        → MP4 fastStart 'reserve' → StreamTarget → OPFS
                                    → descarga (chrome.downloads) → limpieza IndexedDB + OPFS
```

| Módulo | Responsabilidad |
|---|---|
| `src/background/service-worker.js` | Estado (`storage.session`), offscreen, badge, controlador, descarga y limpieza de IndexedDB. Procesa los mensajes de uno en uno. |
| `src/offscreen/offscreen.js` | Puente entre el service worker y `RecordingSession`. Publica el nivel del micrófono. |
| `src/recording/recording-session.js` | Una grabación completa. No usa APIs de extensión. |
| `src/recording/screen-recorder.js` | `MediaRecorder` con persistencia ordenada de fragmentos y pausa/reanudar. |
| `src/recording/chunk-store.js` | IndexedDB: grabaciones y fragmentos. |
| `src/recording/audio.js` | Plan de audio (ninguno / pestaña / micrófono / mezcla), Web Audio y nivel. |
| `src/recording/video-quality.js` | Resolución y FPS seguros con fallback, bitrate y opciones de `MediaRecorder`. |
| `src/recording/webm-duration.js` | Escribe `Duration` en la cabecera WebM. |
| `src/conversion/video-converter.js` | Contrato `VideoConverter`: `convert(input, { signal, onProgress })`, fases y errores tipados. |
| `src/conversion/mp4-converter.js` | Implementación WebCodecs + Mediabunny + AAC (bucle propio de muestras). |
| `src/conversion/conversion-plan.js` | Cálculos puros: bitrate, espacio, duración de fotogramas, priming AAC, ETA y ritmo entre pistas. |
| `src/conversion/temp-files.js` | Archivos temporales en OPFS y limpieza de huérfanos. |
| `src/shared/database.js` | IndexedDB versionada (v1 temporales, v2 biblioteca) y migraciones. |
| `src/library/library-service.js` | Biblioteca: guardar, listar, renombrar, eliminar y reconciliar (une repositorio, archivos y miniatura). |
| `src/library/library-repository.js` | Metadatos en IndexedDB. |
| `src/library/library-files.js` | Vídeo y miniatura en OPFS (mover, escribir por stream, borrar). |
| `src/library/thumbnail.js` | Miniatura JPEG ≤ 320×180 de un fotograma cercano al inicio. |
| `src/library/recording-meta.js` | Modelo `Recording`, títulos, nombres de archivo y agrupación por día (puro). |
| `src/library/library.html/.js/.css` | Página «Mis grabaciones»: lista, preview, renombrar, descargar y eliminar. |
| `src/permission/` | Página visible que pide el permiso de micrófono. |
| `src/shared/` | Mensajes, estado, ajustes, cronómetro, errores y componente de controles compartido. |

### 3A · Persistencia en IndexedDB

- Cada grabación tiene un **UUID** (`crypto.randomUUID()`). Cada segundo, el fragmento de `MediaRecorder` se escribe en IndexedDB **en orden** y deja de estar en memoria.
- Al detener, los fragmentos se unen en un `Blob`. Chrome guarda en disco los Blobs de IndexedDB, así que el Blob final está respaldado por archivo y no ocupa RAM.
- **Limpieza:** se borran los fragmentos después de una descarga completada, al cancelar, si la grabación falla, al iniciar una nueva grabación (los restos huérfanos) y al arrancar Chrome o recargar la extensión.
- Si el disco se llena (`QuotaExceededError`), la grabación se detiene y se guarda lo grabado hasta ese momento.
- **Qué NO se garantiza:** recuperar una grabación tras un cierre o fallo de Chrome. El último fragmento puede no haberse escrito y la sesión de grabación se pierde. Por eso no se ofrece recuperación y esos restos se eliminan al arrancar. Lo que sí garantiza esta fase es que las grabaciones largas no dependen de la RAM.

### 3B · Duración y seek del WebM

- **Diagnóstico:** analicé WebM reales de Chrome. `MediaRecorder` escribe en modo streaming: el `Segment` y los `Cluster` tienen tamaño desconocido, `Info` no tiene `Duration` y no hay `SeekHead` ni `Cues`. Por eso muchos reproductores muestran una duración desconocida y hacen seek de forma lenta o imprecisa.
- **Solución implementada** (sin dependencias, unas 200 líneas): insertar `Duration` en `Info` reescribiendo solo la cabecera. El resto del archivo se reutiliza con `Blob.slice()`, sin cargarlo en memoria. Es seguro porque no hay `SeekHead` cuyos offsets se puedan desplazar; si la estructura no es la esperada, el archivo se deja intacto.
- **Verificado en Chrome:** sin el parche, `video.duration` es `Infinity`. Con el parche, Chrome lee la duración exacta y el seek funciona en todos los archivos del E2E.
- **No genera `Cues`** (índice de seek). Hacerlo exige remuxear el archivo entero, que es justo lo que hará la conversión a MP4. Se descartaron `ts-ebml`, que es pesada y lee el archivo completo, y `fix-webm-duration`, que es equivalente pero carga todo el archivo en memoria.

### 3C/3D · Audio

| Caso | Plan | Cómo |
|---|---|---|
| 1. Solo vídeo | `none` | sin pista de audio (mimeType sin Opus) |
| 2. Vídeo + pestaña | `tab` | track de la pestaña, directo |
| 3. Vídeo + micrófono | `mic` | track del micrófono, directo; un `AnalyserNode` alimenta el indicador |
| 4. Vídeo + pestaña + micrófono | `mix` | Web Audio → `MediaStreamAudioDestinationNode` → una sola pista |

- **Permiso:** el offscreen no puede mostrar el aviso de permiso. Comprobado: `getUserMedia` falla allí con «Permission dismissed». Por eso, al activar 🎙️, se abre una **página visible** que explica para qué es y pide el permiso. La opción solo queda en ON si se concede. El micrófono nunca se abre si la opción está en OFF, y Chrome muestra además su propio indicador de micrófono en uso.
- **Micrófono rechazado o desconectado:** se graba sin micrófono y la UI muestra «⚠ Sin acceso» con un mensaje.
- **Sin duplicados ni eco:** nada se conecta a `ctx.destination`, cada fuente entra una sola vez en la mezcla y el micrófono usa `echoCancellation`.
- **Sincronización:** `MediaRecorder` pausa vídeo y audio a la vez. La mezcla añade unos pocos milisegundos de latencia (un render quantum de Web Audio).
- **Pestaña sin audio:** Chrome entrega igualmente un track, silencioso, y el archivo lleva una pista en silencio. Si la fuente no comparte audio (ventana o pantalla en Linux, o «Compartir audio» desmarcado), se muestra «— No disponible».

### 3F · Calidad

- `getDisplayMedia` solo recibe FPS (`ideal`/`max`). Comprobado en Chrome 155, en captura de pestaña:
  - `width/height.max` funcionan como **tamaño objetivo**: una pestaña de 780 px salía a 1920×1080.
  - `getSettings()` informa del **tamaño de la pantalla**, no del contenido.
  - Un `applyConstraints` sin tamaño **vuelve al tamaño de la pantalla**.
- **Solución:** medir el tamaño real del primer fotograma y fijar explícitamente `min(caja pedida, fuente)`, conservando la proporción. Verificado: 720p sobre una pestaña de 1600×912 da 1262×720, y 1080p sobre la misma pestaña da 1600×912 (no amplía).
- **Fallback sin reabrir el selector:** `applyConstraints` prueba, en orden, la combinación pedida, luego 30 fps, luego la resolución nativa y luego la configuración nativa sin cambios. `MediaRecorder` prueba primero con mimeType y bitrate, luego solo con mimeType y luego sin opciones.
- **Bitrate:** Automática deja decidir a Chrome. Alta ≈ 0,1 bits/píxel (1080p30 ≈ 6 Mbps) y Máxima ≈ 0,2 bits/píxel (techo de 25 Mbps), calculados sobre la resolución y los FPS **reales**.

### 3G · Cuenta regresiva

El selector de Chrome va **primero**: la captura necesita que elijas una fuente y no tendría sentido contar mientras eliges. Después de elegir, la captura ya está activa (Chrome muestra su indicador) pero **no se graba nada** hasta terminar 3 → 2 → 1. Cancelar o «Dejar de compartir» durante la cuenta regresiva vuelve a LISTO sin crear ningún archivo.

### 5 · Biblioteca local de grabaciones

| Qué | Dónde | Por qué |
|---|---|---|
| Metadatos (título, fecha, duración, resolución, FPS, formato, tamaño, audio, fuente) | IndexedDB `screen-recorder` v2, almacén `library` (índice `createdAt`) | Consultas rápidas y ordenadas; listar 100 grabaciones lee solo metadatos |
| Vídeo | OPFS `library/<id>/recording.mp4` o `.webm` | Archivos grandes respaldados por disco. El MP4 se **mueve** (`FileSystemHandle.move`) desde el temporal de conversión, sin copia; el WebM se escribe por stream desde los fragmentos. Nunca hay `arrayBuffer()` ni Base64 |
| Miniatura | OPFS `library/<id>/thumbnail.jpg` (≤ 320×180, ~3–30 KB) | Un fotograma a ~1 s decodificado con Mediabunny; borrar la carpeta elimina vídeo y miniatura juntos |

- **Formato guardado:** se conserva el formato final elegido, MP4 o WebM, no ambos, para no duplicar espacio. Si el MP4 se cancela o falla, «⬇ WebM» guarda en la biblioteca el WebM original.
- **Orden de guardado frente a cuelgues:** vídeo → miniatura → metadatos. Al arrancar sin sesión activa, `reconcile()` borra las carpetas sin metadatos y los metadatos sin vídeo.
- **Migración:** la v1 (almacenes temporales `recordings`/`chunks`) se actualiza a la v2 añadiendo `library`, sin tocar los datos existentes. Antes de la fase 5 no se conservaban grabaciones terminadas, así que no hay nada más que migrar.
- **Descarga automática conservada:** antes cada grabación se descargaba al terminar. Se mantiene por defecto (ajuste «Descargar al terminar») y la descarga sale del archivo ya guardado en la biblioteca. Si la descarga se cancela, la grabación sigue en la biblioteca.
- **Preview:** `<video controls>` con una URL `blob:` del `File` de OPFS. El navegador lee el archivo por partes desde disco (seek incluido); al salir se revoca la URL.
- **Rendimiento:** con 100 grabaciones, la página carga en ~30 ms, solo las miniaturas visibles se cargan (`IntersectionObserver`) y el heap de JS se queda en ~3 MB.
- **Persistencia:** sobrevive al cierre del popup, al reinicio de Chrome (verificado en el E2E) y a las actualizaciones de la extensión (IndexedDB y OPFS se conservan). Solo se borra al **desinstalar** la extensión.

### 6 · Transcripción local (Whisper)

**Elección:** Whisper con [transformers.js](https://github.com/huggingface/transformers.js) 4.3.1 + ONNX Runtime Web (WASM, CPU), modelos cuantizados q8 de `onnx-community`. Es **100 % local** y **sin coste por uso**. Se descartaron estas alternativas:
- **Web Speech API:** su modo local (`processLocally`) no transcribe archivos; con una pista de un archivo devolvió `aborted` sin texto. El modo normal envía el audio a servidores de Google.
- **APIs de pago:** requieren clave, coste por minuto y enviar el audio fuera.

| | Estándar (`whisper-base`) | Alta precisión (`whisper-small`) |
|---|---|---|
| Descarga única | 79 MB | 251 MB |
| RAM adicional medida | ~0,6 GB | ~1,2 GB |
| Velocidad medida (1 hilo, portátil x86-64) | ~0,3–0,4 × la duración (10 min → 3–4 min) | ~1,15 × la duración (10 min → ~12 min) |
| Calidad (voz real) | buena; falla en algunos nombres propios | muy buena: nombres, tildes y puntuación |

- **Requisitos:** Chrome 116+ con WebAssembly SIMD (cualquier CPU x86-64/ARM64 de los últimos ~8 años) y RAM libre según la tabla. No necesita GPU.
- **Descarga del modelo:** al pulsar «Transcribir» por primera vez con un modelo, un diálogo explica el tamaño y el origen (Hugging Face). Solo se descarga si aceptas. Las revisiones están **fijadas por commit** (`src/transcription/models.js`) y los archivos quedan en la Cache Storage de la extensión, así que no se vuelven a descargar. «Eliminar modelos descargados» los borra.
- **Código empaquetado frente a datos descargados:** MV3 prohíbe código remoto, así que transformers.js y el runtime WASM de ONNX (14 MB, solo CPU) van **dentro del paquete** (`src/vendor/transformers/`, con hashes verificados por `npm run validate`). Lo único que se descarga son los pesos del modelo, que son datos.
- **Flujo, sin bloquear la interfaz:** todo corre en un **Web Worker** de la página de la biblioteca:
  1. Mediabunny lee el MP4/WebM **por partes** desde OPFS y decodifica **solo el audio** (WebCodecs).
  2. El audio se mezcla a mono y se remuestrea a 16 kHz en streaming.
  3. Se trocea en **bloques de ~60 s**, cortando en el tramo más silencioso para no partir palabras.
  4. Whisper transcribe cada bloque.

  En memoria solo hay un bloque (~4 MB de audio), así que la RAM no crece con la duración. El hilo principal no se bloquea: el retraso máximo medido durante una transcripción es de 1 ms.
- **Silencio:** los bloques sin voz (RMS < −54 dBFS) no se envían al modelo, porque Whisper «alucina» con el silencio. También se filtran frases típicas de alucinación («Subtítulos realizados por la comunidad de Amara.org»…) y repeticiones.
- **Persistencia:** IndexedDB `screen-recorder` **v3**, almacén `transcripts`, con clave el id de la grabación. Guarda estado, modelo, revisión, segmentos `{start, end, text}` y el punto de avance. Se guarda **bloque a bloque**: reabrir la grabación muestra el texto al instante, sin reprocesar. La migración v2 → v3 solo añade el almacén: las grabaciones anteriores quedan «Pendiente» y no se procesan solas.
- **Estados:** Pendiente → Procesando (preparando / descargando modelo / transcribiendo, con % y tiempo restante) → Completada · Error. Si se cierra Chrome o la pestaña a mitad, queda **Interrumpida**, con **▶ Reanudar** (continúa desde el último bloque guardado, sin duplicar texto) o **Descartar**. **Cancelar** termina el worker al instante y borra lo parcial; el vídeo no se toca.
- **Duplicados:** una sola transcripción a la vez en todo Chrome (Web Lock `transcription`). Otra pestaña de la biblioteca muestra «Transcribiendo en otra pestaña…». No se puede iniciar durante una grabación, para no competir por la CPU.
- **Borrado:** eliminar una grabación borra su transcripción, y la cancela si estaba en curso. `reconcile()` elimina las transcripciones huérfanas al arrancar.
- **Sin audio:** si la grabación se hizo sin audio, el botón se desactiva y lo explica. Si el archivo no tiene pista de audio, el error `no-audio` aparece al instante, sin descargar ni cargar el modelo.

### 4B · Exportación MP4 (H.264 + AAC)

- **Contrato:** `RecordingSession` entrega el WebM y no sabe nada de la conversión. El offscreen se lo pasa a un `VideoConverter`. Hoy es `Mp4Converter`; mañana podría ser otra implementación sin tocar la grabación.
- **Nivel H.264 según FPS:** ni Mediabunny ni el codificador de Chrome tienen en cuenta los FPS al declarar el nivel (720p60 salía como nivel 3.1, que solo admite 720p30). La extensión calcula el nivel con la tabla de la norma (macrobloques por fotograma, macrobloques por segundo y bitrate) y, si el codificador declara uno inferior, lo sube en el `avcC` antes de escribir el MP4. Si WebCodecs no admite la combinación exacta (resolución + FPS + nivel), se informa y se conserva el WebM: nunca se baja a 30 fps en silencio.
- **FPS reales:** el mensaje final muestra los FPS del MP4. Si se pidieron 60 y la captura entregó bastantes menos (Chrome solo envía fotogramas cuando el contenido cambia), se avisa explícitamente.
- **Fotogramas N → N:** los WebM de MediaRecorder no tienen `BlockDuration`, y el demuxer deja a 0 la duración de algunos bloques (7,6 % en nuestras grabaciones). `Conversion.execute()` de Mediabunny los descarta como si estuvieran «fuera del recorte». Por eso hay un bucle propio (`VideoSampleSink` → `VideoSampleSource`) que recalcula cada duración a partir del timestamp siguiente. Verificado: 1758 → 1758 y 1802 → 1802 fotogramas.
- **Memoria:** el MP4 se escribe incrementalmente en un archivo de **OPFS** (`StreamTarget`) y nunca está entero en RAM. Las colas de decodificación y codificación están acotadas y el pico no crece con la duración (ver resultados).
- **Fast start sin RAM:** `fastStart: 'reserve'` reserva al principio el espacio del índice `moov`, calculado con el número exacto de fotogramas del WebM. El archivo sale como `ftyp moov free mdat`, reproducible en streaming.
- **AAC:** si WebCodecs lo soporta (Windows y macOS) se usa el nativo; si no (Linux), el codificador WASM de FFmpeg. El codificador WASM añade 1024 muestras de priming (≈ 21 ms a 48 kHz), así que el audio se adelanta ese tiempo y el muxer lo ajusta con una *edit list*. Verificado: el desfase A/V del MP4 es idéntico al del WebM (62,3 ms → 62,3 ms). Con AAC nativo no se aplica la compensación, porque no se ha podido verificar en este equipo (ver compatibilidad).
- **Bitrate H.264**, elegido con pruebas de texto en pantalla a 1080p. Por encima de 0,06 bits/píxel el PSNR no mejora y el texto se ve igual de nítido:

  | Calidad | bits/píxel | 720p30 | 1080p30 |
  |---|---|---|---|
  | Automática | 0,06 | 1,7 Mbps (~12 MB/min) | 3,7 Mbps (~26 MB/min) |
  | Alta | 0,09 | 2,5 Mbps | 5,6 Mbps |
  | Máxima | 0,14 | 3,9 Mbps | 8,7 Mbps |

  Audio AAC: 128 kbps (192 kbps en Máxima).
- **Espacio:** antes de convertir se exige `MP4 estimado × 1,25 + 64 MB` libres en la cuota de la extensión (`navigator.storage.estimate()`). El MP4 estimado es duración × (bitrate de vídeo + audio). El 1,25 cubre que el modo VBR supere el objetivo, y los 64 MB cubren el índice reservado, el archivo swap de OPFS y otros datos. El WebM ya ocupa su espacio en IndexedDB. Si no hay espacio suficiente, no se empieza y se explica cuánto falta.
- **Temporales:** `conversion-temp/<id>.mp4` en OPFS. Se borra al terminar la descarga, al cancelar, si falla y al descartar. Los huérfanos (por ejemplo, si Chrome se cerró a mitad de una conversión) se borran al arrancar Chrome y antes de cada conversión.
- **Cancelar** aborta la lectura, cancela los codificadores (`Output.cancel()`), cierra todos los fotogramas, borra el temporal y no genera ninguna descarga parcial. Es seguro en cualquier porcentaje.
- **CSP:** `script-src 'self' 'wasm-unsafe-eval'`. `'wasm-unsafe-eval'` solo permite compilar el WebAssembly empaquetado (AAC); no permite `eval()` de JavaScript ni código remoto.

## Ubuntu / Linux: qué se puede capturar

| Fuente | Vídeo | Audio |
|---|---|---|
| **Pestaña** de Chrome | ✅ | ✅ audio de la pestaña |
| **Ventana** | ✅ (en Wayland, a través del portal del sistema) | ❌ Chrome en Linux no captura audio de ventanas |
| **Pantalla completa** | ✅ (en Wayland, a través del portal del sistema) | ❌ no hay audio del sistema en Linux |
| **Micrófono** | — | ✅ con la opción activada y el permiso concedido |

- Para grabar una ventana o la pantalla **con tu voz**, activa el micrófono. El sonido de otras aplicaciones no se puede capturar con `getDisplayMedia` en Linux.
- **Wayland:** al elegir ventana o pantalla aparece además el diálogo de xdg-desktop-portal (PipeWire). Picture-in-Picture puede no mantenerse «siempre encima» en GNOME/Wayland. Alternativas: `--ozone-platform=x11`, o <kbd>Alt</kbd>+<kbd>Espacio</kbd> → «Siempre encima» en el controlador. Para saber tu sesión: `echo $XDG_SESSION_TYPE`.
- **Micrófono:** Chrome usa PulseAudio/PipeWire. El dispositivo es el predeterminado del sistema (Ajustes → Sonido → Entrada).

## Solución de problemas

| Síntoma | Qué hacer |
|---|---|
| Chrome dice «No se pudo cargar el manifiesto» o la carpeta incluye `node_modules` | Cargaste la raíz del repo. Carga la carpeta **`dist/`** (ejecuta antes `npm run build`). |
| Cambié el código y no se refleja | `npm run build` y pulsa ↻ en la tarjeta de la extensión. |
| `npm run build` o `npm test` fallan por la versión de Node | Usa Node 22.2 o superior (`node -v`). |
| El micrófono no suena | Actívalo en el popup, concede el permiso en la pestaña que se abre y revisa la entrada predeterminada del sistema. |
| En Linux no hay audio al grabar una ventana o la pantalla | Es una limitación de Chrome: solo se captura audio de **pestañas**; activa el micrófono para añadir tu voz. Ver [Ubuntu / Linux](#ubuntu--linux-qué-se-puede-capturar). |
| La conversión a MP4 falla o se cancela | El WebM se conserva: usa **↻ Reintentar MP4** o **⬇ WebM**. |

## Seguridad y privacidad

- Ningún dato sale del equipo: el código de la extensión no hace `fetch`/XHR/WebSocket (lo comprueba `npm run validate`). **Única excepción, opcional:** la descarga de los pesos del modelo de transcripción desde `huggingface.co`, que hace transformers.js solo si la aceptas en el diálogo. Son peticiones GET de archivos públicos: **el audio y el texto nunca se envían**. Las librerías de `src/vendor/` contienen código de red genérico (por ejemplo, `UrlSource` de Mediabunny) que la extensión no usa. Los fragmentos (IndexedDB) y el MP4 temporal (OPFS) solo existen mientras se graba o se convierte.
- El micrófono está OFF por defecto. Se pide en una página visible, solo al activarlo, y solo se abre durante una grabación con la opción en ON.
- Los mensajes se aceptan solo si vienen de la propia extensión, y los eventos `REC_*` solo si vienen del offscreen.

## Limitaciones conocidas (v0.6)

- **Transcripción:**
  - Corre en la pestaña de «Mis grabaciones»: si la cierras, se interrumpe (se puede reanudar).
  - Usa un solo hilo de CPU. El multihilo sería ~1,8× más rápido, pero exige aislamiento entre orígenes (COOP/COEP) en todas las páginas de la extensión.
  - No se puede *iniciar* durante una grabación. Si empiezas a grabar con una transcripción ya en curso, esta continúa y compite por la CPU; conviene esperar a que termine o cancelarla.
  - El idioma está fijado en español.
  - Sin diarización (no distingue hablantes).
  - Las marcas de tiempo tienen precisión de fragmento (frase), no de palabra.
  - El modelo Estándar puede escribir mal nombres propios: «Alta precisión» lo mejora, a costa de velocidad.
  - Probada en Chrome/Linux. En Windows/macOS el código es el mismo (WASM), pero no se ha verificado allí.
- La biblioteca vive en el almacenamiento de la extensión: **desinstalarla borra las grabaciones** (las descargas en la carpeta Descargas no se tocan). El espacio cuenta contra la cuota de la extensión (~60 % del disco libre en Chrome).

- MP4 verificado en Chrome/Linux (H.264 software + AAC WASM). En Windows y macOS, WebCodecs puede usar codificadores por hardware y AAC nativo: la arquitectura los contempla, pero no se han probado en esos sistemas.
- El MP4 suele pesar más que el WebM (en la prueba de 10 minutos, 256 MB frente a 128 MB): H.264 es menos eficiente que VP9 a la misma calidad. La calidad «Automática» ya es el punto donde más bitrate deja de mejorar el texto.
- Durante la conversión no se puede empezar otra grabación (Chrome solo permite un offscreen document por extensión).
- WebM sin `Cues`: la duración es correcta, pero el seek en archivos muy largos puede ser lento en algunos reproductores.
- No se recuperan grabaciones tras un cierre o fallo de Chrome (ver 3A).
- No se puede elegir el micrófono: se usa el predeterminado.
- La cuenta regresiva se ejecuta en un documento oculto: puede retrasarse hasta unos 0,5–1 s.
- Si se cancela el diálogo «Guardar como» (cuando Chrome lo tiene activado), no se pierde nada: aparecen las opciones Reintentar MP4 / WebM / Descartar.

## Licencia

Código propio bajo licencia [MIT](LICENSE). Las dependencias vendorizadas en `src/vendor/` tienen sus propias licencias; ver [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
