import { calculateIPSubnet, sha256Hash, applyVerifyHeaders, hasVerifyCredentials } from '../utils.js';

/**
 * Execute query via PostgREST API
 * @param {string} postgrestUrl - PostgREST API base URL
 * @param {string|string[]} verifyHeader - Authentication header name(s)
 * @param {string|string[]} verifySecret - Authentication header value(s)
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
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  applyVerifyHeaders(headers, verifyHeader, verifySecret);

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
        `Please create the table manually using init.sql:\n` +
        `CREATE TABLE ${tableName} (\n` +
        `  IP_HASH TEXT PRIMARY KEY,\n` +
        `  IP_RANGE TEXT NOT NULL,\n` +
        `  ACCESS_COUNT INTEGER NOT NULL,\n` +
        `  LAST_WINDOW_TIME INTEGER NOT NULL,\n` +
        `  BLOCK_UNTIL INTEGER\n` +
        `);\n` +
        `\nAlso run: CREATE OR REPLACE FUNCTION upsert_rate_limit(...) (see init.sql)`
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
 * Check and update rate limit for an IP address using PostgREST RPC
 *
 * Uses the upsert_rate_limit stored procedure for atomic rate limit operations.
 * No optimistic locking or retry loops needed - the database handles all concurrency.
 *
 * @param {string} ip - Client IP address
 * @param {string} path - Requested file path
 * @param {Object} config - Rate limit configuration
 * @param {string} config.postgrestUrl - PostgREST API base URL
 * @param {string|string[]} config.verifyHeader - Authentication header name(s)
 * @param {string|string[]} config.verifySecret - Authentication header value(s)
 * @param {string} config.tableName - Table name (defaults to 'IP_LIMIT_TABLE', used for cleanup only)
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
  if (!config?.postgrestUrl || !hasVerifyCredentials(config.verifyHeader, config.verifySecret) || !ip || typeof ip !== 'string') {
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
    const { postgrestUrl, verifyHeader, verifySecret } = config;
    const tableName = config.tableName || 'IP_LIMIT_TABLE';
    const fileTableName = config.fileTableName || 'IP_FILE_LIMIT_TABLE';

    const ipSubnet = calculateIPSubnet(ip, config.ipv4Suffix, config.ipv6Suffix);
    if (!ipSubnet) {
      return { allowed: true, ipAllowed: true, fileAllowed: true };
    }

    const ipHash = await sha256Hash(ipSubnet);
    if (!ipHash) {
      return { allowed: true, ipAllowed: true, fileAllowed: true };
    }

    const pathHash = normalizedPath ? await sha256Hash(normalizedPath) : '';
    if (fileCheckEnabled && !pathHash) {
      fileCheckEnabled = false;
    }

    const now = Math.floor(Date.now() / 1000);

    const rpcUrl = `${postgrestUrl}/rpc/landing_unified_check`;
    const rpcBody = {
      p_path_hash: pathHash || ipHash,
      p_cache_ttl: 0,
      p_cache_table_name: 'FILESIZE_CACHE_TABLE',
      p_ip_hash: ipHash,
      p_ip_range: ipSubnet,
      p_now: now,
      p_window_seconds: ipCheckEnabled ? ipWindowSeconds : 0,
      p_limit: ipCheckEnabled ? ipLimitValue : 0,
      p_block_seconds: config.blockTimeSeconds || 0,
      p_ratelimit_table_name: tableName,
      p_file_limit: fileCheckEnabled ? fileLimitValue : 0,
      p_file_window_seconds: fileCheckEnabled ? fileWindowSeconds : 0,
      p_file_block_seconds: config.fileBlockTimeSeconds || 0,
      p_file_limit_table_name: fileTableName,
      p_token_hash: null,
      p_token_ip: null,
      p_token_ttl: 0,
      p_token_table_name: config.tokenTableName || 'TURNSTILE_TOKEN_BINDING',
      p_filepath_hash: pathHash || ipHash,
      p_altcha_token_hash: null,
      p_altcha_token_ip: null,
      p_altcha_filepath_hash: pathHash || ipHash,
      p_altcha_table_name: config.altchaTableName || 'ALTCHA_TOKEN_LIST',
    };

    const rpcHeaders = {
      'Content-Type': 'application/json',
    };
    applyVerifyHeaders(rpcHeaders, verifyHeader, verifySecret);

    const rpcResponse = await fetch(rpcUrl, {
      method: 'POST',
      headers: rpcHeaders,
      body: JSON.stringify(rpcBody),
    });

    if (!rpcResponse.ok) {
      const errorText = await rpcResponse.text();
      throw new Error(`PostgREST RPC error (${rpcResponse.status}): ${errorText}`);
    }

    const rpcResult = await rpcResponse.json();
    if (!Array.isArray(rpcResult) || rpcResult.length === 0) {
      throw new Error('landing_unified_check returned no rows');
    }

    const row = rpcResult[0];
    const rateAccessCount = row.rate_access_count !== null ? Number.parseInt(row.rate_access_count, 10) : null;
    const rateLastWindowTime = row.rate_last_window_time !== null ? Number.parseInt(row.rate_last_window_time, 10) : null;
    const rateBlockUntil = row.rate_block_until !== null ? Number.parseInt(row.rate_block_until, 10) : null;
    const fileAccessCount = row.file_access_count !== null ? Number.parseInt(row.file_access_count, 10) : null;
    const fileLastWindowTime = row.file_last_window_time !== null ? Number.parseInt(row.file_last_window_time, 10) : null;
    const fileBlockUntil = row.file_block_until !== null ? Number.parseInt(row.file_block_until, 10) : null;

    let ipAllowed = true;
    let ipRetryAfter = null;
    if (ipCheckEnabled && Number.isFinite(ipLimitValue) && ipLimitValue > 0) {
      if (Number.isFinite(rateBlockUntil) && rateBlockUntil > now) {
        ipAllowed = false;
        ipRetryAfter = Math.max(1, rateBlockUntil - now);
      } else if (Number.isFinite(rateAccessCount) && rateAccessCount >= ipLimitValue) {
        const diff = now - (Number.isFinite(rateLastWindowTime) ? rateLastWindowTime : now);
        ipAllowed = false;
        ipRetryAfter = Math.max(1, ipWindowSeconds - diff);
      }
    }

    let fileAllowed = true;
    let fileRetryAfter = null;
    if (fileCheckEnabled && Number.isFinite(fileLimitValue) && fileLimitValue > 0) {
      if (Number.isFinite(fileBlockUntil) && fileBlockUntil > now) {
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
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (config.pgErrorHandle === 'fail-open') {
      console.error('Rate limit check failed (fail-open):', errorMessage);
      return { allowed: true, ipAllowed: true, fileAllowed: true };
    }

    return {
      allowed: false,
      ipAllowed: false,
      fileAllowed: true,
      error: `Rate limit check failed: ${errorMessage}`,
    };
  }
};

/**
 * Clean up expired records from the database
 * Removes records older than windowTimeSeconds * 2 (double buffer)
 * Respects BLOCK_UNTIL: does NOT delete records that are still blocked
 * @param {string} postgrestUrl - PostgREST API base URL
 * @param {string|string[]} verifyHeader - Authentication header name(s)
 * @param {string|string[]} verifySecret - Authentication header value(s)
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
      { Prefer: 'return=representation' }
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
