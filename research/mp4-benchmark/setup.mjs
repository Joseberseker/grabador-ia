#!/usr/bin/env node
/**
 * Copia las librerías candidatas de node_modules a extension/vendor/ para que la
 * extensión de benchmark las cargue como archivos propios (MV3 prohíbe código remoto).
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const nm = 'node_modules';
const v = 'extension/vendor';
mkdirSync(v, { recursive: true });
cpSync(`${nm}/mediabunny/dist/bundles/mediabunny.min.mjs`, `${v}/mediabunny.min.mjs`);
// Sin bundler ni import maps (CSP de MV3): se reescribe el import «desnudo».
const aac = readFileSync(`${nm}/@mediabunny/aac-encoder/dist/bundles/mediabunny-aac-encoder.min.mjs`, 'utf8')
  .replaceAll('from"mediabunny"', 'from"./mediabunny.min.mjs"');
writeFileSync(`${v}/mediabunny-aac-encoder.min.mjs`, aac);
cpSync(`${nm}/@ffmpeg/ffmpeg/dist/esm`, `${v}/ffmpeg`, { recursive: true });
cpSync(`${nm}/@ffmpeg/util/dist/esm`, `${v}/ffmpeg-util`, { recursive: true });
cpSync(`${nm}/@ffmpeg/core/dist/esm`, `${v}/core`, { recursive: true });
cpSync(`${nm}/@ffmpeg/core-mt/dist/esm`, `${v}/core-mt`, { recursive: true });
// Código de PRODUCCIÓN (src/conversion + src/vendor) para validarlo aislado, sin cambios.
cpSync('../../src/conversion', 'extension/prod/conversion', { recursive: true });
cpSync('../../src/vendor', 'extension/prod/vendor', { recursive: true });
console.log('✓ extension/vendor y extension/prod listos');
