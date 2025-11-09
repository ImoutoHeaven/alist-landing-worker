import { calculateIPSubnet, sha256Hash } from '../utils.js';

/**
 * Ensure the IP_LIMIT_TABLE exists in the database
 * @param {D1Database} db - D1 Database instance
 * @param {string} tableName - Table name
 * @returns {Promise<void>}
 */
const ensureTable = async (db, tableName) => {
  const sql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      IP_HASH TEXT PRIMARY KEY,
      IP_RANGE TEXT NOT NULL,
      ACCESS_COUNT INTEGER NOT NULL,
      LAST_WINDOW_TIME INTEGER NOT NULL,
      BLOCK_UNTIL INTEGER
    )
  `;
  await db.prepare(sql).run();
};

const ensureFileTable = async (db, tableName) => {
  const sql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      IP_HASH TEXT NOT NULL,
      PATH_HASH TEXT NOT NULL,
      IP_RANGE TEXT NOT NULL,
      ACCESS_COUNT INTEGER NOT NULL,
      LAST_WINDOW_TIME INTEGER NOT NULL,
      BLOCK_UNTIL INTEGER,
      PRIMARY KEY (IP_HASH, PATH_HASH)
    )
  `;
  await db.prepare(sql).run();
};

/**
 * Check and update rate limit for an IP address and file path
 * @param {string} ip - Client IP address
 * @param {string} path - Requested file path (for per-file limits)
 * @param {Object} config - Rate limit configuration
 * @param {Object} config.env - Cloudflare Workers env object
 * @param {string} config.databaseBinding - D1 database binding name (e.g., 'DB')
 * @param {string} config.tableName - Table name (defaults to 'IP_LIMIT_TABLE')
 * @param {number} config.windowTimeSeconds - Time window in seconds
 * @param {number} config.limit - Request limit per window
 * @param {string} config.ipv4Suffix - IPv4 subnet suffix
 * @param {string} config.ipv6Suffix - IPv6 subnet suffix
 * @param {string} config.pgErrorHandle - Error handling strategy ('fail-open' or 'fail-closed')
 * @param {number} config.cleanupProbability - Probability of triggering cleanup (0.0 to 1.0)
 * @param {number} config.blockTimeSeconds - Additional block time in seconds when limit exceeded
 * @param {Object} config.ctx - ExecutionContext for waitUntil (optional)
 * @returns {Promise<{allowed: boolean, ipAllowed: boolean, ipSubnet?: string, ipRetryAfter?: number, fileAllowed: boolean, fileRetryAfter?: number, error?: string}>}
 */
export const checkRateLimit = async (ip, path, config) => {
  if (!config?.env || !config?.databaseBinding || !ip || typeof ip !== 'string') {
    return { allowed: true, ipAllowed: true, fileAllowed: true };
  }

  const ipLimitValue = Number(config.limit) || 0;
  const ipWindowSeconds = Number(config.windowTimeSeconds) || 0;
  const fileLimitValue = Number(config.fileLimit) || 0;
  const fileWindowSeconds = Number(config.fileWindowTimeSeconds) || 0;

  let ipCheckEnabled = Boolean((config.ipRateLimitEnabled ?? true) && ipLimitValue > 0 && ipWindowSeconds > 0);
  let fileCheckEnabled = Boolean((config.fileRateLimitEnabled ?? true) && fileLimitValue > 0 && fileWindowSeconds > 0);

  const normalizedPath = typeof path === 'string' ? path : '';
  if (fileCheckEnabled && normalizedPath.length === 0) {
    fileCheckEnabled = false;
  }

  if (!ipCheckEnabled && !fileCheckEnabled) {
    return { allowed: true, ipAllowed: true, fileAllowed: true };
  }

  try {
    // Get D1 database instance from binding
    const db = config.env[config.databaseBinding];
    if (!db) {
      throw new Error(`D1 database binding '${config.databaseBinding}' not found in env`);
    }

    const tableName = config.tableName || 'IP_LIMIT_TABLE';
    const fileTableName = config.fileTableName || 'IP_FILE_LIMIT_TABLE';

    if (ipCheckEnabled) {
      await ensureTable(db, tableName);
    }
    if (fileCheckEnabled) {
      await ensureFileTable(db, fileTableName);
    }

    // Calculate IP subnet
    const ipSubnet = calculateIPSubnet(ip, config.ipv4Suffix, config.ipv6Suffix);
    if (!ipSubnet) {
      return { allowed: true, ipAllowed: true, fileAllowed: true };
    }

    // Calculate SHA256 hash of IP subnet
    const ipHash = await sha256Hash(ipSubnet);
    if (!ipHash) {
      return { allowed: true, ipAllowed: true, fileAllowed: true };
    }

    let pathHash = null;
    if (fileCheckEnabled) {
      pathHash = await sha256Hash(normalizedPath);
      if (!pathHash) {
        fileCheckEnabled = false;
      }
    }

    // Get current timestamp (in seconds)
    const now = Math.floor(Date.now() / 1000);

    let ipAllowed = true;
    let ipRetryAfter = null;

    if (ipCheckEnabled) {
      const upsertSql = `
        INSERT INTO ${tableName} (IP_HASH, IP_RANGE, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL)
        VALUES (?, ?, 1, ?, NULL)
        ON CONFLICT (IP_HASH) DO UPDATE SET
          ACCESS_COUNT = CASE
            WHEN ${tableName}.BLOCK_UNTIL IS NOT NULL AND ${tableName}.BLOCK_UNTIL > ? THEN ${tableName}.ACCESS_COUNT
            WHEN ? - ${tableName}.LAST_WINDOW_TIME >= ? THEN 1
            WHEN ${tableName}.BLOCK_UNTIL IS NOT NULL AND ${tableName}.BLOCK_UNTIL <= ? THEN 1
            WHEN ${tableName}.ACCESS_COUNT >= ? THEN ${tableName}.ACCESS_COUNT
            ELSE ${tableName}.ACCESS_COUNT + 1
          END,
          LAST_WINDOW_TIME = CASE
            WHEN ${tableName}.BLOCK_UNTIL IS NOT NULL AND ${tableName}.BLOCK_UNTIL > ? THEN ${tableName}.LAST_WINDOW_TIME
            WHEN ? - ${tableName}.LAST_WINDOW_TIME >= ? THEN ?
            WHEN ${tableName}.BLOCK_UNTIL IS NOT NULL AND ${tableName}.BLOCK_UNTIL <= ? THEN ?
            ELSE ${tableName}.LAST_WINDOW_TIME
          END,
          BLOCK_UNTIL = CASE
            WHEN ${tableName}.BLOCK_UNTIL IS NOT NULL AND ${tableName}.BLOCK_UNTIL > ? THEN ${tableName}.BLOCK_UNTIL
            WHEN ${tableName}.BLOCK_UNTIL IS NOT NULL AND ${tableName}.BLOCK_UNTIL <= ? THEN NULL
            WHEN (${tableName}.BLOCK_UNTIL IS NULL OR ${tableName}.BLOCK_UNTIL <= ?)
              AND (
                CASE
                  WHEN ? - ${tableName}.LAST_WINDOW_TIME >= ? THEN 1
                  WHEN ${tableName}.BLOCK_UNTIL IS NOT NULL AND ${tableName}.BLOCK_UNTIL <= ? THEN 1
                  WHEN ${tableName}.ACCESS_COUNT >= ? THEN ${tableName}.ACCESS_COUNT
                  ELSE ${tableName}.ACCESS_COUNT + 1
                END
              ) >= ?
              AND ? > 0 THEN ? + ?
            ELSE ${tableName}.BLOCK_UNTIL
          END
        RETURNING ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL
      `;

      const blockTimeSeconds = config.blockTimeSeconds || 0;
      const stmt = db.prepare(upsertSql);
      const result = await stmt.bind(
        ipHash, ipSubnet, now,
        now, now, ipWindowSeconds, now, ipLimitValue,
        now, now, ipWindowSeconds, now, now, now,
        now, now, now,
        now, ipWindowSeconds, now, ipLimitValue, ipLimitValue, blockTimeSeconds, now, blockTimeSeconds
      ).first();

      if (!result) {
        throw new Error('D1 UPSERT returned no rows');
      }

      const accessCount = Number.parseInt(result.ACCESS_COUNT, 10);
      const lastWindowTime = Number.parseInt(result.LAST_WINDOW_TIME, 10);
      const blockUntil = result.BLOCK_UNTIL ? Number.parseInt(result.BLOCK_UNTIL, 10) : null;

      if (blockUntil && blockUntil > now) {
        ipAllowed = false;
        ipRetryAfter = Math.max(1, blockUntil - now);
      } else if (Number.isFinite(accessCount) && accessCount >= ipLimitValue) {
        const diff = now - (Number.isFinite(lastWindowTime) ? lastWindowTime : now);
        ipAllowed = false;
        ipRetryAfter = Math.max(1, ipWindowSeconds - diff);
      }
    }

    let fileAllowed = true;
    let fileRetryAfter = null;

    if (fileCheckEnabled && pathHash) {
      const fileBlockSeconds = config.fileBlockTimeSeconds || 0;
      const fileSql = `
        INSERT INTO ${fileTableName} (IP_HASH, PATH_HASH, IP_RANGE, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL)
        VALUES (?, ?, ?, 1, ?, NULL)
        ON CONFLICT (IP_HASH, PATH_HASH) DO UPDATE SET
          ACCESS_COUNT = CASE
            WHEN ${fileTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileTableName}.BLOCK_UNTIL > ? THEN ${fileTableName}.ACCESS_COUNT
            WHEN ? - ${fileTableName}.LAST_WINDOW_TIME >= ? THEN 1
            WHEN ${fileTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileTableName}.BLOCK_UNTIL <= ? THEN 1
            WHEN ${fileTableName}.ACCESS_COUNT >= ? THEN ${fileTableName}.ACCESS_COUNT
            ELSE ${fileTableName}.ACCESS_COUNT + 1
          END,
          LAST_WINDOW_TIME = CASE
            WHEN ${fileTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileTableName}.BLOCK_UNTIL > ? THEN ${fileTableName}.LAST_WINDOW_TIME
            WHEN ? - ${fileTableName}.LAST_WINDOW_TIME >= ? THEN ?
            WHEN ${fileTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileTableName}.BLOCK_UNTIL <= ? THEN ?
            ELSE ${fileTableName}.LAST_WINDOW_TIME
          END,
          BLOCK_UNTIL = CASE
            WHEN ${fileTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileTableName}.BLOCK_UNTIL > ? THEN ${fileTableName}.BLOCK_UNTIL
            WHEN ${fileTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileTableName}.BLOCK_UNTIL <= ? THEN NULL
            WHEN (${fileTableName}.BLOCK_UNTIL IS NULL OR ${fileTableName}.BLOCK_UNTIL <= ?)
              AND (
                CASE
                  WHEN ? - ${fileTableName}.LAST_WINDOW_TIME >= ? THEN 1
                  WHEN ${fileTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileTableName}.BLOCK_UNTIL <= ? THEN 1
                  WHEN ${fileTableName}.ACCESS_COUNT >= ? THEN ${fileTableName}.ACCESS_COUNT
                  ELSE ${fileTableName}.ACCESS_COUNT + 1
                END
              ) >= ?
              AND ? > 0 THEN ? + ?
            ELSE ${fileTableName}.BLOCK_UNTIL
          END
        RETURNING ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL
      `;

      const stmt = db.prepare(fileSql);
      const fileResult = await stmt.bind(
        ipHash, pathHash, ipSubnet, now,
        now, now, fileWindowSeconds, now, fileLimitValue,
        now, now, fileWindowSeconds, now, now, now,
        now, now, now,
        now, fileWindowSeconds, now, fileLimitValue, fileLimitValue, fileBlockSeconds, now, fileBlockSeconds
      ).first();

      if (!fileResult) {
        throw new Error('D1 file UPSERT returned no rows');
      }

      const fileAccessCount = Number.parseInt(fileResult.ACCESS_COUNT, 10);
      const fileLastWindowTime = Number.parseInt(fileResult.LAST_WINDOW_TIME, 10);
      const fileBlockUntil = fileResult.BLOCK_UNTIL ? Number.parseInt(fileResult.BLOCK_UNTIL, 10) : null;

      if (fileBlockUntil && fileBlockUntil > now) {
        fileAllowed = false;
        fileRetryAfter = Math.max(1, fileBlockUntil - now);
      } else if (Number.isFinite(fileAccessCount) && fileAccessCount >= fileLimitValue) {
        const diff = now - (Number.isFinite(fileLastWindowTime) ? fileLastWindowTime : now);
        fileAllowed = false;
        fileRetryAfter = Math.max(1, fileWindowSeconds - diff);
      }
    }

    return {
      allowed: ipAllowed && fileAllowed,
      ipAllowed,
      ipRetryAfter,
      ipSubnet,
      fileAllowed,
      fileRetryAfter,
    };
  } catch (error) {
    // Handle errors based on pgErrorHandle strategy
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (config.pgErrorHandle === 'fail-open') {
      // Log error and allow request
      console.error('Rate limit check failed (fail-open):', errorMessage);
      return { allowed: true, ipAllowed: true, fileAllowed: true };
    } else {
      // fail-closed: propagate error
      return {
        allowed: false,
        ipAllowed: false,
        fileAllowed: true,
        error: `Rate limit check failed: ${errorMessage}`,
      };
    }
  }
};

/**
 * Clean up expired records from the database
 * Removes records older than windowTimeSeconds * 2 (double buffer)
 * Respects BLOCK_UNTIL: does NOT delete records that are still blocked
 * @param {D1Database} db - D1 Database instance
 * @param {string} tableName - Table name
 * @param {number} windowTimeSeconds - Time window in seconds
 * @returns {Promise<number>} - Number of deleted records
 */
const cleanupExpiredRecords = async (db, tableName, windowTimeSeconds) => {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTime = now - (windowTimeSeconds * 2);

  try {
    console.log(`[Rate Limit Cleanup] Executing DELETE query (cutoff: ${cutoffTime}, windowTime: ${windowTimeSeconds}s)`);

    // Delete records where:
    // 1. LAST_WINDOW_TIME is older than cutoff (window expired)
    // 2. AND (BLOCK_UNTIL is NULL OR BLOCK_UNTIL has expired)
    // This ensures we don't delete records that are still blocked
    const stmt = db.prepare(
      `DELETE FROM ${tableName}
       WHERE LAST_WINDOW_TIME < ?
         AND (BLOCK_UNTIL IS NULL OR BLOCK_UNTIL < ?)`
    );
    const result = await stmt.bind(cutoffTime, now).run();

    const deletedCount = result.meta?.changes || 0;
    console.log(`[Rate Limit Cleanup] DELETE completed: ${deletedCount} expired records deleted (older than ${windowTimeSeconds * 2}s and not blocked)`);

    return deletedCount;
  } catch (error) {
    // Log error but don't propagate (cleanup failure shouldn't block requests)
    console.error('[Rate Limit Cleanup] DELETE failed:', error instanceof Error ? error.message : String(error));
    return 0;
  }
};

/**
 * Format time window for display (seconds to human readable)
 * @param {number} seconds - Time in seconds
 * @returns {string} - Formatted time (e.g., "24h", "30m", "10s")
 */
export const formatWindowTime = (seconds) => {
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }
  return `${seconds}s`;
};
