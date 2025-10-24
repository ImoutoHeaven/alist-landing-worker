import { calculateIPSubnet, sha256Hash } from '../utils.js';

/**
 * Sleep for a random duration (exponential backoff with jitter)
 * @param {number} attempt - Current retry attempt number (0-indexed)
 * @returns {Promise<void>}
 */
const randomBackoff = async (attempt) => {
  // Linear backoff with jitter: delay = random(1, min(attempt * 5, 50)) ms
  // attempt 0: 1-5ms, attempt 1: 1-10ms, attempt 2: 1-15ms, ..., max 1-50ms
  const maxDelay = Math.min((attempt + 1) * 5, 50);
  const delay = Math.floor(Math.random() * maxDelay) + 1;
  await new Promise(resolve => setTimeout(resolve, delay));
};

/**
 * Execute query via PostgREST API
 * @param {string} postgrestUrl - PostgREST API base URL
 * @param {string} verifyHeader - Authentication header name
 * @param {string} verifySecret - Authentication header value
 * @param {string} tableName - Table name
 * @param {string} method - HTTP method (GET, POST, PATCH, DELETE)
 * @param {string} filters - URL query filters (for GET/PATCH/DELETE)
 * @param {Object} body - Request body (for POST/PATCH)
 * @param {Object} extraHeaders - Additional headers
 * @returns {Promise<Object>} - Query result
 */
const executeQuery = async (postgrestUrl, verifyHeader, verifySecret, tableName, method, filters = '', body = null, extraHeaders = {}) => {
  const url = `${postgrestUrl}/${tableName}${filters ? `?${filters}` : ''}`;

  const headers = {
    [verifyHeader]: verifySecret,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  const options = {
    method,
    headers,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();

    // Check if table doesn't exist (PGRST205 error)
    if (response.status === 404 && errorText.includes('PGRST205')) {
      throw new Error(
        `PostgREST table not found: "${tableName}". ` +
        `Please create the table manually in your PostgreSQL database:\n` +
        `CREATE TABLE ${tableName} (\n` +
        `  IP_HASH TEXT PRIMARY KEY,\n` +
        `  IP_RANGE TEXT NOT NULL,\n` +
        `  IP_ADDR TEXT NOT NULL,\n` +
        `  ACCESS_COUNT INTEGER NOT NULL,\n` +
        `  LAST_WINDOW_TIME INTEGER NOT NULL,\n` +
        `  BLOCK_UNTIL INTEGER\n` +
        `);`
      );
    }

    throw new Error(`PostgREST API error (${response.status}): ${errorText}`);
  }

  // For POST/PATCH/DELETE, PostgREST returns the affected rows or empty
  // For GET, it returns an array of rows
  let result;
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    result = await response.json();
  } else {
    result = [];
  }

  // Get Content-Range header to determine affected rows count
  const contentRange = response.headers.get('content-range');
  let affectedRows = 0;
  if (contentRange) {
    // Content-Range format: "0-4/*" or "*/0" (no matches)
    const match = contentRange.match(/(\d+)-(\d+)|\*\/(\d+)/);
    if (match) {
      if (match[1] !== undefined && match[2] !== undefined) {
        affectedRows = parseInt(match[2], 10) - parseInt(match[1], 10) + 1;
      } else if (match[3] !== undefined) {
        affectedRows = parseInt(match[3], 10);
      }
    }
  } else if (method === 'POST' && response.status === 201) {
    // POST successful, assume 1 row inserted
    affectedRows = 1;
  } else if (method === 'PATCH' || method === 'DELETE') {
    // For PATCH/DELETE without Prefer: return=representation
    // We need to use Prefer: return=minimal and check if response is empty
    affectedRows = Array.isArray(result) ? result.length : 0;
  }

  return {
    data: Array.isArray(result) ? result : [],
    affectedRows,
  };
};

/**
 * Check and update rate limit for an IP address using PostgREST API
 * @param {string} ip - Client IP address
 * @param {Object} config - Rate limit configuration
 * @param {string} config.postgrestUrl - PostgREST API base URL
 * @param {string} config.verifyHeader - Authentication header name
 * @param {string} config.verifySecret - Authentication header value
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
  if (!config.postgrestUrl || !config.verifyHeader || !config.verifySecret || !config.windowTimeSeconds || !config.limit) {
    return { allowed: true };
  }

  if (!ip || typeof ip !== 'string') {
    return { allowed: true };
  }

  try {
    const { postgrestUrl, verifyHeader, verifySecret } = config;
    const tableName = config.tableName || 'IP_LIMIT_TABLE';

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
        const cleanupPromise = cleanupExpiredRecords(postgrestUrl, verifyHeader, verifySecret, tableName, config.windowTimeSeconds)
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

    // Try to insert new record (ignore if exists)
    const insertResult = await executeQuery(
      postgrestUrl,
      verifyHeader,
      verifySecret,
      tableName,
      'POST',
      '',
      {
        IP_HASH: ipHash,
        IP_RANGE: ipSubnet,
        IP_ADDR: JSON.stringify([ip]),
        ACCESS_COUNT: 1,
        LAST_WINDOW_TIME: now,
        BLOCK_UNTIL: null,
      },
      { 'Prefer': 'resolution=ignore-duplicates' }
    );

    const inserted = insertResult.affectedRows > 0;
    if (inserted) {
      triggerCleanup();
      return { allowed: true };
    }

    // Record exists, use optimistic locking with retry
    const maxAttempts = 15; // Increased from 5 to handle high concurrency
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // Add random backoff before retry (except first attempt)
      if (attempt > 0) {
        await randomBackoff(attempt - 1);
      }
      // Fetch current record
      const selectFilters = `IP_HASH=eq.${ipHash}&select=IP_HASH,IP_RANGE,IP_ADDR,ACCESS_COUNT,LAST_WINDOW_TIME,BLOCK_UNTIL`;
      const queryResult = await executeQuery(
        postgrestUrl,
        verifyHeader,
        verifySecret,
        tableName,
        'GET',
        selectFilters
      );

      const records = queryResult.data || [];

      if (!records || records.length === 0) {
        // Record disappeared (race condition), try insert again
        const retryInsert = await executeQuery(
          postgrestUrl,
          verifyHeader,
          verifySecret,
          tableName,
          'POST',
          '',
          {
            IP_HASH: ipHash,
            IP_RANGE: ipSubnet,
            IP_ADDR: JSON.stringify([ip]),
            ACCESS_COUNT: 1,
            LAST_WINDOW_TIME: now,
            BLOCK_UNTIL: null,
          },
          { 'Prefer': 'resolution=ignore-duplicates' }
        );
        if (retryInsert.affectedRows > 0) {
          triggerCleanup();
          return { allowed: true };
        }
        console.warn(`[Rate Limit] PostgREST insert race on attempt ${attempt + 1} for hash ${ipHash}`);
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

      // Check if currently blocked
      if (blockUntil && blockUntil > now) {
        const retryAfter = blockUntil - now;
        return {
          allowed: false,
          ipSubnet,
          retryAfter: Math.max(1, retryAfter),
        };
      }

      // Build optimistic lock filters (match all current field values)
      const buildOptimisticLockFilters = () => {
        const filters = [
          `IP_HASH=eq.${ipHash}`,
          `ACCESS_COUNT=eq.${currentCount}`,
          `LAST_WINDOW_TIME=eq.${lastWindowTime}`,
          `IP_ADDR=eq.${encodeURIComponent(ipAddrJson)}`,
        ];
        if (blockUntil === null) {
          filters.push('BLOCK_UNTIL=is.null');
        } else {
          filters.push(`BLOCK_UNTIL=eq.${blockUntil}`);
        }
        return filters.join('&');
      };

      const updateAndReturn = async (filters, updateBody, cleanupNeeded, responsePayload, debugContext) => {
        const updateResult = await executeQuery(
          postgrestUrl,
          verifyHeader,
          verifySecret,
          tableName,
          'PATCH',
          filters,
          updateBody,
          { 'Prefer': 'return=representation' }
        );
        if (updateResult.affectedRows > 0) {
          if (cleanupNeeded) {
            triggerCleanup();
          }
          return responsePayload;
        }
        console.warn(`[Rate Limit] PostgREST ${debugContext} concurrency retry ${attempt + 1} for hash ${ipHash}`);
        return null;
      };

      // Case 1: Block expired, reset to new window
      if (blockUntil && blockUntil <= now) {
        const filters = buildOptimisticLockFilters();
        const updateBody = {
          ACCESS_COUNT: 1,
          LAST_WINDOW_TIME: now,
          IP_ADDR: JSON.stringify([ip]),
          BLOCK_UNTIL: null,
        };
        const result = await updateAndReturn(filters, updateBody, true, { allowed: true }, 'block reset');
        if (result) return result;
        continue;
      }

      // Case 2: Window expired, reset to new window
      if (diff >= config.windowTimeSeconds) {
        const filters = buildOptimisticLockFilters();
        const updateBody = {
          ACCESS_COUNT: 1,
          LAST_WINDOW_TIME: now,
          IP_ADDR: JSON.stringify([ip]),
          BLOCK_UNTIL: null,
        };
        const result = await updateAndReturn(filters, updateBody, true, { allowed: true }, 'window reset');
        if (result) return result;
        continue;
      }

      // Case 3: Limit exceeded
      if (currentCount >= config.limit) {
        const blockTimeSeconds = config.blockTimeSeconds || 0;
        if (blockTimeSeconds > 0) {
          const newBlockUntil = now + blockTimeSeconds;
          const filters = buildOptimisticLockFilters();
          const updateBody = {
            BLOCK_UNTIL: newBlockUntil,
          };
          const result = await updateAndReturn(filters, updateBody, false, {
            allowed: false,
            ipSubnet,
            retryAfter: Math.max(1, blockTimeSeconds),
          }, 'block time set');
          if (result) return result;
          continue;
        }

        // No block time configured, just return rate limit exceeded
        const retryAfter = config.windowTimeSeconds - diff;
        return {
          allowed: false,
          ipSubnet,
          retryAfter: Math.max(1, retryAfter),
        };
      }

      // Case 4: Increment counter
      const shouldUpdateIPs = !existingIPs.includes(ip);
      const nextIPs = shouldUpdateIPs ? [...existingIPs, ip] : existingIPs;
      const newIPJson = JSON.stringify(nextIPs);
      const filters = buildOptimisticLockFilters();
      const updateBody = {
        ACCESS_COUNT: currentCount + 1,
        IP_ADDR: newIPJson,
      };
      const result = await updateAndReturn(filters, updateBody, true, { allowed: true }, 'counter increment');
      if (result) return result;
    }

    throw new Error('PostgREST concurrency retry limit exceeded');
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
 * @param {string} postgrestUrl - PostgREST API base URL
 * @param {string} verifyHeader - Authentication header name
 * @param {string} verifySecret - Authentication header value
 * @param {string} tableName - Table name
 * @param {number} windowTimeSeconds - Time window in seconds
 * @returns {Promise<number>} - Number of deleted records
 */
const cleanupExpiredRecords = async (postgrestUrl, verifyHeader, verifySecret, tableName, windowTimeSeconds) => {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTime = now - (windowTimeSeconds * 2);

  try {
    console.log(`[Rate Limit Cleanup] Executing DELETE query (cutoff: ${cutoffTime}, windowTime: ${windowTimeSeconds}s)`);

    // Delete records where:
    // 1. LAST_WINDOW_TIME is older than cutoff (window expired)
    // 2. AND (BLOCK_UNTIL is NULL OR BLOCK_UNTIL has expired)
    // This ensures we don't delete records that are still blocked
    // PostgREST filter syntax: LAST_WINDOW_TIME=lt.{cutoff}&and=(BLOCK_UNTIL.is.null,BLOCK_UNTIL.lt.{now})
    const filters = `LAST_WINDOW_TIME=lt.${cutoffTime}&and=(BLOCK_UNTIL.is.null,BLOCK_UNTIL.lt.${now})`;

    const result = await executeQuery(
      postgrestUrl,
      verifyHeader,
      verifySecret,
      tableName,
      'DELETE',
      filters,
      null,
      { 'Prefer': 'return=representation' }
    );

    const deletedCount = result.affectedRows || 0;
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
