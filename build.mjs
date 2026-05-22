import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outdir = resolve(__dirname, 'dist');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [resolve(__dirname, 'src', 'worker.js')],
  outfile: resolve(outdir, 'worker.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  sourcemap: true,
  minify: true,
});
const landingAssetsDir = resolve(outdir, 'assets', 'landing');
await mkdir(landingAssetsDir, { recursive: true });
await Promise.all([
  copyFile(
    resolve(__dirname, 'src', 'assets', 'landing', 'landing-glue.js'),
    resolve(landingAssetsDir, 'landing-glue.js'),
  ),
  copyFile(
    resolve(__dirname, 'src', 'assets', 'landing', 'landing-logging.js'),
    resolve(landingAssetsDir, 'landing-logging.js'),
  ),
]);
console.log('✓ Build completed: dist/worker.js');
