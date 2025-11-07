/**
 * Rate Limiter Interface
 *
 * All rate limiter implementations must conform to this interface.
 *
 * ## Implementation Notes (Post-Atomic Refactoring)
 *
 * All implementations now use atomic database operations (UPSERT + RETURNING):
 * - custom-pg-rest.js: Calls RPC stored procedure (upsert_rate_limit)
 * - d1.js: Single atomic SQLite UPSERT with RETURNING
 * - d1-rest.js: Same as d1.js but via D1 REST API
 *
 * No optimistic locking, retry loops, or randomBackoff needed.
 * Concurrency is handled at the database level via ON CONFLICT.
 */

/**
 * Rate limiter configuration object
 * @typedef {Object} RateLimitConfig
 * @property {number} windowTimeSeconds - Time window in seconds
 * @property {number} limit - Maximum requests allowed per window
 * @property {string} ipv4Suffix - IPv4 subnet suffix (e.g., "/32")
 * @property {string} ipv6Suffix - IPv6 subnet suffix (e.g., "/60")
 * @property {string} pgErrorHandle - Error handling strategy: "fail-open" or "fail-closed"
 * @property {number} cleanupProbability - Probability of triggering cleanup (0.0 to 1.0)
 * @property {number} blockTimeSeconds - Additional block time in seconds when limit exceeded
 */

/**
 * Rate limit check result
 * @typedef {Object} RateLimitResult
 * @property {boolean} allowed - Whether both rate limit dimensions are allowed
 * @property {boolean} [ipAllowed] - Whether the IP-level rate limit passed
 * @property {boolean} [fileAllowed] - Whether the file-level rate limit passed
 * @property {string} [ipSubnet] - IP subnet that was checked (if blocked)
 * @property {number} [ipRetryAfter] - Seconds to wait before retrying the IP limit (if blocked)
 * @property {number} [fileRetryAfter] - Seconds to wait before retrying the file limit (if blocked)
 * @property {string} [error] - Error message (if error occurred with fail-closed)
 */

/**
 * Rate Limiter Interface
 *
 * Implementations should provide a checkRateLimit method with the following signature:
 *
 * @function checkRateLimit
 * @param {string} ip - Client IP address
 * @param {string} path - Requested file path
 * @param {RateLimitConfig} config - Rate limit configuration
 * @returns {Promise<RateLimitResult>} - Rate limit check result
 *
 * @example
 * const result = await checkRateLimit('192.168.1.100', '/file.txt', {
 *   windowTimeSeconds: 3600,
 *   limit: 100,
 *   ipv4Suffix: '/24',
 *   ipv6Suffix: '/60',
 *   pgErrorHandle: 'fail-closed',
 *   cleanupProbability: 0.01,
 *   blockTimeSeconds: 600
 * });
 *
 * if (result.error) {
 *   return respondError(500, result.error);
 * }
 * if (!result.ipAllowed || !result.fileAllowed) {
 *   // Handle retry based on exposed retryAfter hints
 * }
 */

// This file serves as documentation only.
// Actual implementations are in custom-pg-rest.js, d1.js, and d1-rest.js
