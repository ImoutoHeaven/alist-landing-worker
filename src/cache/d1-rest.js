import { sha256Hash } from '../utils.js';

const executeQuery = async (accountId, databaseId, apiToken, sql, params = []) => {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const body = { sql };
  if (params.length > 0) {
    body.params = params;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`D1 REST API error (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  if (!payload.success) {
    throw new Error(`D1 REST API query failed: ${JSON.stringify(payload.errors || 'Unknown error')}`);
  }

  return payload.result?.[0] || { results: [], success: true };
};

const ensureTable = async (accountId, databaseId, apiToken, tableName) => {
  const sql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      PATH_HASH TEXT PRIMARY KEY,
      PATH TEXT NOT NULL,
      SIZE INTEGER NOT NULL,
      TIMESTAMP INTEGER NOT NULL
    )
  `;
  await executeQuery(accountId, databaseId, apiToken, sql);

  const indexSql = `CREATE INDEX IF NOT EXISTS idx_filesize_cache_timestamp ON ${tableName}(TIMESTAMP)`;
  await executeQuery(accountId, databaseId, apiToken, indexSql);
};

const cleanupExpiredCache = async (accountId, databaseId, apiToken, tableName, sizeTTL) => {
  const ttlSeconds = Number(sizeTTL) || 0;
  if (ttlSeconds <= 0) {
    return 0;
  }

  const now = Math.floor(Date.now() / 1000);
  const cutoffTime = now - (ttlSeconds * 2);

  try {
    console.log(`[Filesize Cache Cleanup] Executing DELETE via D1 REST (cutoff=${cutoffTime})`);
    const deleteSql = `DELETE FROM ${tableName} WHERE TIMESTAMP < ?`;
    const result = await executeQuery(accountId, databaseId, apiToken, deleteSql, [cutoffTime]);
    const deletedCount = result.meta?.changes || 0;
    console.log(`[Filesize Cache Cleanup] Removed ${deletedCount} expired records`);
    return deletedCount;
  } catch (error) {
    console.error('[Filesize Cache Cleanup] DELETE failed:', error instanceof Error ? error.message : String(error));
    return 0;
  }
};

export const checkCache = async (path, config) => {
  if (!config?.accountId || !config?.databaseId || !config?.apiToken) {
    return null;
  }

  const sizeTTL = Number(config.sizeTTL) || 0;
  if (sizeTTL <= 0) {
    return null;
  }

  if (!path || typeof path !== 'string') {
    return null;
  }

  try {
    const { accountId, databaseId, apiToken } = config;
    const tableName = config.tableName || 'FILESIZE_CACHE_TABLE';

    await ensureTable(accountId, databaseId, apiToken, tableName);

    const pathHash = await sha256Hash(path);
    if (!pathHash) {
      return null;
    }

    const selectSql = `SELECT SIZE, TIMESTAMP FROM ${tableName} WHERE PATH_HASH = ?`;
    const queryResult = await executeQuery(accountId, databaseId, apiToken, selectSql, [pathHash]);
    const rows = queryResult.results || [];
    if (rows.length === 0) {
      console.log('[Filesize Cache] MISS (no record)');
      return null;
    }

    const row = rows[0];
    const now = Math.floor(Date.now() / 1000);
    const timestamp = Number.parseInt(row.TIMESTAMP, 10);
    const sizeValue = Number.parseInt(row.SIZE, 10);
    const age = now - timestamp;

    if (!Number.isFinite(timestamp) || age > sizeTTL) {
      console.log('[Filesize Cache] MISS (expired)');
      return null;
    }

    if (!Number.isFinite(sizeValue) || sizeValue < 0) {
      console.warn('[Filesize Cache] Invalid size stored, treating as miss');
      return null;
    }

    console.log('[Filesize Cache] HIT (D1 REST)');
    return { size: sizeValue };
  } catch (error) {
    console.error('[Filesize Cache] Check failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
};

export const saveCache = async (path, size, config) => {
  if (!config?.accountId || !config?.databaseId || !config?.apiToken) {
    return;
  }

  const sizeTTL = Number(config.sizeTTL) || 0;
  if (sizeTTL <= 0) {
    return;
  }

  if (!path || typeof path !== 'string') {
    return;
  }

  const normalizedSize = Number(size);
  if (!Number.isFinite(normalizedSize) || normalizedSize < 0) {
    console.warn('[Filesize Cache] Skipping save (invalid size value)');
    return;
  }

  try {
    const { accountId, databaseId, apiToken } = config;
    const tableName = config.tableName || 'FILESIZE_CACHE_TABLE';

    await ensureTable(accountId, databaseId, apiToken, tableName);

    const pathHash = await sha256Hash(path);
    if (!pathHash) {
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const upsertSql = `
      INSERT INTO ${tableName} (PATH_HASH, PATH, SIZE, TIMESTAMP)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (PATH_HASH) DO UPDATE SET
        SIZE = excluded.SIZE,
        TIMESTAMP = excluded.TIMESTAMP,
        PATH = excluded.PATH
      RETURNING PATH_HASH
    `;

    const queryResult = await executeQuery(accountId, databaseId, apiToken, upsertSql, [
      pathHash,
      path,
      normalizedSize,
      now,
    ]);
    const rows = queryResult.results || [];
    if (rows.length === 0) {
      throw new Error('D1 REST filesize cache UPSERT returned no rows');
    }

    const triggerCleanup = () => {
      const probability = config.cleanupProbability ?? 0.01;
      if (probability <= 0) {
        return;
      }
      if (Math.random() < probability) {
        console.log(`[Filesize Cache Cleanup] Triggering probabilistic cleanup (p=${probability})`);
        const cleanupPromise = cleanupExpiredCache(accountId, databaseId, apiToken, tableName, sizeTTL).catch((error) => {
          console.error('[Filesize Cache Cleanup] Failed:', error instanceof Error ? error.message : String(error));
        });
        if (config.ctx?.waitUntil) {
          config.ctx.waitUntil(cleanupPromise);
        }
      }
    };

    triggerCleanup();
  } catch (error) {
    console.error('[Filesize Cache] Save failed:', error instanceof Error ? error.message : String(error));
  }
};
