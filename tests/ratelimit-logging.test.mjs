import assert from 'node:assert/strict';
import test from 'node:test';

import { checkRateLimit } from '../src/ratelimit/custom-pg-rest.js';

async function captureConsole(fn) {
  const entries = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => entries.push(args.map(String).join(' '));
  }
  try {
    const value = await fn();
    return { entries, value };
  } finally {
    Object.assign(console, original);
  }
}

test('rate limit fail-open logs [RateLimit] sanitized failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    text: async () => 'rpc failed Authorization: Bearer leaked ip=198.51.100.42 url=https://db.example/rpc?token=secret',
  });

  try {
    const { entries, value } = await captureConsole(() => checkRateLimit('198.51.100.42', '/secret.bin', {
      postgrestUrl: 'https://postgrest.example/rest/v1',
      verifyHeader: 'Authorization',
      verifySecret: 'Bearer super-secret',
      limit: 10,
      windowTimeSeconds: 60,
      pgErrorHandle: 'fail-open',
    }));

    assert.deepEqual(value, { allowed: true, ipAllowed: true, fileAllowed: true });
    const output = entries.join('\n');
    assert.match(output, /\[RateLimit\] check_failed_fail_open/);
    assert.doesNotMatch(output, /Bearer leaked|super-secret|198\.51\.100\.42|token=secret/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
