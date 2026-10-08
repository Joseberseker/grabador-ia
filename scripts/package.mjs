#!/usr/bin/env node
/**
 * Empaqueta dist/ en un ZIP listo para la Chrome Web Store o para «Cargar descomprimida»
 * tras descomprimirlo:  npm run package  →  release/grabador-de-pantalla-<versión>.zip
 *
 * Escritor ZIP mínimo (deflate + CRC-32 de zlib), sin dependencias externas.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

const DOS_TIME = 0; // 1980-01-01: ZIP reproducible (mismo contenido → mismo ZIP)
const DOS_DATE = (1 << 5) | 1;
const locals = [];
const central = [];
let offset = 0;
for (const file of walk(DIST).sort()) {
  const name = Buffer.from(relative(DIST, file).split('\\').join('/'));
  const data = readFileSync(file);
  const compressed = deflateRawSync(data, { level: 9 });
  const useDeflate = compressed.length < data.length;
  const body = useDeflate ? compressed : data;
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // nombres UTF-8
  local.writeUInt16LE(useDeflate ? 8 : 0, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  locals.push(local, name, body);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(useDeflate ? 8 : 0, 10);
  entry.writeUInt16LE(DOS_TIME, 12);
  entry.writeUInt16LE(DOS_DATE, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(body.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += local.length + name.length + body.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length / 2, 8);
end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(ROOT, 'release'), { recursive: true });
const out = join(ROOT, 'release', `grabador-de-pantalla-${manifest.version}.zip`);
writeFileSync(out, Buffer.concat([...locals, centralBuf, end]));
console.log(`✓ ${relative(ROOT, out)} · ${(statSync(out).size / 1024 / 1024).toFixed(2)} MB · ${central.length / 2} archivos`);
