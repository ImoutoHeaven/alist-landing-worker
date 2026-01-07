import { build } from "esbuild";
import { mkdir, rm, stat } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const entry = resolve(__dirname, "sign.js");
const outdir = resolve(__dirname, "dist");
const outfile = resolve(outdir, "sign_snippet.js");

await mkdir(outdir, { recursive: true });
await rm(outfile, { force: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  minify: true,
  legalComments: "none",
  charset: "ascii",
});

const { size } = await stat(outfile);
const limit = 32 * 1024;
const status = size <= limit ? "OK" : "OVER";
console.log(`Built snippet: ${outfile} (${size} bytes, ${status} ${limit} bytes)`);
if (size > limit) process.exitCode = 1;

