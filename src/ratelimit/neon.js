import { neon } from '@neondatabase/serverless';
import { calculateIPSubnet, sha256Hash } from '../utils.js';

/**
 * Ensure the IP_LIMIT_TABLE exists in the database
 * @param {Function} sql - Neon SQL function
 * @returns {Promise<void>}
 */
const ensureTable = async (sql) => {
  await sql`
    CREATE TABLE IF NOT EXISTS IP_LIMIT_TABLE (
      IP_HASH TEXT PRIMARY KEY,
      IP_RANGE TEXT NOT NULL,
      ACCESS_COUNT INTEGER NOT NULL,
      LAST_WINDOW_TIME INTEGER NOT NULL,
      BLOCK_UNTIL INTEGER
    )
  `;
};

/**
 * Check and update rate limit for an IP address
 * @param {string} ip - Client IP address
 * @param {Object} config - Rate limit configuration
 * @param {string} config.postgresUrl - PostgreSQL connection URL
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
  if (!config.postgresUrl || !config.windowTimeSeconds || !config.limit) {
    return { allowed: true };
  }

  if (!ip || typeof ip !== 'string') {
    return { allowed: true };
  }

  try {
    // Initialize Neon SQL client
    const sql = neon(config.postgresUrl);

    // Ensure table exists
    await ensureTable(sql);

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

    // Probabilistic cleanup helper
    const triggerCleanup = () => {
      // Use configured cleanup probability (default 1% = 0.01)
      const probability = config.cleanupProbability || 0.01;
      if (Math.random() < probability) {
        console.log(`[Rate Limit Cleanup] Triggered cleanup (probability: ${probability * 100}%)`);

        // Use ctx.waitUntil to ensure cleanup completes even after response is sent
        const cleanupPromise = cleanupExpiredRecords(sql, config.windowTimeSeconds)
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

    // Atomic UPSERT with RETURNING - single database round-trip, no locks needed
    // Parameters: $1=ipHash, $2=ipSubnet, $3=now, $4=windowTimeSeconds, $5=limit, $6=blockTimeSeconds
    const result = await sql`
      INSERT INTO IP_LIMIT_TABLE (IP_HASH, IP_RANGE, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL)
      VALUES (${ipHash}, ${ipSubnet}, 1, ${now}, NULL)
      ON CONFLICT (IP_HASH) DO UPDATE SET
        ACCESS_COUNT = CASE
          WHEN ${now} - IP_LIMIT_TABLE.LAST_WINDOW_TIME >= ${config.windowTimeSeconds} THEN 1
          WHEN IP_LIMIT_TABLE.BLOCK_UNTIL IS NOT NULL AND IP_LIMIT_TABLE.BLOCK_UNTIL <= ${now} THEN 1
          WHEN IP_LIMIT_TABLE.ACCESS_COUNT >= ${config.limit} THEN IP_LIMIT_TABLE.ACCESS_COUNT
          ELSE IP_LIMIT_TABLE.ACCESS_COUNT + 1
        END,
        LAST_WINDOW_TIME = CASE
          WHEN ${now} - IP_LIMIT_TABLE.LAST_WINDOW_TIME >= ${config.windowTimeSeconds} THEN ${now}
          WHEN IP_LIMIT_TABLE.BLOCK_UNTIL IS NOT NULL AND IP_LIMIT_TABLE.BLOCK_UNTIL <= ${now} THEN ${now}
          ELSE IP_LIMIT_TABLE.LAST_WINDOW_TIME
        END,
        BLOCK_UNTIL = CASE
          WHEN ${now} - IP_LIMIT_TABLE.LAST_WINDOW_TIME >= ${config.windowTimeSeconds} THEN NULL
          WHEN IP_LIMIT_TABLE.BLOCK_UNTIL IS NOT NULL AND IP_LIMIT_TABLE.BLOCK_UNTIL <= ${now} THEN NULL
          WHEN IP_LIMIT_TABLE.ACCESS_COUNT >= ${config.limit} AND ${config.blockTimeSeconds || 0} > 0
            THEN ${now} + ${config.blockTimeSeconds || 0}
          ELSE IP_LIMIT_TABLE.BLOCK_UNTIL
        END
      RETURNING ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL
    `;

    if (!result || result.length === 0) {
      throw new Error('UPSERT returned no rows');
    }

    // Parse RETURNING result
    const row = result[0];
    const accessCount = Number.parseInt(row.access_count, 10);
    const lastWindowTime = Number.parseInt(row.last_window_time, 10);
    const blockUntil = row.block_until ? Number.parseInt(row.block_until, 10) : null;

    // Trigger cleanup probabilistically
    triggerCleanup();

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
    if (accessCount > config.limit) {
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
    // Handle errors based on PG_ERROR_HANDLE strategy
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
 * @param {Function} sql - Neon SQL function
 * @param {number} windowTimeSeconds - Time window in seconds
 * @returns {Promise<number>} - Number of deleted records
 */
const cleanupExpiredRecords = async (sql, windowTimeSeconds) => {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTime = now - (windowTimeSeconds * 2);

  try {
    console.log(`[Rate Limit Cleanup] Executing DELETE query (cutoff: ${cutoffTime}, windowTime: ${windowTimeSeconds}s)`);

    // Delete records where:
    // 1. LAST_WINDOW_TIME is older than cutoff (window expired)
    // 2. AND (BLOCK_UNTIL is NULL OR BLOCK_UNTIL has expired)
    // This ensures we don't delete records that are still blocked
    const result = await sql`
      DELETE FROM IP_LIMIT_TABLE
      WHERE LAST_WINDOW_TIME < ${cutoffTime}
        AND (BLOCK_UNTIL IS NULL OR BLOCK_UNTIL < ${now})
    `;

    const deletedCount = result.count || 0;
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
