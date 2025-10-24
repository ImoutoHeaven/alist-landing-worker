/**
 * Rate Limiter Factory
 *
 * Creates rate limiter instances based on the configured database mode.
 */

import * as neonRateLimiter from './neon.js';
import * as firebaseRateLimiter from './firebase.js';
import * as d1RateLimiter from './d1.js';
import * as d1RestRateLimiter from './d1-rest.js';
import * as customPgRestRateLimiter from './custom-pg-rest.js';

/**
 * Create a rate limiter instance based on the database mode
 * @param {string|null} dbMode - Database mode: "neon", "firebase", or null/undefined to disable
 * @returns {Object|null} - Rate limiter instance with checkRateLimit method, or null if disabled
 * @throws {Error} - If dbMode is invalid
 */
export const createRateLimiter = (dbMode) => {
  // If dbMode is not set, rate limiting is disabled
  if (!dbMode || dbMode === '') {
    return null;
  }

  const normalizedDbMode = String(dbMode).trim().toLowerCase();

  switch (normalizedDbMode) {
    case 'neon':
      return neonRateLimiter;

    case 'firebase':
      return firebaseRateLimiter;

    case 'd1':
      return d1RateLimiter;

    case 'd1-rest':
      return d1RestRateLimiter;

    case 'custom-pg-rest':
      return customPgRestRateLimiter;

    default:
      throw new Error(
        `Invalid DB_MODE: "${dbMode}". Valid options are: "neon", "firebase", "d1", "d1-rest", "custom-pg-rest", or leave empty to disable rate limiting.`
      );
  }
};
