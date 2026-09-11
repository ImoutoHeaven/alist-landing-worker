import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const glue = readFileSync(new URL('../src/assets/landing/landing-glue.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/assets/landing/landing.html', import.meta.url), 'utf8');

const extractArrowFunction = (name) => {
  const start = glue.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `expected ${name} in landing glue`);
  const arrow = glue.indexOf('=>', start);
  assert.notEqual(arrow, -1, `expected ${name} arrow in landing glue`);
  const bodyStart = glue.indexOf('{', arrow);
  assert.notEqual(bodyStart, -1, `expected ${name} body in landing glue`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < glue.length; index += 1) {
    const char = glue[index];
    const next = glue[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return glue.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated ${name}`);
};

const retryContext = vm.createContext({});
vm.runInContext(
  `${extractArrowFunction('parseRetryAfterMs')}
   ${extractArrowFunction('withRetryAfterMinimum')}
   globalThis.__parseRetryAfterMs = parseRetryAfterMs;
   globalThis.__withRetryAfterMinimum = withRetryAfterMinimum;`,
  retryContext,
);
const parseRetryAfterMs = retryContext.__parseRetryAfterMs;
const withRetryAfterMinimum = retryContext.__withRetryAfterMinimum;

test('Retry-After numeric seconds become a lower-bound delay', () => {
  assert.equal(parseRetryAfterMs('17', 1_700_000_000_000), 17_000);
  assert.equal(withRetryAfterMinimum(20_000, parseRetryAfterMs('17', 1_700_000_000_000)), 20_000);
  assert.equal(withRetryAfterMinimum(20_000, parseRetryAfterMs('30', 1_700_000_000_000)), 30_000);
});

test('Retry-After HTTP-date values use remaining time at response receipt', () => {
  const now = Date.parse('Wed, 21 Oct 2030 07:28:00 GMT');
  const future = 'Wed, 21 Oct 2030 07:28:37 GMT';
  assert.equal(parseRetryAfterMs(future, now), 37_000);
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2030 07:27:59 GMT', now), 0);
});

test('missing and invalid Retry-After values preserve the normal retry delay', () => {
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs(''), null);
  assert.equal(parseRetryAfterMs('later'), null);
  assert.equal(parseRetryAfterMs('-1'), null);
  assert.equal(parseRetryAfterMs('1.5'), null);
  assert.equal(withRetryAfterMinimum(20_000, parseRetryAfterMs('later')), 20_000);
});

const makeResponse = ({ status, retryAfter = null, body = [] }) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get(name) {
      return name.toLowerCase() === 'retry-after' ? retryAfter : null;
    },
  },
  arrayBuffer: async () => Uint8Array.from(body).buffer,
});

const createDownloaderHarness = (responses, { retryLimit = 5 } = {}) => {
  const wallClock = { now: 1_700_000_000_000 };
  const monotonicClock = { now: 500_000 };
  const timers = new Map();
  const timerEvents = [];
  const rangeRequests = [];
  const enqueued = [];
  const logs = [];
  const waitNotifications = [];
  let nextTimerId = 1;
  let responseIndex = 0;

  class HarnessDate extends Date {
    static now() {
      return wallClock.now;
    }
  }

  const HarnessPerformance = {
    now() {
      return monotonicClock.now;
    },
  };

  class HarnessAbortController {
    constructor() {
      this.signal = { aborted: false };
    }

    abort() {
      this.signal.aborted = true;
    }
  }

  const segment = {
    index: 0,
    length: 16,
    mapping: { underlyingOffset: 128, underlyingLimit: 16 },
    status: 'pending',
    retries: 0,
    encrypted: null,
    error: null,
  };
  const state = {
    cancelling: false,
    paused: false,
    remote: { url: 'https://download.example.test/file', method: 'GET', headers: {} },
    segments: [segment],
    retryTimers: new Map(),
    abortControllers: new Set(),
    failedSegments: new Set(),
    segmentRetryLimit: retryLimit,
    totalEncrypted: 16,
    downloadedEncrypted: 0,
    bytesSinceSpeedCheck: 0,
    encryptionMode: 'plain',
    cacheKey: '',
    ttfbTimeoutSeconds: 180,
  };

  const context = vm.createContext({
    state,
    Date: HarnessDate,
    performance: HarnessPerformance,
    Math,
    Number,
    String,
    Error,
    Set,
    Map,
    Uint8Array,
    AbortController: HarnessAbortController,
    setTimeout(callback, delay) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, delay });
      timerEvents.push({ id, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fetch: async (_url, init) => {
      rangeRequests.push(init.headers.get('Range'));
      const response = responses[responseIndex];
      responseIndex += 1;
      if (!response) throw new Error('test response sequence exhausted');
      return response;
    },
    buildRemoteHeaders: () => {
      const values = new Map();
      return {
        set(name, value) {
          values.set(name.toLowerCase(), String(value));
        },
        get(name) {
          return values.get(name.toLowerCase()) ?? null;
        },
      };
    },
    toTtfbTimeoutMs: (seconds) => Number(seconds) * 1000,
    MAX_NATIVE_TIMER_DELAY_MS: 2_147_483_647,
    RETRY_DELAY_MS: 20_000,
    HTTP429_BASE_DELAY_MS: 1_000,
    HTTP429_SILENT_RETRY_LIMIT: 9,
    HTTP429_MAX_DELAY_MS: 10_000,
    MIN_TTFB_TIMEOUT_SECONDS: 180,
    MAX_TTFB_TIMEOUT_SECONDS: 600,
    DEFAULT_TTFB_TIMEOUT_SECONDS: 180,
    applyProgress() {},
    cancelScheduledRetry: undefined,
    notifyPendingSegmentWaiters: () => waitNotifications.push(true),
    enqueueSegment: (index, prioritize) => enqueued.push({ index, prioritize }),
    syncFailedSegmentsUi() {},
    persistSegmentData: async () => {},
    buildCurrentMetaForSignature: () => ({}),
    log: (message) => logs.push(message),
    landingLogEvent() {},
  });

  const functionNames = [
    'parseRetryAfterMs',
    'withRetryAfterMinimum',
    'cancelScheduledRetry',
    'clearAllRetryTimers',
    'scheduleSegmentRetry',
    'recordSegmentFailure',
    'downloadSegment',
  ];
  vm.runInContext(
    `${functionNames.map((name) => extractArrowFunction(name)).join('\n')}
     globalThis.__cancelScheduledRetry = cancelScheduledRetry;
     globalThis.__clearAllRetryTimers = clearAllRetryTimers;
     globalThis.__scheduleSegmentRetry = scheduleSegmentRetry;
     globalThis.__downloadSegment = downloadSegment;`,
    context,
  );

  const advanceTimer = (id, { wallMs, monotonicMs } = {}) => {
    const timer = timers.get(id);
    assert.ok(timer, `expected timer ${id} to remain scheduled`);
    timers.delete(id);
    wallClock.now += wallMs ?? timer.delay;
    monotonicClock.now += monotonicMs ?? timer.delay;
    timer.callback();
  };

  const jumpWallClock = (deltaMs) => {
    wallClock.now += deltaMs;
  };

  const retryTimerId = () => state.retryTimers.get(0);

  return {
    state,
    timers,
    timerEvents,
    rangeRequests,
    enqueued,
    logs,
    waitNotifications,
    retryTimerId,
    advanceTimer,
    jumpWallClock,
    downloadSegment: (index) => context.__downloadSegment(index),
    clearAllRetryTimers: () => context.__clearAllRetryTimers(),
  };
};

test('actual downloadSegment honors 503 Retry-After before retrying the same Range', async () => {
  const harness = createDownloaderHarness([
    makeResponse({ status: 503, retryAfter: '30' }),
    makeResponse({ status: 206, body: Array(16).fill(7) }),
  ]);

  await harness.downloadSegment(0);
  assert.equal(harness.rangeRequests.length, 1);
  assert.equal(harness.rangeRequests[0], 'bytes=128-143');
  const retryId = harness.retryTimerId();
  assert.ok(retryId);
  assert.equal(harness.timerEvents[0].delay, 180_000);
  assert.equal(harness.timers.get(retryId).delay, 30_000);
  assert.equal(harness.state.segments[0].status, 'waiting-retry');

  harness.advanceTimer(retryId);
  assert.deepEqual(harness.enqueued, [{ index: 0, prioritize: false }]);
  await harness.downloadSegment(0);
  assert.deepEqual(harness.rangeRequests, ['bytes=128-143', 'bytes=128-143']);
  assert.equal(harness.state.segments[0].status, 'done');
  assert.equal(harness.state.segments[0].retries, 0);
});

test('actual retry timer cancellation prevents a delayed 503 attempt from requeueing', async () => {
  const harness = createDownloaderHarness([makeResponse({ status: 503, retryAfter: '90' })]);
  await harness.downloadSegment(0);
  const retryId = harness.retryTimerId();
  assert.ok(retryId);
  harness.state.cancelling = true;
  harness.clearAllRetryTimers();
  assert.equal(harness.state.retryTimers.size, 0);
  assert.equal(harness.timers.has(retryId), false);
  assert.deepEqual(harness.enqueued, []);
  assert.equal(harness.rangeRequests.length, 1);
});

test('paused download preserves an observed 503 minimum until resume', async () => {
  const harness = createDownloaderHarness([
    makeResponse({ status: 503, retryAfter: '40' }),
    makeResponse({ status: 206, body: Array(16).fill(7) }),
  ]);
  harness.state.paused = true;
  await harness.downloadSegment(0);
  const retryId = harness.retryTimerId();
  assert.equal(harness.timers.get(retryId).delay, 40_000);
  assert.deepEqual(harness.enqueued, []);
  harness.state.paused = false;
  harness.advanceTimer(retryId);
  assert.deepEqual(harness.enqueued, [{ index: 0, prioritize: true }]);
  await harness.downloadSegment(0);
  assert.equal(harness.state.segments[0].status, 'done');
  assert.deepEqual(harness.rangeRequests, ['bytes=128-143', 'bytes=128-143']);
});

test('actual downloadSegment stops at the configured retry limit and keeps Range stable', async () => {
  const harness = createDownloaderHarness([
    makeResponse({ status: 503, retryAfter: '30' }),
    makeResponse({ status: 503, retryAfter: '99' }),
  ], { retryLimit: 1 });
  await harness.downloadSegment(0);
  const firstRetryId = harness.retryTimerId();
  harness.advanceTimer(firstRetryId);
  await assert.rejects(() => harness.downloadSegment(0), /分段下载失败，HTTP 503/);
  assert.deepEqual(harness.rangeRequests, ['bytes=128-143', 'bytes=128-143']);
  assert.equal(harness.state.segments[0].retries, 2);
  assert.deepEqual([...harness.state.failedSegments], [0]);
  assert.equal(harness.state.retryTimers.size, 0);
});

test('a later error uses its own retry delay instead of inheriting a prior 503 header', async () => {
  const harness = createDownloaderHarness([
    makeResponse({ status: 503, retryAfter: '40' }),
    makeResponse({ status: 500 }),
  ]);
  await harness.downloadSegment(0);
  const firstRetryId = harness.retryTimerId();
  assert.equal(harness.timers.get(firstRetryId).delay, 40_000);
  harness.advanceTimer(firstRetryId);
  await harness.downloadSegment(0);
  const secondRetryId = harness.retryTimerId();
  assert.equal(harness.timers.get(secondRetryId).delay, 20_000);
  assert.deepEqual(harness.rangeRequests, ['bytes=128-143', 'bytes=128-143']);
});

test('large valid Retry-After values are split across native timer limits without early requeue', async () => {
  const harness = createDownloaderHarness([makeResponse({ status: 503, retryAfter: '2147484' })]);
  await harness.downloadSegment(0);
  const firstRetryId = harness.retryTimerId();
  assert.equal(harness.timers.get(firstRetryId).delay, 2_147_483_647);
  harness.advanceTimer(firstRetryId);
  const secondRetryId = harness.retryTimerId();
  assert.ok(secondRetryId);
  assert.equal(harness.timers.get(secondRetryId).delay, 353);

  harness.jumpWallClock(1_000);
  harness.advanceTimer(secondRetryId, { wallMs: 0, monotonicMs: 0 });
  const thirdRetryId = harness.retryTimerId();
  assert.ok(thirdRetryId);
  assert.equal(harness.timers.get(thirdRetryId).delay, 353);
  assert.deepEqual(harness.enqueued, []);
  harness.state.cancelling = true;
  harness.clearAllRetryTimers();
  assert.equal(harness.state.retryTimers.size, 0);
});

test('TTFB bounds and retry integration are consistent across UI and runtime', () => {
  assert.match(html, /min="180" max="600" value="180"/);
  assert.match(html, /范围 180-600 秒，默认 180 秒/);
  assert.match(glue, /const MIN_TTFB_TIMEOUT_SECONDS = 180;/);
  assert.match(glue, /const MAX_TTFB_TIMEOUT_SECONDS = 600;/);
  assert.match(glue, /const DEFAULT_TTFB_TIMEOUT_SECONDS = 180;/);
  assert.match(glue, /const ttfbTimeoutMs = toTtfbTimeoutMs\(state\.ttfbTimeoutSeconds\)/);
  assert.match(glue, /parsed < MIN_TTFB_TIMEOUT_SECONDS \|\| parsed > MAX_TTFB_TIMEOUT_SECONDS/);
});

test('HTTP 503 metadata is captured before retry scheduling', () => {
  assert.match(glue, /responseError\.status = Number\(response\.status\)/);
  assert.match(glue, /responseError\.retryAfterMs = parseRetryAfterMs\(retryAfter\)/);
  assert.match(glue, /if \(status === 503\) \{[\s\S]*withRetryAfterMinimum\(retryDelayMs, error\?\.retryAfterMs\)/);
  assert.match(glue, /headers\.set\('Range', 'bytes=' \+ start \+ '-' \+ end\)/);
  assert.match(glue, /attempt <= retryLimit/);
  assert.match(glue, /clearAllRetryTimers\(\);/);
});
