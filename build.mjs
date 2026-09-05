// Bundles the JSX UI into .cache/ui.mjs so you can edit .jsx files directly
// with no manual build step. Runs automatically on launch, and only when a
// source file is newer than the bundle (~20ms when it does run).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(ROOT, 'src', 'ui', 'index.jsx');
const OUT = path.join(ROOT, '.cache', 'ui.mjs');

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

export async function buildUI({ force = false } = {}) {
  const sourceMtime = newestMtime(path.join(ROOT, 'src'));
  const bundleMtime = fs.existsSync(OUT) ? fs.statSync(OUT).mtimeMs : 0;
  if (!force && bundleMtime > sourceMtime) return OUT;

  await build({
    entryPoints: [ENTRY],
    outfile: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    jsx: 'automatic',
    // Keep node_modules out of the bundle; only our own source is compiled.
    packages: 'external',
    logLevel: 'error',
  });
  return OUT;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildUI({ force: process.argv.includes('--force') });
  console.log('built', path.relative(ROOT, OUT));
}
