import { sha256Hash } from '../utils.js';

const ensureTable = async (db, tableName) => {
  const sql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      PATH_HASH TEXT PRIMARY KEY,
      PATH TEXT NOT NULL,
      SIZE INTEGER NOT NULL,
      TIMESTAMP INTEGER NOT NULL
    )
  `;
  await db.prepare(sql).run();

  const indexSql = `CREATE INDEX IF NOT EXISTS idx_filesize_cache_timestamp ON ${tableName}(TIMESTAMP)`;
  await db.prepare(indexSql).run();
};

const cleanupExpiredCache = async (db, tableName, sizeTTL) => {
  const ttlSeconds = Number(sizeTTL) || 0;
  if (ttlSeconds <= 0) {
    return 0;
  }

  const now = Math.floor(Date.now() / 1000);
  const cutoffTime = now - (ttlSeconds * 2);

  try {
    console.log(`[Filesize Cache Cleanup] Executing DELETE for records older than ${cutoffTime}`);
    const deleteSql = `DELETE FROM ${tableName} WHERE TIMESTAMP < ?`;
    const result = await db.prepare(deleteSql).bind(cutoffTime).run();
    const deletedCount = result.meta?.changes || 0;
    console.log(`[Filesize Cache Cleanup] Removed ${deletedCount} expired records`);
    return deletedCount;
  } catch (error) {
    console.error('[Filesize Cache Cleanup] DELETE failed:', error instanceof Error ? error.message : String(error));
    return 0;
  }
};

export const checkCache = async (path, config) => {
  if (!config?.env || !config?.databaseBinding) {
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
    const db = config.env[config.databaseBinding];
    if (!db) {
      throw new Error(`D1 database binding '${config.databaseBinding}' not found in env`);
    }

    const tableName = config.tableName || 'FILESIZE_CACHE_TABLE';

    await ensureTable(db, tableName);

    const pathHash = await sha256Hash(path);
    if (!pathHash) {
      return null;
    }

    const selectSql = `SELECT SIZE, TIMESTAMP FROM ${tableName} WHERE PATH_HASH = ?`;
    const row = await db.prepare(selectSql).bind(pathHash).first();
    if (!row) {
      console.log('[Filesize Cache] MISS (no record)');
      return null;
    }

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

    console.log('[Filesize Cache] HIT (D1 binding)');
    return { size: sizeValue };
  } catch (error) {
    console.error('[Filesize Cache] Check failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
};

export const saveCache = async (path, size, config) => {
  if (!config?.env || !config?.databaseBinding) {
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
    const db = config.env[config.databaseBinding];
    if (!db) {
      throw new Error(`D1 database binding '${config.databaseBinding}' not found in env`);
    }

    const tableName = config.tableName || 'FILESIZE_CACHE_TABLE';
    await ensureTable(db, tableName);

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

    const result = await db.prepare(upsertSql)
      .bind(pathHash, path, normalizedSize, now)
      .first();

    if (!result) {
      throw new Error('D1 filesize cache UPSERT returned no rows');
    }

    const triggerCleanup = () => {
      const probability = config.cleanupProbability ?? 0.01;
      if (probability <= 0) {
        return;
      }
      if (Math.random() < probability) {
        console.log(`[Filesize Cache Cleanup] Triggering probabilistic cleanup (p=${probability})`);
        const cleanupPromise = cleanupExpiredCache(db, tableName, sizeTTL).catch((error) => {
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
