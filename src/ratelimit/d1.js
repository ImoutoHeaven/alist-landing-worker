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
      IP_ADDR TEXT NOT NULL,
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

    // Query for existing record
    // Probabilistic cleanup helper
    const triggerCleanup = () => {
      // Use configured cleanup probability (default 1% = 0.01)
      const probability = config.cleanupProbability || 0.01;
      if (Math.random() < probability) {
        console.log(`[Rate Limit Cleanup] Triggered cleanup (probability: ${probability * 100}%)`);

        // Use ctx.waitUntil to ensure cleanup completes even after response is sent
        const cleanupPromise = cleanupExpiredRecords(db, tableName, config.windowTimeSeconds)
          .then((deletedCount) => {
            console.log(`[Rate Limit Cleanup] Background cleanup finished: ${deletedCount} records deleted`);
            return deletedCount;
          })
          .catch((error) => {
            console.error('[Rate Limit Cleanup] Background cleanup failed:', error instanceof Error ? error.message : String(error));
          });

        if (config.ctx && config.ctx.waitUntil) {
          // Cloudflare Workers context available, use waitUntil
          config.ctx.waitUntil(cleanupPromise);
          console.log(`[Rate Limit Cleanup] Cleanup scheduled in background (using ctx.waitUntil)`);
        } else {
          // No context available, cleanup may be interrupted
          console.warn(`[Rate Limit Cleanup] No ctx.waitUntil available, cleanup may be interrupted`);
        }
      }
    };

    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO ${tableName} (IP_HASH, IP_RANGE, IP_ADDR, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertResult = await insertStmt.bind(ipHash, ipSubnet, JSON.stringify([ip]), 1, now, null).run();
    if (insertResult.meta?.changes > 0) {
      triggerCleanup();
      return { allowed: true };
    }

    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const stmt = db.prepare(
        `SELECT IP_HASH, IP_RANGE, IP_ADDR, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL
         FROM ${tableName}
         WHERE IP_HASH = ?`
      );
      const result = await stmt.bind(ipHash).first();

      if (!result) {
        const retryInsert = await insertStmt.bind(ipHash, ipSubnet, JSON.stringify([ip]), 1, now, null).run();
        if (retryInsert.meta?.changes > 0) {
          triggerCleanup();
          return { allowed: true };
        }
        console.warn(`[Rate Limit] D1 insert race on attempt ${attempt + 1} for hash ${ipHash}`);
        continue;
      }

      const lastWindowTime = Number.parseInt(result.LAST_WINDOW_TIME, 10);
      const currentCount = Number.parseInt(result.ACCESS_COUNT, 10);
      const diff = now - lastWindowTime;
      const blockUntil = result.BLOCK_UNTIL ? Number.parseInt(result.BLOCK_UNTIL, 10) : null;

      let existingIPs = [];
      try {
        const parsed = JSON.parse(result.IP_ADDR || '[]');
        if (Array.isArray(parsed)) {
          existingIPs = parsed;
        }
      } catch (error) {
        existingIPs = [];
      }

      if (blockUntil && blockUntil > now) {
        const retryAfter = blockUntil - now;
        return {
          allowed: false,
          ipSubnet,
          retryAfter: Math.max(1, retryAfter),
        };
      }

      const baseParams = [ipHash, currentCount, lastWindowTime, result.IP_ADDR || '[]'];
      const whereClause = blockUntil === null
        ? 'IP_HASH = ? AND ACCESS_COUNT = ? AND LAST_WINDOW_TIME = ? AND IP_ADDR = ? AND BLOCK_UNTIL IS NULL'
        : 'IP_HASH = ? AND ACCESS_COUNT = ? AND LAST_WINDOW_TIME = ? AND IP_ADDR = ? AND BLOCK_UNTIL = ?';
      const whereParams = blockUntil === null ? baseParams : [...baseParams, blockUntil];

      const runConditionalUpdate = async (sql, params, cleanupNeeded, responsePayload, debugContext) => {
        const updateStmt = db.prepare(sql);
        const updateResult = await updateStmt.bind(...params).run();
        if (updateResult.meta?.changes > 0) {
          if (cleanupNeeded) {
            triggerCleanup();
          }
          return responsePayload;
        }
        console.warn(`[Rate Limit] D1 ${debugContext} concurrency retry ${attempt + 1} for hash ${ipHash}`);
        return null;
      };

      if (blockUntil && blockUntil <= now) {
        const sql = `UPDATE ${tableName}
                     SET ACCESS_COUNT = ?, LAST_WINDOW_TIME = ?, IP_ADDR = ?, BLOCK_UNTIL = NULL
                     WHERE ${whereClause}`;
        const params = [1, now, JSON.stringify([ip]), ...whereParams];
        const resultUpdate = await runConditionalUpdate(sql, params, true, { allowed: true }, 'block reset');
        if (resultUpdate) return resultUpdate;
        continue;
      }

      if (diff >= config.windowTimeSeconds) {
        const sql = `UPDATE ${tableName}
                     SET ACCESS_COUNT = ?, LAST_WINDOW_TIME = ?, IP_ADDR = ?, BLOCK_UNTIL = NULL
                     WHERE ${whereClause}`;
        const params = [1, now, JSON.stringify([ip]), ...whereParams];
        const resultUpdate = await runConditionalUpdate(sql, params, true, { allowed: true }, 'window reset');
        if (resultUpdate) return resultUpdate;
        continue;
      }

      if (currentCount >= config.limit) {
        const blockTimeSeconds = config.blockTimeSeconds || 0;
        if (blockTimeSeconds > 0) {
          const newBlockUntil = now + blockTimeSeconds;
          const sql = `UPDATE ${tableName}
                       SET BLOCK_UNTIL = ?
                       WHERE ${whereClause}`;
          const params = [newBlockUntil, ...whereParams];
          const resultUpdate = await runConditionalUpdate(sql, params, false, {
            allowed: false,
            ipSubnet,
            retryAfter: Math.max(1, blockTimeSeconds),
          }, 'block time set');
          if (resultUpdate) return resultUpdate;
          continue;
        }
        const retryAfter = config.windowTimeSeconds - diff;
        return {
          allowed: false,
          ipSubnet,
          retryAfter: Math.max(1, retryAfter),
        };
      }

      const shouldUpdateIPs = !existingIPs.includes(ip);
      const nextIPs = shouldUpdateIPs ? [...existingIPs, ip] : existingIPs;
      const sql = `UPDATE ${tableName}
                   SET ACCESS_COUNT = ?, LAST_WINDOW_TIME = ?, IP_ADDR = ?, BLOCK_UNTIL = ?
                   WHERE ${whereClause}`;
      const params = [
        currentCount + 1,
        lastWindowTime,
        JSON.stringify(nextIPs),
        blockUntil,
        ...whereParams,
      ];
      const resultUpdate = await runConditionalUpdate(sql, params, true, { allowed: true }, 'counter increment');
      if (resultUpdate) return resultUpdate;
    }

    throw new Error('D1 concurrency retry limit exceeded');
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
