/**
 * Rate Limiter Factory
 *
 * Creates rate limiter instances based on the configured database mode.
 */

import * as customPgRestRateLimiter from './custom-pg-rest.js';

/**
 * Create a rate limiter instance based on the database mode
 * @param {string|null} dbMode - Database mode: "custom-pg-rest", or null/undefined/"" to disable
 * @returns {Object|null} - Rate limiter instance with checkRateLimit method, or null if disabled
 * @throws {Error} - If dbMode is invalid
 */
export const createRateLimiter = (dbMode) => {
  // If dbMode is not set, rate limiting is disabled
  if (!dbMode || dbMode === '') {
    return null;
  }

  const normalizedDbMode = String(dbMode).trim().toLowerCase();

  if (normalizedDbMode === 'custom-pg-rest') {
    return customPgRestRateLimiter;
  }

  throw new Error(
    `Invalid DB_MODE: "${dbMode}". Only "custom-pg-rest" is supported, or leave empty to disable rate limiting.`
  );
};
