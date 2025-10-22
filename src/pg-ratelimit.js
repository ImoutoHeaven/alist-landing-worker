import { neon } from '@neondatabase/serverless';
import { calculateIPSubnet, sha256Hash } from './utils.js';

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
      LAST_WINDOW_TIME INTEGER NOT NULL
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
      SELECT IP_HASH, IP_RANGE, ACCESS_COUNT, LAST_WINDOW_TIME
      FROM IP_LIMIT_TABLE
      WHERE IP_HASH = ${ipHash}
    `;

    // If no record exists, create a new one
    if (!records || records.length === 0) {
      await sql`
        INSERT INTO IP_LIMIT_TABLE (IP_HASH, IP_RANGE, ACCESS_COUNT, LAST_WINDOW_TIME)
        VALUES (${ipHash}, ${ipSubnet}, 1, ${now})
      `;
      return { allowed: true };
    }

    // Record exists, check time window
    const record = records[0];
    const lastWindowTime = Number.parseInt(record.last_window_time, 10);
    const currentCount = Number.parseInt(record.access_count, 10);
    const diff = now - lastWindowTime;

    // If time window has expired, reset count
    if (diff >= config.windowTimeSeconds) {
      await sql`
        UPDATE IP_LIMIT_TABLE
        SET ACCESS_COUNT = 1, LAST_WINDOW_TIME = ${now}
        WHERE IP_HASH = ${ipHash}
      `;
      return { allowed: true };
    }

    // Within time window
    // Check if current count has reached the limit (before incrementing)
    if (currentCount >= config.limit) {
      // Rate limit exceeded, do not increment count
      const retryAfter = config.windowTimeSeconds - diff;
      return {
        allowed: false,
        ipSubnet,
        retryAfter: Math.max(1, retryAfter), // Ensure at least 1 second
      };
    }

    // Still within limit, increment count
    await sql`
      UPDATE IP_LIMIT_TABLE
      SET ACCESS_COUNT = ACCESS_COUNT + 1
      WHERE IP_HASH = ${ipHash}
    `;

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
