import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import worker from '../src/worker.js';

async function captureConsole(run) {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const entries = [];
  for (const method of Object.keys(original)) {
    console[method] = (...args) => entries.push(args.map(String).join(' '));
  }
  try {
    const result = await run();
    return { entries, result };
  } finally {
    Object.assign(console, original);
  }
}

function makeCtx() {
  const promises = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(Promise.resolve(promise).catch(() => undefined));
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    CONTROLLER_URL: 'https://controller.example',
    CONTROLLER_API_TOKEN: 'controller-token-secret',
    ENV: 'prod',
    ROLE: 'landing',
    INSTANCE_ID: 'worker-1',
    BOOTSTRAP_CACHE_MODE: 'direct',
    ...overrides,
  };
}

function makeBootstrap(origin = 'https://landing.example') {
  return {
    configVersion: 'cfg-obs-1',
    common: {
      tokenHmacKey: 'worker-token-secret',
      signSecret: 'worker-sign-secret',
      alistBaseUrl: 'https://alist.example',
      workerAddresses: ['https://download.example'],
      landingWorkerAddresses: [origin],
    },
    landing: {
      pageSecret: 'landing-page-secret',
      frontend: {
        glueUrl: '/assets/landing/landing-glue.js',
        htmlUrl: '/assets/landing/landing.html',
        commonCssUrl: '/assets/landing/common.css',
        themeCssUrl: '/assets/landing/theme.css',
      },
      altcha: { enabled: false },
      turnstile: { enabled: false },
      powdet: { enabled: false },
      db: { mode: '' },
    },
    global: { defaultProfileId: 'default' },
    pathProfiles: [
      {
        id: 'default',
        actions: { captchaCombo: ['pass-web'], fastRedirect: false, autoRedirect: false },
      },
    ],
    download: {
      paths: {
        global: { defaultProfileId: 'default' },
        pathProfiles: [
          { id: 'default', actions: { pathAction: [], checkOriginMode: 'path' } },
        ],
      },
    },
  };
}

function makeDbBootstrap(origin = 'https://landing.example') {
  const bootstrap = makeBootstrap(origin);
  bootstrap.landing.db = {
    mode: 'custom-pg-rest',
    postgrestUrl: 'https://postgrest.example/rest/v1?apikey=secret',
    verifyHeader: ['Authorization'],
    verifySecret: ['Bearer verify-secret'],
    cleanupPercentage: 100,
    rateLimit: { enabled: false, limit: 0 },
    cache: {
      cleanupPercentage: 100,
      sizeTTLSeconds: 60,
      tableName: 'FILESIZE_CACHE_TABLE',
    },
  };
  return bootstrap;
}

async function signPath(secret, path, expire) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'HMAC', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${path}:${expire}`),
  );
  const encoded = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_');
  return `${encoded}:${expire}`;
}

test('worker emits terminal response logs for representative non-success paths', async () => {
  const request = new Request('https://landing.example/private.bin?token=secret&payload=raw&signature=sig', {
    headers: {
      'CF-Connecting-IP': '203.0.113.9',
      Authorization: 'Bearer leaked',
      'X-Inner-Auth': 'wrong-secret',
    },
  });
  const env = makeEnv({ INNER_AUTH_SECRET: 'inner-secret' });
  const ctx = makeCtx();

  const { entries, result } = await captureConsole(() => worker.fetch(request, env, ctx));

  assert.equal(result.status, 403);
  const output = entries.join('\n');
  assert.match(output, /\[Terminal\] response status=403 reason=forbidden phase=auth/);
  assert.doesNotMatch(output, /secret|Bearer leaked|203\.0\.113\.9|payload=raw|signature=sig|private\.bin\?token/i);
});

test('worker emits orchestration logs for representative success path', async () => {
  const originalFetch = globalThis.fetch;
  const origin = 'https://landing.example';
  const bootstrap = makeBootstrap(origin);
  globalThis.fetch = async (url) => {
    const href = typeof url === 'string' ? url : url.url;
    if (href === 'https://controller.example/api/v0/bootstrap') {
      return Response.json(bootstrap);
    }
    throw new Error(`unexpected fetch ${href}?token=secret`);
  };

  try {
    const path = '/file.txt';
    const expire = Math.floor(Date.now() / 1000) + 300;
    const sign = await signPath('worker-sign-secret', path, expire);
    const request = new Request(`${origin}${path}?sign=${encodeURIComponent(sign)}&token=secret`, {
      headers: { 'CF-Connecting-IP': '2001:db8::1' },
    });
    const ctx = makeCtx();

    const { entries, result } = await captureConsole(() => worker.fetch(request, makeEnv(), ctx));

    if (result.status !== 200) {
      assert.fail(`expected 200, got ${result.status}: ${await result.text()}\n${entries.join('\n')}`);
    }
    const output = entries.join('\n');
    assert.match(output, /\[Worker\] request_start/);
    assert.match(output, /\[Worker\] bootstrap_loaded .*configVersion=cfg-obs-1/);
    assert.match(output, /\[Controller\] state_loaded .*configVersion=cfg-obs-1/);
    assert.match(output, /\[Worker\] controller_decision/);
    assert.match(output, /\[Worker\] request_complete .*status=200/);
    assert.match(output, /\[Terminal\] response status=200 reason=ok phase=complete/);
    assert.doesNotMatch(output, /worker-sign-secret|controller-token-secret|token=secret|2001:db8|sign=/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker observability tests enforce all required TG4 event contracts', () => {
  const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const requiredEvents = {
    Terminal: ['response'],
    Worker: ['request_start', 'bootstrap_loaded', 'controller_decision', 'request_complete'],
    Binding: ['nonce_failed', 'mac_failed', 'cdata_failed', 'decode_failed', 'token_rejected'],
    ALTCHA: ['challenge_created', 'token_rejected', 'dynamic_fetch_failed', 'dynamic_update_failed', 'cleanup_failed'],
    Powdet: ['challenge_created', 'solution_rejected', 'dynamic_fetch_failed', 'dynamic_update_failed', 'cleanup_failed'],
    CleanupScheduler: ['scheduled', 'task_failed', 'task_done'],
    Cache: ['cleanup_triggered', 'cleanup_done', 'cleanup_failed'],
  };

  for (const [component, events] of Object.entries(requiredEvents)) {
    for (const event of events) {
      const directComponentEvent = new RegExp(`['"]${component}['"][^\n]*['"]${event}['"]|['"]${event}['"][^\n]*['"]${component}['"]`);
      const workerHelperEvent = component === 'Worker' && new RegExp(`logWorkerEvent\\([^\\n]*['"]${event}['"]`);
      assert.match(
        source,
        workerHelperEvent || directComponentEvent,
        `${component}.${event} must be logged from worker orchestration`,
      );
    }
  }
});

test('worker cleanup path emits scheduler and cache cleanup success events without leaking fields', async () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  const origin = 'https://landing.example';
  const bootstrap = makeDbBootstrap(origin);
  globalThis.bootstrapCache = null;
  Math.random = () => 0;
  globalThis.fetch = async (url) => {
    const href = typeof url === 'string' ? url : url.url;
    if (href === 'https://controller.example/api/v0/bootstrap') {
      return Response.json(bootstrap);
    }
    if (href.includes('/rpc/landing_cleanup_expired_cache')) {
      return Response.json(0);
    }
    if (href.startsWith('https://postgrest.example/rest/v1/rpc/')) {
      return Response.json(0);
    }
    throw new Error(`unexpected fetch ${href}?token=secret`);
  };

  try {
    const request = new Request(`${origin}/file.txt`, {
      method: 'HEAD',
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
    });
    const ctx = makeCtx();

    const { entries, result } = await captureConsole(async () => {
      const response = await worker.fetch(request, makeEnv(), ctx);
      await Promise.all(ctx.promises);
      return response;
    });

    assert.equal(result.status, 200);
    const output = entries.join('\n');
    assert.match(output, /\[CleanupScheduler\] scheduled .*count=7/);
    assert.match(output, /\[CleanupScheduler\] task_done .*reason=Filesize Cache/);
    assert.match(output, /\[Cache\] cleanup_triggered .*table=FILESIZE_CACHE_TABLE .*ttlSeconds=60/);
    assert.match(output, /\[Cache\] cleanup_done .*status=200 .*table=FILESIZE_CACHE_TABLE .*ttlSeconds=60/);
    assert.doesNotMatch(output, /apikey=secret|verify-secret|203\.0\.113\.9|token=secret/i);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
    globalThis.bootstrapCache = null;
  }
});

test('worker cleanup path emits cache cleanup_failed when the actual cache cleanup RPC fails', async () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  const origin = 'https://landing.example';
  const bootstrap = makeDbBootstrap(origin);
  globalThis.bootstrapCache = null;
  Math.random = () => 0;
  globalThis.fetch = async (url) => {
    const href = typeof url === 'string' ? url : url.url;
    if (href === 'https://controller.example/api/v0/bootstrap') {
      return Response.json(bootstrap);
    }
    if (href.includes('/rpc/landing_cleanup_expired_cache')) {
      return new Response('failed url=https://files.example/a?signature=secret token=secret ip=203.0.113.9', { status: 503 });
    }
    if (href.startsWith('https://postgrest.example/rest/v1/rpc/')) {
      return Response.json(0);
    }
    throw new Error(`unexpected fetch ${href}?token=secret`);
  };

  try {
    const request = new Request(`${origin}/file.txt`, { method: 'HEAD' });
    const ctx = makeCtx();

    const { entries, result } = await captureConsole(async () => {
      const response = await worker.fetch(request, makeEnv(), ctx);
      await Promise.all(ctx.promises);
      return response;
    });

    assert.equal(result.status, 200);
    const output = entries.join('\n');
    assert.match(output, /\[Cache\] cleanup_triggered .*table=FILESIZE_CACHE_TABLE/);
    assert.match(output, /\[Cache\] cleanup_failed .*status=503/);
    assert.doesNotMatch(output, /signature=secret|token=secret|203\.0\.113\.9|apikey=secret|verify-secret/i);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
    globalThis.bootstrapCache = null;
  }
});
