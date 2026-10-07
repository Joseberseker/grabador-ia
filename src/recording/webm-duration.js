/**
 * Duración en WebM generados por MediaRecorder.
 *
 * Diagnóstico (analizado sobre WebM reales de Chrome): MediaRecorder escribe en
 * modo «streaming». El Segment y los Clusters tienen tamaño desconocido y el
 * elemento Info lleva TimecodeScale pero NO Duration. Tampoco hay SeekHead ni
 * Cues (índice de búsqueda). Por eso muchos reproductores muestran una duración
 * desconocida o errónea y hacen seek de forma imprecisa o lenta.
 *
 * Solución: insertar el elemento Duration dentro de Info. Solo se reescriben
 * los primeros bytes del archivo y el resto se reutiliza con Blob.slice(), sin
 * cargar el vídeo en memoria. Es seguro porque no hay SeekHead cuyos offsets se
 * puedan desplazar. Si la estructura no es la esperada, se devuelve el archivo
 * intacto.
 *
 * No genera Cues: crear un índice completo exige remuxear el archivo entero, y
 * eso lo hará la fase de conversión a MP4.
 */

const ID = Object.freeze({
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  CLUSTER: 0x1f43b675,
  CUES: 0x1c53bb6b,
});

const HEADER_SCAN_BYTES = 1024 * 1024;
const DEFAULT_TIMECODE_SCALE = 1_000_000; // ns por unidad (= 1 ms)

// ---------------------------------------------------------------------------
// Lectura EBML mínima
// ---------------------------------------------------------------------------

function vintLength(firstByte) {
  for (let length = 1, mask = 0x80; length <= 8; length += 1, mask >>= 1) {
    if (firstByte & mask) return length;
  }
  return 0; // byte 0x00: no válido
}

/** Lee un ID de elemento (conserva el bit marcador, como en la especificación). */
function readId(bytes, pos) {
  const length = vintLength(bytes[pos]);
  if (!length || length > 4 || pos + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i += 1) id = id * 256 + bytes[pos + i];
  return { id, length };
}

/** Lee un tamaño EBML. `unknown` = todos los bits a 1 (tamaño desconocido). */
function readSize(bytes, pos) {
  const length = vintLength(bytes[pos]);
  if (!length || pos + length > bytes.length) return null;
  let value = bytes[pos] & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + bytes[pos + i];
    allOnes &&= bytes[pos + i] === 0xff;
  }
  return { value, length, unknown: allOnes };
}

function readElement(bytes, pos) {
  const id = readId(bytes, pos);
  if (!id) return null;
  const size = readSize(bytes, pos + id.length);
  if (!size) return null;
  const dataStart = pos + id.length + size.length;
  return {
    id: id.id,
    start: pos,
    sizePos: pos + id.length,
    sizeLength: size.length,
    size: size.value,
    unknown: size.unknown,
    dataStart,
    end: size.unknown ? Infinity : dataStart + size.value,
  };
}

function readUint(bytes, start, length) {
  let value = 0;
  for (let i = 0; i < length; i += 1) value = value * 256 + bytes[start + i];
  return value;
}

function readFloat(bytes, start, length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
  return length === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

/** Codifica `value` como tamaño EBML ocupando exactamente `length` bytes. */
function encodeSize(value, length) {
  const max = 2 ** (7 * length) - 2; // el valor «todo unos» está reservado
  if (value > max) return null;
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function float64Element(id, value) {
  const out = new Uint8Array(2 + 1 + 8);
  out[0] = (id >> 8) & 0xff;
  out[1] = id & 0xff;
  out[2] = 0x88; // tamaño = 8
  new DataView(out.buffer).setFloat64(3, value);
  return out;
}

/** Localiza Segment e Info. Devuelve null si la estructura no es la esperada. */
function locateInfo(bytes) {
  const ebml = readElement(bytes, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.unknown) return null;
  const segment = readElement(bytes, ebml.end);
  if (!segment || segment.id !== ID.SEGMENT) return null;

  let pos = segment.dataStart;
  while (pos < bytes.length) {
    const el = readElement(bytes, pos);
    if (!el) return null;
    if (el.id === ID.INFO) {
      if (el.unknown || el.end > bytes.length) return null;
      return { segment, info: el };
    }
    // Un SeekHead antes de Info tiene offsets que no podemos desplazar, y un
    // Cluster significa que no hay Info en la cabecera.
    if (el.id === ID.SEEK_HEAD || el.id === ID.CLUSTER || el.unknown) return null;
    pos = el.end;
  }
  return null;
}

function readInfoChildren(bytes, info) {
  let timecodeScale = DEFAULT_TIMECODE_SCALE;
  let duration = null;
  for (let pos = info.dataStart; pos < info.end; ) {
    const el = readElement(bytes, pos);
    if (!el || el.unknown || el.end > info.end) return null;
    if (el.id === ID.TIMECODE_SCALE) timecodeScale = readUint(bytes, el.dataStart, el.size);
    if (el.id === ID.DURATION && (el.size === 4 || el.size === 8)) duration = el;
    pos = el.end;
  }
  return { timecodeScale, duration };
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Parchea la cabecera. Puro: sirve en Node y en el navegador.
 * @returns {{ head: Uint8Array, replacedBytes: number } | null}
 *   `head` sustituye a los primeros `replacedBytes` bytes del archivo original.
 */
export function patchWebmHeader(bytes, durationMs) {
  if (!(durationMs > 0)) return null;
  const located = locateInfo(bytes);
  if (!located) return null;
  const { segment, info } = located;
  const children = readInfoChildren(bytes, info);
  if (!children) return null;

  const value = (durationMs * 1_000_000) / children.timecodeScale;

  // Ya existe Duration: se sobrescribe en el sitio y la longitud no cambia.
  if (children.duration) {
    const head = bytes.slice(0, info.end);
    const view = new DataView(head.buffer, children.duration.dataStart, children.duration.size);
    if (children.duration.size === 4) view.setFloat32(0, value);
    else view.setFloat64(0, value);
    return { head, replacedBytes: info.end };
  }

  // Se inserta Duration al final de Info y se actualizan los tamaños.
  const durationEl = float64Element(ID.DURATION, value);
  const newInfoSize = encodeSize(info.size + durationEl.length, info.sizeLength);
  if (!newInfoSize) return null;

  let segmentSize = null;
  if (!segment.unknown) {
    segmentSize = encodeSize(segment.size + durationEl.length, segment.sizeLength);
    if (!segmentSize) return null;
  }

  const parts = [
    bytes.subarray(0, segment.sizePos),
    segmentSize ?? bytes.subarray(segment.sizePos, segment.dataStart),
    bytes.subarray(segment.dataStart, info.sizePos),
    newInfoSize,
    bytes.subarray(info.dataStart, info.end),
    durationEl,
  ];
  const head = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    head.set(part, offset);
    offset += part.length;
  }
  return { head, replacedBytes: info.end };
}

/**
 * Devuelve un Blob WebM con la duración escrita, o el original si no se puede
 * parchear de forma segura. Solo lee la cabecera.
 */
export async function setWebmDuration(blob, durationMs) {
  const headBytes = new Uint8Array(await blob.slice(0, HEADER_SCAN_BYTES).arrayBuffer());
  const patch = patchWebmHeader(headBytes, durationMs);
  if (!patch) return blob;
  return new Blob([patch.head, blob.slice(patch.replacedBytes)], { type: blob.type });
}

/**
 * Lee la cabecera de un WebM: duración (ms), escala y tipos de pista. Lo usan
 * los tests y el E2E para verificar los archivos generados.
 */
export function inspectWebm(bytes) {
  const located = locateInfo(bytes);
  if (!located) return null;
  const children = readInfoChildren(bytes, located.info);
  const durationMs = children?.duration
    ? (readFloat(bytes, children.duration.dataStart, children.duration.size) * children.timecodeScale) / 1_000_000
    : null;

  const tracks = [];
  const tracksEl = readElement(bytes, located.info.end);
  if (tracksEl?.id === ID.TRACKS && !tracksEl.unknown) {
    for (let pos = tracksEl.dataStart; pos < Math.min(tracksEl.end, bytes.length); ) {
      const entry = readElement(bytes, pos);
      if (!entry || entry.unknown) break;
      if (entry.id === ID.TRACK_ENTRY) {
        const track = {};
        for (let p = entry.dataStart; p < entry.end; ) {
          const el = readElement(bytes, p);
          if (!el || el.unknown) break;
          if (el.id === ID.TRACK_TYPE) track.type = readUint(bytes, el.dataStart, el.size) === 1 ? 'video' : 'audio';
          if (el.id === ID.CODEC_ID) track.codec = new TextDecoder().decode(bytes.subarray(el.dataStart, el.end));
          p = el.end;
        }
        tracks.push(track);
      }
      pos = entry.end;
    }
  }
  return {
    durationMs,
    timecodeScale: children?.timecodeScale ?? DEFAULT_TIMECODE_SCALE,
    segmentSizeUnknown: located.segment.unknown,
    tracks,
  };
}
