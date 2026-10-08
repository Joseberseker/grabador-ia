# QA · Fase 4C (estabilización)

Entorno: Google Chrome 155 headless, Linux x86_64 (8 núcleos), sin aceleración de vídeo por hardware. Extensión cargada **desde `dist/`** o desde el ZIP de `release/` descomprimido. Los datos completos están en `research/mp4-benchmark/results/qa-*.json`.

## Problemas encontrados y corregidos

| # | Problema | Impacto | Corrección |
|---|---|---|---|
| 1 | El nivel H.264 no tenía en cuenta los FPS (Mediabunny y el codificador de Chrome): 720p60 → nivel 3.1, 1080p60 → 4.0/4.1 | Decodificadores estrictos (hardware) podían rechazar o entrecortar el vídeo | Nivel calculado con la tabla A-1 (MaxFS, MaxMBPS, MaxBR); se sube en `avcC` + SPS si el codificador declara uno inferior. Verificado: 720p60 → 3.2, 1080p60 → 4.2 |
| 2 | Soporte H.264 consultado sin FPS ni nivel | Fallo tardío o salida inválida si el equipo no admite 60 fps | `VideoEncoder.isConfigSupported` con codec, resolución, FPS y bitrate exactos; si no se admite → error claro y WebM conservado |
| 3 | 60 fps pedidos con menos fps entregados, sin avisar | El usuario no sabía qué había obtenido | El mensaje final muestra los FPS reales y avisa si están por debajo del 85 % de lo pedido |
| 4 | Limpieza de huérfanos solo en `onInstalled`/`onStartup` | Tras recargar la extensión podían quedar temporales | Limpieza cada vez que arranca el service worker, solo si no hay sesión activa |
| 5 | No había build: cargar el repositorio incluía `node_modules/` y `research/` | Paquete de varios GB | `npm run build` (allowlist + verificación de referencias) y `npm run package` (ZIP reproducible) |
| 6 | Mensaje de error de espacio con la sugerencia del WebM duplicada | Cosmético | Corregido |

## Matriz de calidad (20 s, pestaña con animación a 60 Hz + audio de pestaña)

| Caso | Capturado | Fotogramas WebM → MP4 | FPS MP4 | Nivel | Vídeo | WebM → MP4 | Conversión |
|---|---|---|---|---|---|---|---|
| 720p30 Automática | 1280×662 | 602 → 602 | 30,0 | 3.1 | 1,52 Mbps | 3,9 → 4,0 MB | 2,9 s |
| 720p60 Automática | 1280×662 | 1204 → 1204 | 60,0 | 3.2 | 3,23 Mbps | 4,3 → 8,3 MB | 4,0 s |
| 1080p30 Automática | 1918×992 | 602 → 602 | 30,0 | 4.0 | 3,30 Mbps | 4,2 → 8,5 MB | 4,8 s |
| 1080p30 Alta | 1918×992 | 600 → 600 | 29,9 | 4.0 | 3,78 Mbps | 6,5 → 9,7 MB | 5,3 s |
| 1080p30 Máxima | 1920×992 | 598 → 598 | 29,9 | 4.0 | 3,79 Mbps | 6,8 → 9,7 MB | 5,6 s |
| 1080p60 Automática | 1918×992 | 905 → 905 | **45,0** ⚠ | 4.2 | 4,83 Mbps | 4,3 → 12,4 MB | 7,8 s |
| 1080p60 Máxima | 1918×992 | 971 → 971 | **48,4** ⚠ | 4.2 | 4,74 Mbps | 9,6 → 12,1 MB | 7,4 s |

- ⚠ A 1080p60, la **captura** (MediaRecorder VP9 por software en headless) entregó 45–54 fps según la duración. El aviso de FPS bajos se mostró en las grabaciones de 20 s (45 y 48 fps); en las de 1 y 10 minutos (52 y 54 fps) quedó justo por encima del umbral del 85 % (51 fps). El MP4 conserva todos los fotogramas grabados.
- En Alta y Máxima a 1080p30, el codificador H.264 se queda por debajo del bitrate objetivo con este contenido (gasta lo que necesita).

## Audio y modos de captura (20 s, 1080p30)

| Caso | Fotogramas | Audio MP4 | Sincronía WebM → MP4 |
|---|---|---|---|
| Pestaña, sin audio | 600 → 600 | — (solo vídeo) | — |
| Pestaña + micrófono (sin audio de pestaña) | 603 → 603 | AAC-LC mono | sin referencia sincronizada (micrófono falso) |
| Pestaña + audio de pestaña + micrófono | 603 → 603 | AAC-LC estéreo (mezcla) | 101,7 → 101,7 ms |
| Pantalla (captura **falsa** de Chrome) + micrófono | 400 → 400 (20 fps del dispositivo falso) | AAC-LC | — |

**Ventana y pantalla reales en Linux (PipeWire/X11): no probado.** Headless no tiene pantallas reales. El flujo se validó con el dispositivo de captura falso de Chrome, que entrega una pista de audio falsa que una pantalla real en Linux no tendría. Hace falta una prueba manual en Ubuntu (ver checklist).

## Sincronía A/V (pares destello/pitido; desfase en ms, WebM → MP4)

| Caso | Pares | Inicio | 60 s | Final |
|---|---|---|---|---|
| 1 min 1080p30 | 60 | 61,8 → 61,8 | 55,3 → 55,3 | 54,3 → 54,3 |
| 1 min 1080p60 | 60 | 70,3 → 70,3 | 57,7 → 57,7 | 63,5 → 63,5 |
| 10 min 1080p30 | 600 | 80,6 → 80,6 | 80,9 → 80,9 | 112,5 → 112,4 |
| 10 min 1080p60 | 600 | 69,9 → 69,9 | 77,7 → 77,7 | 60,5 → 60,5 |

La conversión conserva el desfase de la entrada (diferencia ≤ 0,1 ms) y no introduce deriva. Las variaciones entre tramos son propias de la grabación, porque están igual en el WebM.

El audio AAC termina **54–77 ms después** que el del WebM. Es el relleno final del codificador AAC (vaciado del búfer y último bloque de 1024 muestras) y es constante: no crece con la duración ni afecta a la sincronía.

## RAM (todos los procesos de Chrome; MB)

| Caso | Al empezar a convertir | Pico | Al terminar | +60 s | Conversión | WebM → MP4 |
|---|---|---|---|---|---|---|
| 1 min 1080p30 | 1775 | 1776 | 1535 | **1484** | 15,0 s | 13,0 → 25,4 MB |
| 1 min 1080p60 (52 fps) | 1788 | 1788 | 1530 | **1485** | 24,8 s | 13,2 → 39,8 MB |
| 10 min 1080p30 | 1607 | 1823 | 1579 | **1504** | 147,7 s | 128,5 → 255,1 MB |
| 10 min 1080p60 (54 fps) | 1593 | 1836 | 1600 | **1507** | 209,6 s | 133,6 → 408,7 MB |

El pico no crece con la duración (1776–1788 MB en 1 min frente a 1823–1836 MB en 10 min) y la RAM vuelve a ~1500 MB. No hay regresión respecto a la fase 4B (1816 MB de pico en 10 min a 30 fps).

## MP4 fast start

Los MP4 salen como `ftyp moov free mdat` en todos los casos. Prueba de descarga progresiva (HTTP sin rangos, 2 MB/s):

| MP4 | Recibido antes del primer fotograma |
|---|---|
| Producción (`moov` al principio) | **0,3 MB de 25,5 (1 %) · 0,2 s** |
| Benchmark con `moov` al final | 26,1 MB (100 %) · 12,9 s |

## Cancelación, errores y limpieza (E2E en Chrome real, cargando `dist/` y el ZIP)

| Camino | Resultado |
|---|---|
| Cancelar al 14 / 29 / 62 / 77 / 95 % de la misma conversión | CANCELADO, OPFS vacío, sin MP4 parcial, WebM disponible, CPU de la extensión en reposo (≤ 0,01 s de CPU en 2 s); el reintento completa N → N |
| Cancelar al 1 / 25 / 50 / 75 / 99 % (tests unitarios, deterministas) | `cancelled`, sin finalize, temporal borrado, 0 fotogramas abiertos |
| Sin espacio (estimate simulado) | «No hay espacio suficiente… se necesitan unos 65 MB y hay 1 MB»; WebM conservado; reintento con espacio → MP4 |
| Codificador sin soporte / 60 fps sin soporte / WebM corrupto / sin vídeo | Tests unitarios: `unsupported` o `failed` con mensaje claro y sin temporal |
| Cerrar el controlador durante la conversión | La conversión continúa y termina |
| **Cuelgue de Chrome (SIGKILL) al 46 % + reapertura** | OPFS (temporal, `.crswap` y huérfano) e IndexedDB vacíos; estado LISTO |
| Huérfano previo + exportación | Borrado antes de convertir |
| Éxito / reintento / descartar / WebM como alternativa | Temporales y fragmentos borrados en todos los casos |

`chrome.runtime.reload()` no se pudo automatizar: una extensión cargada por CDP no se vuelve a cargar tras recargarse. El cuelgue con reapertura cubre el mismo arranque en frío, y la limpieza al arrancar el service worker se probó en ese escenario.

## Compatibilidad

| Entorno | Estado |
|---|---|
| Chrome 155 / Linux | **Verificado**: H.264 High (niveles 3.1/3.2/4.0/4.2/5.1), AAC-LC (WASM), MP4 fast start, reproducción, seek, audio y sincronía |
| VLC | No probado |
| Windows (Chrome) | No probado. Se espera AAC nativo de WebCodecs (sin compensación de priming) y posiblemente H.264 por hardware |
| macOS (Chrome) | No probado. Ídem |
| iPhone / Safari | No probado |

## Checklist manual pendiente

1. Ubuntu, con interfaz: grabar **ventana** y **pantalla completa** (comprobar el diálogo del portal en Wayland y que no hay audio de sistema), con y sin micrófono.
2. Reproducir `research/mp4-benchmark/extension/inputs/qa-m1080-60-auto.mp4` y `qa-r1080-30-10min.mp4` en VLC, en el reproductor de Windows, en QuickTime y en un iPhone: imagen, audio, seek y sincronía.
3. Chrome en Windows y macOS: exportar 1080p30 y 1080p60, y comprobar que la sincronía coincide con la del WebM (AAC nativo).
