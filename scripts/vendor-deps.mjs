#!/usr/bin/env node
/**
 * Copia las dependencias de conversión MP4 de node_modules a src/vendor/.
 *
 * MV3 prohíbe cargar código remoto y la CSP no permite import maps inline, así que
 * las librerías se distribuyen como archivos propios de la extensión. Las versiones
 * están fijadas en package.json (devDependencies). Para actualizar:
 *   npm install && npm run vendor
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const NM = 'node_modules';
const OUT = 'src/vendor/mediabunny';
mkdirSync(OUT, { recursive: true });

const pkg = (name) => JSON.parse(readFileSync(`${NM}/${name}/package.json`, 'utf8'));
const mb = pkg('mediabunny');
const aac = pkg('@mediabunny/aac-encoder');

copyFileSync(`${NM}/mediabunny/dist/bundles/mediabunny.min.mjs`, `${OUT}/mediabunny.min.mjs`);
// Sin bundler: el import «desnudo» de la extensión AAC se reescribe a ruta relativa.
const aacCode = readFileSync(`${NM}/@mediabunny/aac-encoder/dist/bundles/mediabunny-aac-encoder.min.mjs`, 'utf8');
if (!aacCode.includes('from"mediabunny"')) throw new Error('Formato inesperado del bundle AAC: revisar el reescrito del import.');
writeFileSync(`${OUT}/mediabunny-aac-encoder.min.mjs`, aacCode.replaceAll('from"mediabunny"', 'from"./mediabunny.min.mjs"'));
copyFileSync(`${NM}/mediabunny/LICENSE`, `${OUT}/LICENSE-MPL-2.0.txt`);

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

// --- Transcripción local (Fase 6): transformers.js + runtime ONNX solo-CPU -----------
// transformers.min.js es autocontenido (incluye el JS de ONNX Runtime). El runtime WASM
// es CÓDIGO y debe ir empaquetado (MV3 prohíbe código remoto); los pesos del modelo son
// datos y se descargan una vez, a petición del usuario.
const TR_OUT = 'src/vendor/transformers';
mkdirSync(TR_OUT, { recursive: true });
const tr = pkg('@huggingface/transformers');
const ort = pkg('onnxruntime-web');
if (ort.license !== 'MIT') throw new Error(`Licencia inesperada de onnxruntime-web: ${ort.license}`);
copyFileSync(`${NM}/@huggingface/transformers/dist/transformers.min.js`, `${TR_OUT}/transformers.min.js`);
copyFileSync(`${NM}/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs`, `${TR_OUT}/ort-wasm-simd-threaded.mjs`);
copyFileSync(`${NM}/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm`, `${TR_OUT}/ort-wasm-simd-threaded.wasm`);
copyFileSync(`${NM}/@huggingface/transformers/LICENSE`, `${TR_OUT}/LICENSE-transformers-Apache-2.0.txt`);
// El paquete npm de onnxruntime-web declara MIT pero no incluye el texto: se reproduce aquí.
writeFileSync(`${TR_OUT}/LICENSE-onnxruntime-MIT.txt`, `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);
writeFileSync(`${TR_OUT}/VERSIONS.json`, JSON.stringify({
  '@huggingface/transformers': { version: tr.version, license: tr.license, files: { 'transformers.min.js': sha(`${TR_OUT}/transformers.min.js`) } },
  'onnxruntime-web': {
    version: ort.version, license: ort.license,
    files: { 'ort-wasm-simd-threaded.mjs': sha(`${TR_OUT}/ort-wasm-simd-threaded.mjs`), 'ort-wasm-simd-threaded.wasm': sha(`${TR_OUT}/ort-wasm-simd-threaded.wasm`) },
  },
}, null, 2) + '\n');
console.log(`✓ ${TR_OUT}: transformers ${tr.version}, onnxruntime-web ${ort.version}`);
writeFileSync(`${OUT}/VERSIONS.json`, JSON.stringify({
  mediabunny: { version: mb.version, license: mb.license, sha256: sha(`${OUT}/mediabunny.min.mjs`) },
  '@mediabunny/aac-encoder': { version: aac.version, license: aac.license, sha256: sha(`${OUT}/mediabunny-aac-encoder.min.mjs`) },
}, null, 2) + '\n');
console.log(`✓ ${OUT}: mediabunny ${mb.version}, @mediabunny/aac-encoder ${aac.version}`);
