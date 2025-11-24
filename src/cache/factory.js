import * as customPgRestCacheManager from './custom-pg-rest.js';

/**
 * Create cache manager instance based on DB mode.
 * Mirrors the simple-alist-cf-proxy architecture but stores filesize-only records.
 *
 * @param {string} dbMode - Database mode ("custom-pg-rest")
 * @returns {{checkCache: Function, saveCache: Function}}
 */
export const createCacheManager = (dbMode) => {
  const normalizedMode = String(dbMode || '').trim().toLowerCase();

  if (normalizedMode === 'custom-pg-rest') {
    return customPgRestCacheManager;
  }

  throw new Error(
    `Invalid DB_MODE for cache manager: "${dbMode}". Only "custom-pg-rest" is supported.`
  );
};
