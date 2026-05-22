import assert from 'node:assert/strict';
import test from 'node:test';

import { checkCache } from '../src/cache/custom-pg-rest.js';

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
    await fn();
    return entries;
  } finally {
    Object.assign(console, original);
  }
}

function response({ ok = false, status = 500, body = '', contentType = 'text/plain' } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

test('cache failure logs [Cache] event without leaking URLs or tokens', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({
    status: 503,
    body: 'upstream failed url=https://files.example/download?signature=abc&token=secret Authorization: Bearer leaked ip=203.0.113.9',
  });

  try {
    const entries = await captureConsole(async () => {
      const result = await checkCache('/private/file.bin?download=1', {
        postgrestUrl: 'https://postgrest.example/rest/v1?apikey=secret',
        verifyHeader: 'Authorization',
        verifySecret: 'Bearer super-secret',
        sizeTTL: 60,
      });
      assert.equal(result, null);
    });

    const output = entries.join('\n');
    assert.match(output, /\[Cache\] check_failed/);
    assert.doesNotMatch(output, /signature=abc|token=secret|Bearer leaked|super-secret|203\.0\.113\.9|download=1/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
