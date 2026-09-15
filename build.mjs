// Bundles the JSX UI into .cache/ui.mjs so you can edit .jsx files directly
// with no manual build step. Runs automatically on launch, and only when a
// source file is newer than the bundle (~20ms when it does run).
//
// Installed from npm there is nothing to rebuild: the bundle is built at publish
// time and shipped, esbuild is not installed, and the install directory may not
// even be writable. So esbuild is imported lazily and a failed rebuild falls
// back to the shipped bundle — see buildUI below.
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
  const hasBundle = fs.existsSync(OUT);
  const sourceMtime = newestMtime(path.join(ROOT, 'src'));
  const bundleMtime = hasBundle ? fs.statSync(OUT).mtimeMs : 0;
  if (!force && bundleMtime > sourceMtime) return OUT;

  try {
    const { build } = await import('esbuild');
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
  } catch (error) {
    // npm sets its own mtimes on extraction, so an installed copy can decide the
    // bundle is stale and land here with nothing wrong. The shipped bundle is
    // built from this same source, so it is the right answer — use it. Only a
    // run with no bundle at all is genuinely broken.
    if (!hasBundle || force) throw error;
  }
  return OUT;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildUI({ force: process.argv.includes('--force') });
  console.log('built', path.relative(ROOT, OUT));
}
