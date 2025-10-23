import { calculateIPSubnet, sha256Hash } from '../utils.js';

/**
 * Execute SQL query via D1 REST API
 * @param {string} accountId - Cloudflare account ID
 * @param {string} databaseId - D1 database ID
 * @param {string} apiToken - Cloudflare API token
 * @param {string} sql - SQL query string
 * @param {Array} params - Query parameters (optional)
 * @returns {Promise<Object>} - Query result
 */
const executeQuery = async (accountId, databaseId, apiToken, sql, params = []) => {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  const body = { sql };
  if (params && params.length > 0) {
    body.params = params;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`D1 REST API error (${response.status}): ${errorText}`);
  }

  const result = await response.json();

  // Cloudflare D1 REST API returns: { success: true, result: [{ results: [...], success: true }] }
  if (!result.success) {
    throw new Error(`D1 REST API query failed: ${JSON.stringify(result.errors || 'Unknown error')}`);
  }

  return result.result?.[0] || { results: [], success: true };
};

/**
 * Ensure the IP_LIMIT_TABLE exists in the database
 * @param {string} accountId - Cloudflare account ID
 * @param {string} databaseId - D1 database ID
 * @param {string} apiToken - Cloudflare API token
 * @param {string} tableName - Table name
 * @returns {Promise<void>}
 */
const ensureTable = async (accountId, databaseId, apiToken, tableName) => {
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
  await executeQuery(accountId, databaseId, apiToken, sql);
};

/**
 * Check and update rate limit for an IP address using D1 REST API
 * @param {string} ip - Client IP address
 * @param {Object} config - Rate limit configuration
 * @param {string} config.accountId - Cloudflare account ID
 * @param {string} config.databaseId - D1 database ID
 * @param {string} config.apiToken - Cloudflare API token
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
  if (!config.accountId || !config.databaseId || !config.apiToken || !config.windowTimeSeconds || !config.limit) {
    return { allowed: true };
  }

  if (!ip || typeof ip !== 'string') {
    return { allowed: true };
  }

  try {
    const { accountId, databaseId, apiToken } = config;
    const tableName = config.tableName || 'IP_LIMIT_TABLE';

    // Ensure table exists
    await ensureTable(accountId, databaseId, apiToken, tableName);

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
        const cleanupPromise = cleanupExpiredRecords(accountId, databaseId, apiToken, tableName, config.windowTimeSeconds)
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

    const insertSql = `INSERT OR IGNORE INTO ${tableName}
                       (IP_HASH, IP_RANGE, IP_ADDR, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL)
                       VALUES (?, ?, ?, ?, ?, ?)`;
    const insertResult = await executeQuery(accountId, databaseId, apiToken, insertSql, [
      ipHash,
      ipSubnet,
      JSON.stringify([ip]),
      1,
      now,
      null
    ]);
    const inserted = insertResult.meta?.changes > 0;
    if (inserted) {
      triggerCleanup();
      return { allowed: true };
    }

    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const selectSql = `SELECT IP_HASH, IP_RANGE, IP_ADDR, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL
                         FROM ${tableName}
                         WHERE IP_HASH = ?`;
      const queryResult = await executeQuery(accountId, databaseId, apiToken, selectSql, [ipHash]);
      const records = queryResult.results || [];

      if (!records || records.length === 0) {
        const retryInsert = await executeQuery(accountId, databaseId, apiToken, insertSql, [
          ipHash,
          ipSubnet,
          JSON.stringify([ip]),
          1,
          now,
          null
        ]);
        if (retryInsert.meta?.changes > 0) {
          triggerCleanup();
          return { allowed: true };
        }
        console.warn(`[Rate Limit] D1 REST insert race on attempt ${attempt + 1} for hash ${ipHash}`);
        continue;
      }

      const record = records[0];
      const lastWindowTime = Number.parseInt(record.LAST_WINDOW_TIME, 10);
      const currentCount = Number.parseInt(record.ACCESS_COUNT, 10);
      const diff = now - lastWindowTime;
      const blockUntil = record.BLOCK_UNTIL ? Number.parseInt(record.BLOCK_UNTIL, 10) : null;
      const ipAddrJson = record.IP_ADDR || '[]';

      let existingIPs = [];
      try {
        const parsed = JSON.parse(ipAddrJson);
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

      const whereParts = [
        'IP_HASH = ?',
        'ACCESS_COUNT = ?',
        'LAST_WINDOW_TIME = ?',
        'IP_ADDR = ?',
      ];
      const whereParams = [ipHash, currentCount, lastWindowTime, ipAddrJson];
      if (blockUntil === null) {
        whereParts.push('BLOCK_UNTIL IS NULL');
      } else {
        whereParts.push('BLOCK_UNTIL = ?');
        whereParams.push(blockUntil);
      }
      const whereClause = whereParts.join(' AND ');

      const updateAndReturn = async (sql, params, cleanupNeeded, responsePayload, debugContext) => {
        const updateResult = await executeQuery(accountId, databaseId, apiToken, sql, params);
        if (updateResult.meta?.changes > 0) {
          if (cleanupNeeded) {
            triggerCleanup();
          }
          return responsePayload;
        }
        console.warn(`[Rate Limit] D1 REST ${debugContext} concurrency retry ${attempt + 1} for hash ${ipHash}`);
        return null;
      };

      if (blockUntil && blockUntil <= now) {
        const updateSql = `UPDATE ${tableName}
                           SET ACCESS_COUNT = ?, LAST_WINDOW_TIME = ?, IP_ADDR = ?, BLOCK_UNTIL = NULL
                           WHERE ${whereClause}`;
        const params = [1, now, JSON.stringify([ip]), ...whereParams];
        const result = await updateAndReturn(updateSql, params, true, { allowed: true }, 'block reset');
        if (result) return result;
        continue;
      }

      if (diff >= config.windowTimeSeconds) {
        const updateSql = `UPDATE ${tableName}
                           SET ACCESS_COUNT = ?, LAST_WINDOW_TIME = ?, IP_ADDR = ?, BLOCK_UNTIL = NULL
                           WHERE ${whereClause}`;
        const params = [1, now, JSON.stringify([ip]), ...whereParams];
        const result = await updateAndReturn(updateSql, params, true, { allowed: true }, 'window reset');
        if (result) return result;
        continue;
      }

      if (currentCount >= config.limit) {
        const blockTimeSeconds = config.blockTimeSeconds || 0;
        if (blockTimeSeconds > 0) {
          const newBlockUntil = now + blockTimeSeconds;
          const updateSql = `UPDATE ${tableName}
                             SET BLOCK_UNTIL = ?
                             WHERE ${whereClause}`;
          const params = [newBlockUntil, ...whereParams];
          const result = await updateAndReturn(updateSql, params, false, {
            allowed: false,
            ipSubnet,
            retryAfter: Math.max(1, blockTimeSeconds),
          }, 'block time set');
          if (result) return result;
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
      const newIPJson = JSON.stringify(nextIPs);
      const updateSql = `UPDATE ${tableName}
                         SET ACCESS_COUNT = ?, LAST_WINDOW_TIME = ?, IP_ADDR = ?, BLOCK_UNTIL = ?
                         WHERE ${whereClause}`;
      const params = [
        currentCount + 1,
        lastWindowTime,
        newIPJson,
        blockUntil,
        ...whereParams,
      ];
      const result = await updateAndReturn(updateSql, params, true, { allowed: true }, 'counter increment');
      if (result) return result;
    }

    throw new Error('D1 REST concurrency retry limit exceeded');
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
 * @param {string} accountId - Cloudflare account ID
 * @param {string} databaseId - D1 database ID
 * @param {string} apiToken - Cloudflare API token
 * @param {string} tableName - Table name
 * @param {number} windowTimeSeconds - Time window in seconds
 * @returns {Promise<number>} - Number of deleted records
 */
const cleanupExpiredRecords = async (accountId, databaseId, apiToken, tableName, windowTimeSeconds) => {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTime = now - (windowTimeSeconds * 2);

  try {
    console.log(`[Rate Limit Cleanup] Executing DELETE query (cutoff: ${cutoffTime}, windowTime: ${windowTimeSeconds}s)`);

    // Delete records where:
    // 1. LAST_WINDOW_TIME is older than cutoff (window expired)
    // 2. AND (BLOCK_UNTIL is NULL OR BLOCK_UNTIL has expired)
    // This ensures we don't delete records that are still blocked
    const deleteSql = `DELETE FROM ${tableName}
                       WHERE LAST_WINDOW_TIME < ?
                         AND (BLOCK_UNTIL IS NULL OR BLOCK_UNTIL < ?)`;
    const result = await executeQuery(accountId, databaseId, apiToken, deleteSql, [cutoffTime, now]);

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
