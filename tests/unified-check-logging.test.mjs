import assert from 'node:assert/strict';
import test from 'node:test';

import { unifiedCheck } from '../src/unified-check.js';

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

function baseConfig() {
  return {
    postgrestUrl: 'https://postgrest.example/rest/v1?apikey=secret',
    verifyHeader: 'Authorization',
    verifySecret: 'Bearer super-secret',
    sizeTTL: 60,
    windowTimeSeconds: 60,
    limit: 10,
    tokenHash: 'turnstile-token-secret',
    tokenIP: '203.0.113.44',
    altchaTokenHash: 'altcha-token-secret',
    altchaTokenIP: '203.0.113.45',
    powdetChallenges: [{ alg: 'argon2id', hash: 'pow-token-secret', expireAt: 1893456000 }],
  };
}

function successRow() {
  return {
    cache_size: '123',
    cache_timestamp: String(Math.floor(Date.now() / 1000)),
    rate_access_count: '1',
    rate_last_window_time: String(Math.floor(Date.now() / 1000)),
    rate_block_until: null,
    file_access_count: null,
    file_last_window_time: null,
    file_block_until: null,
    token_allowed: true,
    token_error_code: 0,
    token_access_count: 1,
    token_client_ip: '203.0.113.44',
    token_filepath: '/private/file.bin?download=1',
    token_expires_at: '1893456000',
    altcha_allowed: true,
    altcha_error_code: 0,
    altcha_access_count: 1,
    altcha_expires_at: '1893456000',
    pow_results: { argon2id: { allowed: true, status: 'ok', token: 'pow-token-secret' } },
  };
}

test('unified check emits [UnifiedCheck] start, rpc_error, and result events with sanitized fields', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async () => {
    calls.push(null);
    if (calls.length === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => [successRow()],
      };
    }
    return {
      ok: false,
      status: 503,
      text: async () => 'rpc failed Authorization: Bearer leaked ip=203.0.113.9 url=https://db.example/rpc?token=secret',
    };
  };

  try {
    const { entries, value } = await captureConsole(async () => {
      const success = await unifiedCheck('/private/file.bin?download=1', '203.0.113.44', 'ALTCHA_TOKEN_LIST', baseConfig());
      await assert.rejects(
        unifiedCheck('/private/file.bin?download=1', '203.0.113.44', 'ALTCHA_TOKEN_LIST', baseConfig()),
        /landing_unified_check failed \(503\)/,
      );
      return success;
    });

    assert.equal(value.cache.size, 123);
    assert.equal(value.rateLimit.allowed, true);
    const output = entries.join('\n');
    assert.match(output, /\[UnifiedCheck\] start/);
    assert.match(output, /\[UnifiedCheck\] rpc_error/);
    assert.match(output, /\[UnifiedCheck\] complete/);
    assert.match(output, /status=200/);
    assert.match(output, /status=503/);
    assert.match(output, /result=allowed/);
    assert.match(output, /algorithm=argon2id/);
    assert.doesNotMatch(output, /Bearer leaked|super-secret|turnstile-token-secret|altcha-token-secret|pow-token-secret|203\.0\.113\.|token=secret|download=1/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
