/**
 * Rate Limiter Interface
 *
 * All rate limiter implementations must conform to this interface.
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
 * @property {boolean} allowed - Whether the request is allowed
 * @property {string} [ipSubnet] - IP subnet that was checked (if blocked)
 * @property {number} [retryAfter] - Seconds to wait before retrying (if blocked)
 * @property {string} [error] - Error message (if error occurred with fail-closed)
 */

/**
 * Rate Limiter Interface
 *
 * Implementations should provide a checkRateLimit method with the following signature:
 *
 * @function checkRateLimit
 * @param {string} ip - Client IP address
 * @param {RateLimitConfig} config - Rate limit configuration
 * @returns {Promise<RateLimitResult>} - Rate limit check result
 *
 * @example
 * const result = await checkRateLimit('192.168.1.100', {
 *   windowTimeSeconds: 3600,
 *   limit: 100,
 *   ipv4Suffix: '/24',
 *   ipv6Suffix: '/60',
 *   pgErrorHandle: 'fail-closed',
 *   cleanupProbability: 0.01,
 *   blockTimeSeconds: 600
 * });
 *
 * if (result.allowed) {
 *   // Allow request
 * } else if (result.error) {
 *   // Database error with fail-closed
 *   return respondError(500, result.error);
 * } else {
 *   // Rate limit exceeded
 *   return respondRateLimitExceeded(429, result.ipSubnet, result.retryAfter);
 * }
 */

// This file serves as documentation only.
// Actual implementations are in neon.js and firebase.js
