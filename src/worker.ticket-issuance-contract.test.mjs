import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from './worker.js';
import { sha256Hash } from './utils.js';

const createJsonResponse = (payload, init = {}) => new Response(JSON.stringify(payload), {
  status: init.status ?? 200,
  headers: {
    'content-type': 'application/json',
    ...(init.headers || {}),
  },
});

const encodeSignatureBase64Url = (input) => Buffer.from(input)
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');

const signPath = async (path, expire, token) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${path}:${expire}`),
  );
  return `${encodeSignatureBase64Url(Buffer.from(signature))}:${expire}`;
};

const buildBootstrap = ({
  dbMode = 'custom-pg-rest',
  ticketStateTable = 'DOWNLOAD_TICKET_STATE_TABLE',
  idleTimeoutSeconds = 600,
} = {}) => ({
  configVersion: 'task-group-1-ticket-contract',
  ttlSeconds: 300,
  global: {
    defaultProfileId: 'default',
  },
  pathProfiles: [{
    id: 'default',
    dynamic: false,
    actions: {
      captchaCombo: ['pass-asis'],
    },
  }],
  pathRules: [],
  common: {
    tokenHmacKey: 'bootstrap-token',
    alistBaseUrl: 'https://alist.example.test',
    workerAddresses: ['https://download.example.test'],
    landingWorkerAddresses: ['https://landing.example.com'],
    binding: {
      defaultModes: '',
      version: 1,
      ipv4Suffix: '/32',
      ipv6Suffix: '/60',
      bindTls: false,
    },
  },
  landing: {
    pageSecret: 'page-secret',
    frontend: {
      glueUrl: 'https://landing.example.com/assets/glue.js',
      htmlUrl: 'https://landing.example.com/assets/index.html',
      commonCssUrl: 'https://landing.example.com/assets/common.css',
      themeCssUrl: 'https://landing.example.com/assets/theme.css',
    },
    captcha: {
      defaultCombo: ['pass-asis'],
    },
    altcha: {
      enabled: false,
    },
    turnstile: {
      enabled: false,
    },
    powdet: {
      enabled: false,
      algorithms: {},
    },
    db: {
      mode: dbMode,
      postgrestUrl: 'https://postgrest.example.test',
      verifyHeader: ['X-Verify'],
      verifySecret: ['secret'],
      cleanupPercentage: 0,
      cache: {
        tableName: 'FILESIZE_CACHE_TABLE',
        sizeTTLSeconds: 86400,
        cleanupPercentage: 0,
      },
      rateLimit: {
        enabled: false,
        windowSeconds: 60,
        limit: 0,
        ipv4Suffix: '/32',
        ipv6Suffix: '/60',
        blockSeconds: 600,
        pgErrorHandle: 'fail-closed',
        fileWindowSeconds: 60,
        fileLimit: 0,
        fileBlockSeconds: 240,
        tableName: 'IP_LIMIT_TABLE',
        fileTableName: 'IP_FILE_LIMIT_TABLE',
        cleanupPercentage: 0,
      },
      ...(ticketStateTable === undefined ? {} : { ticketStateTable }),
      idleTimeoutSeconds,
    },
    crypt: {
      prefix: '',
      includes: [],
      encryptionMode: 'crypt',
      fileHeaderSize: 32,
      blockHeaderSize: 16,
      blockDataSize: 65536,
      dataKey: '',
    },
    webDownloader: {
      enabled: false,
      maxConnections: 4,
    },
    clientDecryptEnabled: false,
    payload: {
      minBandwidthMbps: 10,
      minDurationSeconds: 3600,
      maxDurationSeconds: 0,
    },
    fastRedirect: false,
    autoRedirect: false,
    ipv4Only: false,
  },
  download: {
    originBindingDefault: '',
    paths: {
      global: {
        defaultProfileId: 'default',
      },
      pathProfiles: [{
        id: 'default',
        dynamic: false,
        actions: {
          checkOriginMode: '',
        },
      }],
      pathRules: [],
    },
  },
});

const buildEnv = () => ({
  CONTROLLER_URL: 'https://controller.example.test',
  CONTROLLER_API_TOKEN: 'controller-token',
  ENV: 'test',
  ROLE: 'landing',
  INSTANCE_ID: 'landing-1',
  BOOTSTRAP_CACHE_MODE: 'direct',
});

const buildInfoRequest = async ({
  path = '/downloads/task-group-1.bin',
  expireOffsetSeconds = 1800,
} = {}) => {
  const expire = Math.floor(Date.now() / 1000) + expireOffsetSeconds;
  const sign = await signPath(path, expire, 'bootstrap-token');
  const url = new URL('https://landing.example.com/info');
  url.searchParams.set('path', path);
  url.searchParams.set('sign', sign);
  return new Request(url, {
    headers: {
      origin: 'https://landing.example.com',
      'CF-Connecting-IP': '192.0.2.10',
    },
  });
};

const readJson = async (response) => JSON.parse(await response.text());

const waitFor = async (predicate, { timeoutMs = 250, intervalMs = 5 } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
};

test('issues ticket URL only after synchronous ticket seed completes', async (t) => {
  delete globalThis.bootstrapCache;

  const bootstrap = buildBootstrap();
  const originalFetch = globalThis.fetch;
  let seedCall = null;
  let releaseSeed = null;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://controller.example.test/api/v0/bootstrap') {
      return createJsonResponse(bootstrap);
    }
    if (url === 'https://alist.example.test/api/fs/get') {
      return createJsonResponse({
        code: 200,
        data: { size: 1024 },
      });
    }
    if (url.startsWith('https://postgrest.example.test/FILESIZE_CACHE_TABLE?')) {
      return createJsonResponse([]);
    }
    if (url === 'https://postgrest.example.test/rpc/landing_upsert_filesize_cache') {
      return createJsonResponse([{ ok: true }]);
    }
    if (url === 'https://postgrest.example.test/rpc/download_seed_ticket') {
      seedCall = {
        method: init.method,
        headers: init.headers,
        body: JSON.parse(init.body),
      };
      return await new Promise((resolve) => {
        releaseSeed = () => resolve(createJsonResponse({ result: 'seeded' }));
      });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.bootstrapCache;
  });

  const request = await buildInfoRequest();
  const responsePromise = worker.fetch(request, buildEnv(), {
    waitUntil() {},
  });
  let responseSettled = false;
  responsePromise.finally(() => {
    responseSettled = true;
  });

  const observedSeedStart = await waitFor(() => seedCall !== null || responseSettled, { timeoutMs: 250, intervalMs: 5 });

  assert.equal(observedSeedStart, true, 'expected to observe either seed start or response completion');
  assert.ok(seedCall, 'expected landing to call download_seed_ticket before responding');
  assert.equal(responseSettled, false, 'expected response to wait for seed completion');

  releaseSeed();
  const response = await responsePromise;
  assert.equal(response.status, 200);

  const body = await readJson(response);
  const downloadURL = new URL(body?.data?.download?.url);
  const payload = downloadURL.searchParams.get('payload');
  const payloadSign = downloadURL.searchParams.get('payloadSign');
  assert.ok(payload, 'expected payload query param');
  assert.ok(payloadSign, 'expected payloadSign query param');

  const payloadData = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(typeof payloadData.ticketNonce, 'string');
  assert.match(payloadData.ticketNonce, /^[A-Za-z0-9_-]{22,}$/);
  assert.equal(payloadData.idle_timeout, 600);

  const payloadSignExpire = Number.parseInt(payloadSign.split(':').at(-1), 10);
  const expectedTicketHash = await sha256Hash(`${payload}:${payloadSign}`);

  assert.equal(seedCall.method, 'POST');
  assert.equal(seedCall.body.p_table_name, 'DOWNLOAD_TICKET_STATE_TABLE');
  assert.equal(seedCall.body.p_ticket_hash, expectedTicketHash);
  assert.equal(seedCall.body.p_hard_expire_at, Math.min(payloadData.expireTime, payloadSignExpire));
  assert.equal(seedCall.body.p_idle_timeout_seconds, 600);
  assert.equal(Number.isInteger(seedCall.body.p_issued_at), true);
  assert.equal(seedCall.body.p_issued_at > 0, true);
  assert.match(seedCall.body.p_ip_hash, /^[a-f0-9]{64}$/);
  assert.match(seedCall.body.p_path_hash, /^[a-f0-9]{64}$/);
});

test('enabled mode still signs idle_timeout: 0 when landing idleTimeoutSeconds is zero', async (t) => {
  delete globalThis.bootstrapCache;

  const bootstrap = buildBootstrap({ idleTimeoutSeconds: 0 });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://controller.example.test/api/v0/bootstrap') {
      return createJsonResponse(bootstrap);
    }
    if (url === 'https://alist.example.test/api/fs/get') {
      return createJsonResponse({
        code: 200,
        data: { size: 2048 },
      });
    }
    if (url.startsWith('https://postgrest.example.test/FILESIZE_CACHE_TABLE?')) {
      return createJsonResponse([]);
    }
    if (url === 'https://postgrest.example.test/rpc/landing_upsert_filesize_cache') {
      return createJsonResponse([{ ok: true }]);
    }
    if (url === 'https://postgrest.example.test/rpc/download_seed_ticket') {
      return createJsonResponse({ result: 'seeded' });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.bootstrapCache;
  });

  const response = await worker.fetch(await buildInfoRequest(), buildEnv(), { waitUntil() {} });
  assert.equal(response.status, 200);

  const body = await readJson(response);
  const downloadURL = new URL(body?.data?.download?.url);
  const payload = downloadURL.searchParams.get('payload');
  assert.ok(payload, 'expected payload query param');

  const payloadData = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(payloadData.idle_timeout, 0);
});

test('refuses to issue URL when ticket seed collides', async (t) => {
  delete globalThis.bootstrapCache;

  const bootstrap = buildBootstrap();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://controller.example.test/api/v0/bootstrap') {
      return createJsonResponse(bootstrap);
    }
    if (url === 'https://alist.example.test/api/fs/get') {
      return createJsonResponse({
        code: 200,
        data: { size: 2048 },
      });
    }
    if (url.startsWith('https://postgrest.example.test/FILESIZE_CACHE_TABLE?')) {
      return createJsonResponse([]);
    }
    if (url === 'https://postgrest.example.test/rpc/landing_upsert_filesize_cache') {
      return createJsonResponse([{ ok: true }]);
    }
    if (url === 'https://postgrest.example.test/rpc/download_seed_ticket') {
      return createJsonResponse({ result: 'collision' });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.bootstrapCache;
  });

  const response = await worker.fetch(await buildInfoRequest(), buildEnv(), { waitUntil() {} });
  assert.equal(response.status, 500);

  const body = await readJson(response);
  assert.match(body.message, /ticket seed rejected: collision/);
});

test('disabled mode issues a signed URL without ticketNonce and idle_timeout', async (t) => {
  delete globalThis.bootstrapCache;

  const bootstrap = buildBootstrap({
    dbMode: '',
  });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://controller.example.test/api/v0/bootstrap') {
      return createJsonResponse(bootstrap);
    }
    if (url === 'https://alist.example.test/api/fs/get') {
      return createJsonResponse({
        code: 200,
        data: { size: 4096 },
      });
    }
    if (url.startsWith('https://postgrest.example.test/FILESIZE_CACHE_TABLE?')) {
      return createJsonResponse([]);
    }
    if (url === 'https://postgrest.example.test/rpc/landing_upsert_filesize_cache') {
      return createJsonResponse([{ ok: true }]);
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.bootstrapCache;
  });

  const response = await worker.fetch(await buildInfoRequest(), buildEnv(), { waitUntil() {} });
  assert.equal(response.status, 200);

  const body = await readJson(response);
  const downloadURL = new URL(body?.data?.download?.url);
  const payload = downloadURL.searchParams.get('payload');
  assert.ok(payload, 'expected payload query param');

  const payloadData = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(Object.hasOwn(payloadData, 'ticketNonce'), false);
  assert.equal(Object.hasOwn(payloadData, 'idle_timeout'), false);
});

test('disabled mode does not call download_seed_ticket', async (t) => {
  delete globalThis.bootstrapCache;

  const bootstrap = buildBootstrap({ dbMode: '' });
  const originalFetch = globalThis.fetch;
  let seedCallCount = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://controller.example.test/api/v0/bootstrap') {
      return createJsonResponse(bootstrap);
    }
    if (url === 'https://alist.example.test/api/fs/get') {
      return createJsonResponse({
        code: 200,
        data: { size: 4096 },
      });
    }
    if (url.startsWith('https://postgrest.example.test/FILESIZE_CACHE_TABLE?')) {
      return createJsonResponse([]);
    }
    if (url === 'https://postgrest.example.test/rpc/landing_upsert_filesize_cache') {
      return createJsonResponse([{ ok: true }]);
    }
    if (url === 'https://postgrest.example.test/rpc/download_seed_ticket') {
      seedCallCount += 1;
      return createJsonResponse({ result: 'seeded' });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.bootstrapCache;
  });

  const response = await worker.fetch(await buildInfoRequest(), buildEnv(), { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.equal(seedCallCount, 0);
});

test('disabled mode with no ticket-state db wiring still issues a signed URL', async (t) => {
  delete globalThis.bootstrapCache;

  const bootstrap = buildBootstrap({
    dbMode: '',
    ticketStateTable: undefined,
  });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://controller.example.test/api/v0/bootstrap') {
      return createJsonResponse(bootstrap);
    }
    if (url === 'https://alist.example.test/api/fs/get') {
      return createJsonResponse({
        code: 200,
        data: { size: 4096 },
      });
    }
    if (url.startsWith('https://postgrest.example.test/FILESIZE_CACHE_TABLE?')) {
      return createJsonResponse([]);
    }
    if (url === 'https://postgrest.example.test/rpc/landing_upsert_filesize_cache') {
      return createJsonResponse([{ ok: true }]);
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.bootstrapCache;
  });

  const response = await worker.fetch(await buildInfoRequest(), buildEnv(), { waitUntil() {} });
  assert.equal(response.status, 200);

  const body = await readJson(response);
  const downloadURL = new URL(body?.data?.download?.url);
  const payload = downloadURL.searchParams.get('payload');
  assert.ok(payload, 'expected payload query param');

  const payloadData = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(Object.hasOwn(payloadData, 'ticketNonce'), false);
  assert.equal(Object.hasOwn(payloadData, 'idle_timeout'), false);
});
