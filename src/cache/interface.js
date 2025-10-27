/**
 * Filesize cache interface
 *
 * All cache implementations provide TTL-based lookup/save helpers that operate on
 * the reduced schema (PATH_HASH, PATH, SIZE, TIMESTAMP). Implementations live in:
 *   - d1.js
 *   - d1-rest.js
 *   - custom-pg-rest.js
 *
 * Cache records store filesize only to keep the payload minimal while still
 * allowing RTT reductions for the /api/fs/get endpoint.
 */

/**
 * Check if a cached filesize exists and is still valid.
 *
 * @param {string} path - File path to check.
 * @param {Object} config - Cache configuration.
 * @returns {Promise<{size: number} | null>}
 *   Returns { size } when cache hit and not expired.
 *   Returns null when cache miss, expired, or configuration incomplete.
 */
export const checkCache = async (path, config) => {
  throw new Error('checkCache must be implemented by subclass');
};

/**
 * Save filesize to cache using an atomic UPSERT.
 *
 * @param {string} path - File path being cached.
 * @param {number} size - Filesize in bytes.
 * @param {Object} config - Cache configuration (same structure as checkCache).
 * @returns {Promise<void>}
 *   Implementations perform probabilistic cleanup via ctx.waitUntil when available.
 */
export const saveCache = async (path, size, config) => {
  throw new Error('saveCache must be implemented by subclass');
};
