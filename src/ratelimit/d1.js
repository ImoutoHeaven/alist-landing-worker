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

/**
 * Check and update rate limit for an IP address
 * @param {string} ip - Client IP address
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
 * @returns {Promise<{allowed: boolean, ipSubnet?: string, retryAfter?: number, error?: string}>}
 */
export const checkRateLimit = async (ip, config) => {
  // If any required config is missing, skip rate limiting
  if (!config.env || !config.databaseBinding || !config.windowTimeSeconds || !config.limit) {
    return { allowed: true };
  }

  if (!ip || typeof ip !== 'string') {
    return { allowed: true };
  }

  try {
    // Get D1 database instance from binding
    const db = config.env[config.databaseBinding];
    if (!db) {
      throw new Error(`D1 database binding '${config.databaseBinding}' not found in env`);
    }

    const tableName = config.tableName || 'IP_LIMIT_TABLE';

    // Ensure table exists
    await ensureTable(db, tableName);

    // Calculate IP subnet
    const ipSubnet = calculateIPSubnet(ip, config.ipv4Suffix, config.ipv6Suffix);
    if (!ipSubnet) {
      return { allowed: true };
    }

    // Calculate SHA256 hash of IP subnet
    const ipHash = await sha256Hash(ipSubnet);
    if (!ipHash) {
      return { allowed: true };
    }

    // Get current timestamp (in seconds)
    const now = Math.floor(Date.now() / 1000);

    // Atomic UPSERT with RETURNING - single database round-trip, no locks needed
    // D1 (SQLite) supports RETURNING since SQLite 3.35.0
    const upsertSql = `
      INSERT INTO ${tableName} (IP_HASH, IP_RANGE, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL)
      VALUES (?, ?, 1, ?, NULL)
      ON CONFLICT (IP_HASH) DO UPDATE SET
        ACCESS_COUNT = CASE
          WHEN ? - ${tableName}.LAST_WINDOW_TIME >= ? THEN 1
          WHEN ${tableName}.BLOCK_UNTIL IS NOT NULL AND ${tableName}.BLOCK_UNTIL <= ? THEN 1
          WHEN ${tableName}.ACCESS_COUNT >= ? THEN ${tableName}.ACCESS_COUNT
          ELSE ${tableName}.ACCESS_COUNT + 1
        END,
        LAST_WINDOW_TIME = CASE
          WHEN ? - ${tableName}.LAST_WINDOW_TIME >= ? THEN ?
          WHEN ${tableName}.BLOCK_UNTIL IS NOT NULL AND ${tableName}.BLOCK_UNTIL <= ? THEN ?
          ELSE ${tableName}.LAST_WINDOW_TIME
        END,
        BLOCK_UNTIL = CASE
          WHEN ? - ${tableName}.LAST_WINDOW_TIME >= ? THEN NULL
          WHEN ${tableName}.BLOCK_UNTIL IS NOT NULL AND ${tableName}.BLOCK_UNTIL <= ? THEN NULL
          WHEN ${tableName}.ACCESS_COUNT >= ? AND ? > 0
            THEN ? + ?
          ELSE ${tableName}.BLOCK_UNTIL
        END
      RETURNING ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL
    `;

    const blockTimeSeconds = config.blockTimeSeconds || 0;
    const stmt = db.prepare(upsertSql);
    const result = await stmt.bind(
      // INSERT VALUES
      ipHash, ipSubnet, now,
      // ACCESS_COUNT CASE parameters
      now, config.windowTimeSeconds, now, config.limit,
      // LAST_WINDOW_TIME CASE parameters
      now, config.windowTimeSeconds, now, now, now,
      // BLOCK_UNTIL CASE parameters
      now, config.windowTimeSeconds, now, config.limit, blockTimeSeconds, now, blockTimeSeconds
    ).first();

    if (!result) {
      throw new Error('D1 UPSERT returned no rows');
    }

    // Parse RETURNING result
    const accessCount = Number.parseInt(result.ACCESS_COUNT, 10);
    const lastWindowTime = Number.parseInt(result.LAST_WINDOW_TIME, 10);
    const blockUntil = result.BLOCK_UNTIL ? Number.parseInt(result.BLOCK_UNTIL, 10) : null;

    // Check if currently blocked
    if (blockUntil && blockUntil > now) {
      const retryAfter = blockUntil - now;
      return {
        allowed: false,
        ipSubnet,
        retryAfter: Math.max(1, retryAfter),
      };
    }

    // Check if limit exceeded (without block time configured)
    if (accessCount >= config.limit) {
      const diff = now - lastWindowTime;
      const retryAfter = config.windowTimeSeconds - diff;
      return {
        allowed: false,
        ipSubnet,
        retryAfter: Math.max(1, retryAfter),
      };
    }

    // Request allowed
    return { allowed: true };
  } catch (error) {
    // Handle errors based on pgErrorHandle strategy
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (config.pgErrorHandle === 'fail-open') {
      // Log error and allow request
      console.error('Rate limit check failed (fail-open):', errorMessage);
      return { allowed: true };
    } else {
      // fail-closed: propagate error
      return {
        allowed: false,
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
