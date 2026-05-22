import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('..', import.meta.url);
const allowedConsoleOwners = new Set([
  'src/logging.js',
  'src/assets/landing/landing-logging.js',
]);

const pendingMigrationFiles = new Set([]);

const supportRuntimeFiles = [
  'src/internal-api.js',
  'src/controller-adapter.js',
  'src/origin-binding.js',
];

function toRepoPath(filePath) {
  return relative(repoRoot.pathname, filePath).split(sep).join('/');
}

function collectJsFiles(directoryUrl) {
  const directoryPath = directoryUrl.pathname;
  return readdirSync(directoryPath)
    .flatMap((entry) => {
      const filePath = join(directoryPath, entry);
      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        return collectJsFiles(new URL(`${entry}/`, directoryUrl));
      }
      return stats.isFile() && filePath.endsWith('.js') ? [filePath] : [];
    })
    .sort();
}

function directConsoleMatches(filePath) {
  const absolutePath = new URL(`../${filePath}`, import.meta.url).pathname;
  const source = readFileSync(absolutePath, 'utf8');
  return source
    .split('\n')
    .flatMap((line, index) => (/\bconsole\.(log|warn|error)\s*\(/.test(line)
      ? [`${filePath}:${index + 1}: ${line.trim()}`]
      : []));
}

test('runtime src files do not call console directly outside logger-owned modules', () => {
  const offenders = collectJsFiles(new URL('../src/', import.meta.url))
    .map(toRepoPath)
    .filter((filePath) => !allowedConsoleOwners.has(filePath))
    .filter((filePath) => !pendingMigrationFiles.has(filePath))
    .flatMap((filePath) => directConsoleMatches(filePath));
  assert.deepEqual(offenders, []);
});

test('pending direct-console migration list is explicit', () => {
  const currentOwners = collectJsFiles(new URL('../src/', import.meta.url))
    .map(toRepoPath)
    .filter((filePath) => !allowedConsoleOwners.has(filePath))
    .filter((filePath) => directConsoleMatches(filePath).length > 0)
    .sort();
  assert.deepEqual(currentOwners, [...pendingMigrationFiles].sort());
});

test('support runtime modules route logs through shared logging helpers', () => {
  const offenders = supportRuntimeFiles.flatMap((filePath) => directConsoleMatches(filePath));
  assert.deepEqual(offenders, []);
});

test('landing browser code delegates direct console calls to landing logger module', () => {
  assert.deepEqual(directConsoleMatches('src/assets/landing/landing-glue.js'), []);
  assert.ok(directConsoleMatches('src/assets/landing/landing-logging.js').length > 0);
});

test('landing glue imports landing logger as sibling module', () => {
  const source = readFileSync(new URL('../src/assets/landing/landing-glue.js', import.meta.url), 'utf8');
  assert.match(source, /from ['"]\.\/landing-logging\.js['"]/);
});
