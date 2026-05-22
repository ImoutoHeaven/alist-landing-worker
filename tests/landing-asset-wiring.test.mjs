import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { landingLogEvent } from '../src/assets/landing/landing-logging.js';

async function captureConsole(fn) {
  const entries = [];
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args) => entries.push(args.join(' '));
  console.warn = (...args) => entries.push(args.join(' '));
  console.error = (...args) => entries.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  return entries;
}

test('landing logging asset exists beside landing glue asset', () => {
  assert.ok(statSync(new URL('../src/assets/landing/landing-glue.js', import.meta.url)).isFile());
  assert.ok(statSync(new URL('../src/assets/landing/landing-logging.js', import.meta.url)).isFile());
});

test('landing logging asset is emitted beside landing glue asset after build', () => {
  assert.ok(statSync(new URL('../dist/assets/landing/landing-glue.js', import.meta.url)).isFile());
  assert.ok(statSync(new URL('../dist/assets/landing/landing-logging.js', import.meta.url)).isFile());
});

test('landing template loads glue as module so sibling imports execute in browser', () => {
  const template = readFileSync(new URL('../src/templates/landing.html.js', import.meta.url), 'utf8');
  assert.match(template, /<script type="module" src="\{\{GLUE_URL\}\}"><\/script>/);
});

test('landing logger preserves sanitized error and reason messages', async () => {
  const entries = await captureConsole(() => landingLogEvent('warn', 'opfs_cleanup_failed', {
    error: new Error('failed url=https://x.test/a?token=secret ip=203.0.113.9'),
    reason: 'cleanup failed Authorization: Bearer leaked',
  }));
  const output = entries.join('\n');

  assert.match(output, /^\[Landing\] opfs_cleanup_failed /);
  assert.match(output, /error=.*failed/);
  assert.match(output, /reason=.*cleanup failed/);
  assert.doesNotMatch(output, /https:\/\/x\.test\/a\?token=secret|203\.0\.113\.9|Bearer leaked/i);
  assert.match(output, /\[redacted\]/);
});
