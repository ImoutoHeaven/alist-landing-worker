import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outdir = resolve(__dirname, 'dist');
const assetsDir = resolve(outdir, 'assets');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [resolve(__dirname, 'src', 'worker.js')],
  outfile: resolve(outdir, '_worker.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  sourcemap: true,
  minify: true,
});

await mkdir(assetsDir, { recursive: true });

await build({
  entryPoints: [resolve(__dirname, 'src', 'assets', 'landing', 'landing-glue.js')],
  outfile: resolve(assetsDir, 'landing-glue.js'),
  bundle: false,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
});

const assetFiles = ['landing.common.css', 'landing.minimal.css'];
for (const file of assetFiles) {
  await copyFile(
    resolve(__dirname, 'src', 'assets', 'landing', file),
    resolve(assetsDir, file)
  );
}

console.log('✓ Build completed: dist/_worker.js + dist/assets');
