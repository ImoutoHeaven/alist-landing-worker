import assert from 'node:assert/strict';
import test from 'node:test';
import { bindWaitUntil, logEvent, sanitizeLogStructuredValue, sanitizeLogValue } from '../src/logging.js';

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
    await run();
    return entries;
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

test('sanitizeLogValue redacts secrets, IPs, payloads, and query strings', () => {
  const text = sanitizeLogValue('Authorization: Bearer leaked token=secret ip=203.0.113.9 url=https://x.test/file?signature=secret payload=secret');
  assert.doesNotMatch(text, /Bearer leaked|token=secret|203\.0\.113\.9|signature=secret|payload=secret/i);
  assert.match(text, /\[redacted\]/);
});

test('sanitizeLogValue redacts JSON-style secrets in raw text', () => {
  const text = sanitizeLogValue('failed with {"token":"secret","payload":"raw","nonce":"abc","challengePayload":"raw-secret","bindingMaterial":"mac-secret","apiKey":"api-secret","status":403}');
  assert.doesNotMatch(text, /"token":"secret"|"payload":"raw"|"nonce":"abc"|"challengePayload":"raw-secret"|"bindingMaterial":"mac-secret"|"apiKey":"api-secret"/i);
  assert.doesNotMatch(text, /raw-secret|mac-secret|api-secret/i);
  assert.match(text, /"status":403/);
  assert.match(text, /\[redacted\]/);
});

test('sanitizeLogValue redacts camelCase assignment-style secrets in raw text', () => {
  const text = sanitizeLogValue('challengePayload=raw-secret bindingMaterial=mac-secret altChallengeResult=raw-secret status=403');
  assert.doesNotMatch(text, /challengePayload=raw-secret|bindingMaterial=mac-secret|altChallengeResult=raw-secret/i);
  assert.doesNotMatch(text, /raw-secret|mac-secret/i);
  assert.match(text, /status=403/);
  assert.match(text, /\[redacted\]/);
});

test('sanitizeLogStructuredValue redacts clones and omits IP fields', () => {
  const source = {
    token: 'secret',
    status: 403,
    nested: {
      clientIp: '203.0.113.9',
      retryCount: 2,
      challengePayload: 'payload-secret',
    },
  };
  const sanitized = sanitizeLogStructuredValue(source);
  assert.notEqual(sanitized, source);
  assert.equal(sanitized.token, '[redacted]');
  assert.equal(sanitized.status, 403);
  assert.equal(sanitized.nested.retryCount, 2);
  assert.equal('clientIp' in sanitized.nested, false);
  assert.equal(sanitized.nested.challengePayload, '[redacted]');
});

test('logEvent emits bracketed component, event, and sanitized fields', async () => {
  const entries = await captureConsole(() => logEvent('warn', 'LoggingTest', 'leak_check', {
    token: 'secret',
    status: 403,
    message: 'client=2001:db8::1 nonce=abc payload=secret challengePayload=raw-secret raw={"token":"secret","payload":"raw"}',
  }));
  assert.match(entries.join('\n'), /^\[LoggingTest\] leak_check /);
  assert.match(entries.join('\n'), /status=403/);
  assert.doesNotMatch(entries.join('\n'), /2001:db8|nonce=abc|payload=secret|challengePayload=raw-secret|raw-secret|token=secret|"token":"secret"|"payload":"raw"/i);
});

test('bindWaitUntil logs bound, inline, done, and failed lifecycle states without changing promise behavior', async () => {
  const tracked = [];
  const ctx = {
    waitUntil(promise) {
      tracked.push(promise);
    },
  };

  const boundEntries = await captureConsole(async () => {
    const resolved = bindWaitUntil(ctx, Promise.resolve('ok'), 'LoggingTest', 'cleanup', {
      status: 202,
      token: 'secret',
      message: 'nonce=abc payload=secret client=203.0.113.9',
    });
    assert.equal(await resolved, 'ok');
    assert.equal(tracked.length, 1);
    await tracked[0];
  });
  const boundText = boundEntries.join('\n');
  assert.match(boundText, /\[LoggingTest\] cleanup_bound /);
  assert.match(boundText, /\[LoggingTest\] cleanup_done /);
  assert.match(boundText, /status=202/);
  assert.doesNotMatch(boundText, /token=secret|nonce=abc|payload=secret|203\.0\.113\.9/i);

  const inlineEntries = await captureConsole(async () => {
    const rejected = bindWaitUntil(null, Promise.reject(new Error('url=https://x.test/a?signature=secret payload=secret')), 'LoggingTest', 'cleanup', {
      token: 'secret',
    });
    await assert.rejects(rejected, /signature=secret payload=secret/);
  });
  const inlineText = inlineEntries.join('\n');
  assert.match(inlineText, /\[LoggingTest\] cleanup_inline /);
  assert.match(inlineText, /\[LoggingTest\] cleanup_failed /);
  assert.doesNotMatch(inlineText, /token=secret|signature=secret|payload=secret/i);
});
