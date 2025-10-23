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
      IP_ADDR TEXT NOT NULL,
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

    // Query for existing record
    const records = await sql`
      SELECT IP_HASH, IP_RANGE, IP_ADDR, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL
      FROM IP_LIMIT_TABLE
      WHERE IP_HASH = ${ipHash}
    `;

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

    // If no record exists, create a new one
    if (!records || records.length === 0) {
      await sql`
        INSERT INTO IP_LIMIT_TABLE (IP_HASH, IP_RANGE, IP_ADDR, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL)
        VALUES (${ipHash}, ${ipSubnet}, ${JSON.stringify([ip])}, 1, ${now}, NULL)
      `;
      triggerCleanup();
      return { allowed: true };
    }

    // Record exists, check time window
    const record = records[0];
    const lastWindowTime = Number.parseInt(record.last_window_time, 10);
    const currentCount = Number.parseInt(record.access_count, 10);
    const diff = now - lastWindowTime;
    const blockUntil = record.block_until ? Number.parseInt(record.block_until, 10) : null;

    // Priority 1: Check if IP is currently blocked (BLOCK_UNTIL)
    if (blockUntil && blockUntil > now) {
      // Still blocked, return 429 with retry after
      const retryAfter = blockUntil - now;
      return {
        allowed: false,
        ipSubnet,
        retryAfter: Math.max(1, retryAfter),
      };
    }

    // Priority 2: If BLOCK_UNTIL has expired, clear it and reset counter
    if (blockUntil && blockUntil <= now) {
      await sql`
        UPDATE IP_LIMIT_TABLE
        SET ACCESS_COUNT = 1, LAST_WINDOW_TIME = ${now}, IP_ADDR = ${JSON.stringify([ip])}, BLOCK_UNTIL = NULL
        WHERE IP_HASH = ${ipHash}
      `;
      triggerCleanup();
      return { allowed: true };
    }

    // Priority 3: If time window has expired, reset count
    if (diff >= config.windowTimeSeconds) {
      await sql`
        UPDATE IP_LIMIT_TABLE
        SET ACCESS_COUNT = 1, LAST_WINDOW_TIME = ${now}, IP_ADDR = ${JSON.stringify([ip])}, BLOCK_UNTIL = NULL
        WHERE IP_HASH = ${ipHash}
      `;
      triggerCleanup();
      return { allowed: true };
    }

    // Priority 4: Within time window, check if limit reached
    if (currentCount >= config.limit) {
      // Rate limit exceeded, set BLOCK_UNTIL if blockTimeSeconds configured
      const blockTimeSeconds = config.blockTimeSeconds || 0;
      if (blockTimeSeconds > 0) {
        const newBlockUntil = now + blockTimeSeconds;
        await sql`
          UPDATE IP_LIMIT_TABLE
          SET BLOCK_UNTIL = ${newBlockUntil}
          WHERE IP_HASH = ${ipHash}
        `;
        const retryAfter = blockTimeSeconds;
        return {
          allowed: false,
          ipSubnet,
          retryAfter: Math.max(1, retryAfter),
        };
      } else {
        // No block time configured, use original behavior
        const retryAfter = config.windowTimeSeconds - diff;
        return {
          allowed: false,
          ipSubnet,
          retryAfter: Math.max(1, retryAfter),
        };
      }
    }

    // Still within limit, increment count
    // Check if we need to update IP_ADDR with new unique IP
    const existingIPs = JSON.parse(record.ip_addr || '[]');
    const shouldUpdateIPs = !existingIPs.includes(ip);

    if (shouldUpdateIPs) {
      const newIPAddr = JSON.stringify([...existingIPs, ip]);
      await sql`
        UPDATE IP_LIMIT_TABLE
        SET ACCESS_COUNT = ACCESS_COUNT + 1, IP_ADDR = ${newIPAddr}
        WHERE IP_HASH = ${ipHash}
      `;
    } else {
      await sql`
        UPDATE IP_LIMIT_TABLE
        SET ACCESS_COUNT = ACCESS_COUNT + 1
        WHERE IP_HASH = ${ipHash}
      `;
    }

    triggerCleanup();
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
