#!/usr/bin/env node
/**
 * Validación estática de la extensión (sin dependencias):
 *  - manifest.json válido, MV3, permisos mínimos esperados.
 *  - Todos los archivos referenciados existen (manifest, <script>, <link>, imports).
 *  - Sin scripts inline ni handlers on* en HTML (CSP de MV3).
 *  - Sin URLs remotas ni APIs peligrosas (eval, innerHTML...) en el código.
 *  - Iconos PNG con las dimensiones declaradas.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Por defecto valida el árbol de desarrollo; `--root dist` valida el paquete de producción.
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0
  ? resolve(process.argv[rootArg + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
console.log(`Validando ${ROOT}`);
const EXPECTED_PERMISSIONS = ['downloads', 'offscreen', 'storage'];
// Páginas que se abren por código (no aparecen en el manifest).
const RUNTIME_PAGES = ['src/offscreen/offscreen.html', 'src/controller/controller.html', 'src/permission/permission.html', 'src/library/library.html'];
const errors = [];
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => errors.push(msg);
const rel = (p) => relative(ROOT, p);

function walk(dir, ext) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full, ext);
    return full.endsWith(ext) ? [full] : [];
  });
}

// --- manifest ---------------------------------------------------------------
console.log('manifest.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  ok('JSON válido');
} catch (e) {
  console.error(`✗ manifest.json inválido: ${e.message}`);
  process.exit(1);
}

if (manifest.manifest_version === 3) ok('manifest_version 3');
else fail('manifest_version debe ser 3');

for (const key of ['name', 'version', 'description']) {
  if (!manifest[key]) fail(`Falta "${key}" en manifest`);
}
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version ?? '')) fail('version con formato inválido');

const perms = [...(manifest.permissions ?? [])].sort();
if (JSON.stringify(perms) === JSON.stringify(EXPECTED_PERMISSIONS)) ok(`permisos mínimos: ${perms.join(', ')}`);
else fail(`Permisos inesperados: ${JSON.stringify(perms)} (esperado ${JSON.stringify(EXPECTED_PERMISSIONS)})`);
if (manifest.host_permissions?.length) fail('No debería haber host_permissions');
if (manifest.content_scripts?.length) fail('No debería haber content_scripts');
if (manifest.web_accessible_resources?.length) fail('No debería haber web_accessible_resources');

const csp = manifest.content_security_policy?.extension_pages ?? '';
// Única relajación permitida: 'wasm-unsafe-eval' (compilar WebAssembly empaquetado:
// codificador AAC). No permite eval() de JavaScript ni código remoto.
const cspWithoutWasm = csp.replace("'wasm-unsafe-eval'", '');
if (/unsafe-eval|unsafe-inline|https?:|blob:|data:/.test(cspWithoutWasm)) fail(`CSP demasiado permisiva: ${csp}`);
else if (!/script-src 'self'/.test(csp)) fail(`CSP sin script-src 'self': ${csp}`);
else ok(`CSP restrictiva (${csp.includes('wasm-unsafe-eval') ? "solo 'wasm-unsafe-eval' para el WASM empaquetado" : 'sin WASM'})`);

const manifestFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...RUNTIME_PAGES,
].filter(Boolean);
for (const f of manifestFiles) {
  if (!existsSync(join(ROOT, f))) fail(`manifest referencia un archivo inexistente: ${f}`);
}
ok(`${manifestFiles.length} rutas del manifest y páginas internas comprobadas`);

for (const [name, cmd] of Object.entries(manifest.commands ?? {})) {
  if (!cmd.description) fail(`El comando "${name}" no tiene descripción`);
  const key = cmd.suggested_key?.default;
  if (key && !/^(Ctrl|Alt)\+(Shift\+)?[A-Z0-9]$/.test(key)) fail(`Atajo con formato no válido: ${key}`);
  // Atajos ya reservados por Chrome: la extensión no podría usarlos.
  if (['Ctrl+Shift+R', 'Ctrl+Shift+P', 'Ctrl+Shift+N', 'Ctrl+Shift+T'].includes(key)) fail(`Atajo reservado por Chrome: ${key}`);
}
if (Object.keys(manifest.commands ?? {}).length > 4) fail('Chrome solo admite 4 atajos sugeridos');
ok(`${Object.keys(manifest.commands ?? {}).length} atajos de teclado`);

// --- iconos -----------------------------------------------------------------
console.log('iconos');
for (const [size, file] of Object.entries(manifest.icons ?? {})) {
  const buf = readFileSync(join(ROOT, file));
  const isPng = buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (!isPng) fail(`${file} no es PNG`);
  else if (w !== Number(size) || h !== Number(size)) fail(`${file} mide ${w}x${h}, se esperaba ${size}x${size}`);
}
ok('PNG con tamaños correctos');

// --- HTML -------------------------------------------------------------------
console.log('HTML');
for (const file of walk(join(ROOT, 'src'), '.html')) {
  const html = readFileSync(file, 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) fail(`${rel(file)}: script inline (prohibido por la CSP de MV3)`);
  if (/\son[a-z]+\s*=/i.test(html)) fail(`${rel(file)}: handler on* inline`);
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
    if (/^https?:|^\/\//.test(ref)) fail(`${rel(file)}: recurso remoto ${ref}`);
    else if (!existsSync(resolve(dirname(file), ref))) fail(`${rel(file)}: no existe ${ref}`);
  }
  ok(rel(file));
}

// --- JS ---------------------------------------------------------------------
console.log('JavaScript');
const FORBIDDEN = [
  [/\beval\s*\(/, 'eval()'],
  [/new\s+Function\s*\(/, 'new Function()'],
  [/\.innerHTML\s*=/, 'innerHTML'],
  [/document\.write\s*\(/, 'document.write()'],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(/, 'peticiones de red'],
  [/https?:\/\//, 'URL remota'],
];
// src/vendor queda fuera: son dependencias de terceros verificadas por hash (más abajo).
for (const file of walk(join(ROOT, 'src'), '.js').filter((f) => !rel(f).startsWith('src/vendor/'))) {
  const code = readFileSync(file, 'utf8');
  for (const [re, label] of FORBIDDEN) {
    if (re.test(code)) fail(`${rel(file)}: uso de ${label}`);
  }
  for (const [, spec] of code.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
    if (!spec.startsWith('.')) fail(`${rel(file)}: import no relativo "${spec}"`);
    else if (!existsSync(resolve(dirname(file), spec))) fail(`${rel(file)}: import inexistente "${spec}"`);
  }
  ok(rel(file));
}

// --- dependencias empaquetadas ---------------------------------------------
console.log('dependencias (src/vendor)');
const versionsPath = join(ROOT, 'src/vendor/mediabunny/VERSIONS.json');
if (existsSync(versionsPath)) {
  const versions = JSON.parse(readFileSync(versionsPath, 'utf8'));
  const files = { mediabunny: 'mediabunny.min.mjs', '@mediabunny/aac-encoder': 'mediabunny-aac-encoder.min.mjs' };
  for (const [name, info] of Object.entries(versions)) {
    const file = join(ROOT, 'src/vendor/mediabunny', files[name]);
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (sha !== info.sha256) fail(`${rel(file)} no coincide con VERSIONS.json (¿modificado a mano? ejecuta npm run vendor)`);
    else ok(`${name}@${info.version} (${info.license}) íntegro`);
  }
  const aac = readFileSync(join(ROOT, 'src/vendor/mediabunny/mediabunny-aac-encoder.min.mjs'), 'utf8');
  if (/from\s*"mediabunny"/.test(aac)) fail('mediabunny-aac-encoder.min.mjs conserva un import «desnudo» (no funciona sin bundler)');
} else {
  fail('Falta src/vendor/mediabunny/VERSIONS.json (ejecuta npm run vendor)');
}

// Transcripción local (fase 6): transformers.js + runtime ONNX (WASM solo-CPU).
const trVersionsPath = join(ROOT, 'src/vendor/transformers/VERSIONS.json');
if (existsSync(trVersionsPath)) {
  const versions = JSON.parse(readFileSync(trVersionsPath, 'utf8'));
  for (const [name, info] of Object.entries(versions)) {
    const bad = Object.entries(info.files).filter(([file, hash]) => {
      const full = join(ROOT, 'src/vendor/transformers', file);
      return !existsSync(full) || createHash('sha256').update(readFileSync(full)).digest('hex') !== hash;
    });
    if (bad.length) fail(`src/vendor/transformers: ${bad.map(([f]) => f).join(', ')} no coincide con VERSIONS.json (ejecuta npm run vendor)`);
    else ok(`${name}@${info.version} (${info.license}) íntegro`);
  }
  for (const lic of ['LICENSE-transformers-Apache-2.0.txt', 'LICENSE-onnxruntime-MIT.txt']) {
    if (!existsSync(join(ROOT, 'src/vendor/transformers', lic))) fail(`Falta src/vendor/transformers/${lic}`);
  }
} else {
  fail('Falta src/vendor/transformers/VERSIONS.json (ejecuta npm run vendor)');
}

// --- resultado --------------------------------------------------------------
if (errors.length) {
  console.error(`\n✗ ${errors.length} problema(s):`);
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}
console.log('\n✓ Validación correcta');
