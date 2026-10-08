#!/usr/bin/env node
/**
 * Build de producción: genera dist/ con SOLO lo necesario para ejecutar la extensión.
 *
 *   npm run build
 *
 * 1. Limpia dist/.
 * 2. Copia una lista explícita (allowlist): manifest, iconos, src/ (incluido src/vendor)
 *    y avisos de licencias. Nada de tests, research, scripts, node_modules ni temporales.
 * 3. Comprueba que todo archivo referenciado (manifest, HTML, imports estáticos y
 *    dinámicos) existe en dist/ y que no hay archivos prohibidos.
 * 4. Ejecuta el validador sobre dist/ (manifest, CSP, permisos, integridad de vendors).
 *
 * No hay bundler ni minificación: el código se distribuye tal cual (revisable por la
 * Chrome Web Store), y los vendors ya vienen minificados por sus autores.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** Lo único que entra en el paquete. */
const INCLUDE = ['manifest.json', 'icons', 'src', 'THIRD_PARTY_NOTICES.md'];
/** Extensiones permitidas dentro del paquete. */
const ALLOWED_EXT = new Set(['.json', '.png', '.html', '.css', '.js', '.mjs', '.md', '.txt', '.wasm']);
/** Rutas que jamás deben aparecer. */
const FORBIDDEN = [/node_modules/, /(^|\/)research(\/|$)/, /(^|\/)tests?(\/|$)/, /\.(webm|mp4|log|map|crswap|tmp)$/i, /(^|\/)\./];
/** Páginas que se abren por código (no están en el manifest). */
const RUNTIME_PAGES = ['src/offscreen/offscreen.html', 'src/controller/controller.html', 'src/permission/permission.html', 'src/library/library.html'];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// --- 1-2. limpiar y copiar --------------------------------------------------------
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST);
for (const entry of INCLUDE) {
  const from = join(ROOT, entry);
  if (!existsSync(from)) fail(`falta ${entry}`);
  cpSync(from, join(DIST, entry), {
    recursive: true,
    filter: (src) => !FORBIDDEN.some((re) => re.test(relative(ROOT, src))),
  });
}
const files = walk(DIST).map((f) => relative(DIST, f));

// --- 3a. archivos prohibidos o con extensión inesperada -----------------------------
for (const f of files) {
  if (FORBIDDEN.some((re) => re.test(f))) fail(`archivo prohibido en dist/: ${f}`);
  if (!ALLOWED_EXT.has(extname(f))) fail(`extensión no permitida en dist/: ${f}`);
}

// --- 3b. todo lo referenciado existe --------------------------------------------------
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const required = new Set([
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...RUNTIME_PAGES,
]);
const queue = [...required];
const reached = new Set();
while (queue.length) {
  const file = queue.pop();
  if (reached.has(file)) continue;
  reached.add(file);
  const full = join(DIST, file);
  if (!existsSync(full)) fail(`referenciado pero ausente en dist/: ${file}`);
  const text = ['.html', '.js', '.mjs', '.css'].includes(extname(file)) ? readFileSync(full, 'utf8') : '';
  const refs = [];
  if (file.endsWith('.html')) for (const [, r] of text.matchAll(/(?:src|href)="([^"#:][^"]*)"/g)) refs.push(r);
  // Los vendors minificados se tratan como hojas: sus cadenas internas no son rutas nuestras.
  if (file.endsWith('.js') && !file.startsWith('src/vendor/')) {
    for (const [, r] of text.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) refs.push(r);
    for (const [, r] of text.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) refs.push(r);
    // Imports dinámicos con la ruta en una constante (p. ej. const MEDIABUNNY = '../vendor/...').
    for (const [, r] of text.matchAll(/=\s*['"](\.\.?\/[^'"]+\.m?js)['"]/g)) refs.push(r);
    // Workers y recursos resueltos en tiempo de ejecución: new URL('./x', import.meta.url).
    for (const [, r] of text.matchAll(/new URL\(\s*['"](\.\.?\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) refs.push(r);
  }
  if (file.endsWith('.mjs')) for (const [, r] of text.matchAll(/from\s*"(\.\/[^"]+)"/g)) refs.push(r);
  for (const r of refs) queue.push(relative(DIST, resolve(dirname(full), r)));
}
const vendorFiles = files.filter((f) => f.startsWith('src/vendor/') && /\.(m?js|wasm)$/.test(f));
for (const v of vendorFiles) if (!reached.has(v)) fail(`vendor no referenciado (sobra en el paquete): ${v}`);
const unreferenced = files.filter((f) => !reached.has(f) && /\.(js|mjs|html|css)$/.test(f));
if (unreferenced.length) fail(`código no referenciado en dist/: ${unreferenced.join(', ')}`);

// --- 4. validador sobre dist/ ------------------------------------------------------
execFileSync(process.execPath, [join(ROOT, 'scripts/validate.mjs'), '--root', DIST], { stdio: 'inherit' });

const kb = (f) => statSync(join(DIST, f)).size / 1024;
const total = files.reduce((n, f) => n + kb(f), 0);
const vendor = files.filter((f) => f.startsWith('src/vendor/')).reduce((n, f) => n + kb(f), 0);
console.log(`\n✓ dist/ listo: ${files.length} archivos · ${(total / 1024).toFixed(2)} MB (vendors ${(vendor / 1024).toFixed(2)} MB)`);
console.log(`  ${reached.size} archivos alcanzables desde el manifest; sin archivos prohibidos ni código huérfano.`);
