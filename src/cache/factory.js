import * as d1CacheManager from './d1.js';
import * as d1RestCacheManager from './d1-rest.js';
import * as customPgRestCacheManager from './custom-pg-rest.js';

/**
 * Create cache manager instance based on DB mode.
 * Mirrors the simple-alist-cf-proxy architecture but stores filesize-only records.
 *
 * @param {string} dbMode - Database mode ('d1', 'd1-rest', 'custom-pg-rest')
 * @returns {{checkCache: Function, saveCache: Function}}
 */
export const createCacheManager = (dbMode) => {
  const normalizedMode = String(dbMode || '').trim().toLowerCase();

  switch (normalizedMode) {
    case 'd1':
      return d1CacheManager;
    case 'd1-rest':
      return d1RestCacheManager;
    case 'custom-pg-rest':
      return customPgRestCacheManager;
    default:
      throw new Error(
        `Invalid DB_MODE for cache manager: "${dbMode}". Valid options are: "d1", "d1-rest", "custom-pg-rest".`
      );
  }
};
