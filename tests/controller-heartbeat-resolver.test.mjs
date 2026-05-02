import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __landingTestHooks } from '../src/worker.js';

test('resolveConfig preserves controller heartbeat config', () => {
  const { resolveConfig, readResolvedHeartbeatContract } = __landingTestHooks;
  const bootstrap = {
    common: {
      tokenHmacKey: 'replace-with-hmac-key',
      workerAddresses: ['https://download-worker.example.com'],
      landingWorkerAddresses: ['https://landing-worker.example.com'],
    },
    landing: {
      pageSecret: 'replace-with-page-secret',
      frontend: {
        glueUrl: 'https://cdn.example.com/landing-glue.js',
        htmlUrl: 'https://cdn.example.com/landing.html',
        commonCssUrl: 'https://cdn.example.com/common.css',
        themeCssUrl: 'https://cdn.example.com/theme.css',
      },
      altcha: { enabled: false },
    },
    download: {
      trueConcurrency: {
        enabled: true,
        hostPatterns: ['*.sharepoint.com'],
        handlerUrl: 'https://concurrency-handler-staging.example.com',
        handlerAuthKey: 'replace-with-concurrency-handler-key',
        handlerAuthHeader: 'X-CQ-Auth',
        siteBucket: { mode: 'sharepoint', modes: ['sharepoint'] },
        acquireTimeoutMs: 11500,
        releaseTimeoutMs: 1500,
        heartbeat: {
          enabled: true,
          required: true,
          path: '/api/v1/concurrency/heartbeat',
          intervalMs: 5000,
          timeoutMs: 15000,
          reconnectGraceMs: 12000,
          helloTimeoutMs: 2000,
          startTimeoutMs: 7000,
          ackTimeoutMs: 2000,
          initialConnectMaxAttempts: 3,
          initialConnectMaxElapsedMs: 3000,
          reconnectMaxAttempts: 3,
          reconnectMaxElapsedMs: 10000,
          reconnectBaseDelayMs: 250,
          reconnectMaxDelayMs: 2000,
          reconnectSafetyMarginMs: 1000,
        },
      },
    },
  };

  const config = resolveConfig({}, bootstrap);
  assert.deepEqual(
    readResolvedHeartbeatContract(config),
    bootstrap.download.trueConcurrency.heartbeat,
  );
});
