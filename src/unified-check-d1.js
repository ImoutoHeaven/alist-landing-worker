import { sha256Hash, calculateIPSubnet } from './utils.js';

const ensureTables = async (db, { cacheTableName, rateLimitTableName, tokenTableName, altchaTableName }) => {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ${cacheTableName} (
        PATH_HASH TEXT PRIMARY KEY,
        PATH TEXT NOT NULL,
        SIZE INTEGER NOT NULL,
        TIMESTAMP INTEGER NOT NULL
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_filesize_cache_timestamp ON ${cacheTableName}(TIMESTAMP)`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ${rateLimitTableName} (
        IP_HASH TEXT PRIMARY KEY,
        IP_RANGE TEXT NOT NULL,
        ACCESS_COUNT INTEGER NOT NULL,
        LAST_WINDOW_TIME INTEGER NOT NULL,
        BLOCK_UNTIL INTEGER
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ${tokenTableName} (
        TOKEN_HASH TEXT PRIMARY KEY,
        CLIENT_IP TEXT NOT NULL,
        "FILEPATH_HASH" TEXT NOT NULL,
        ACCESS_COUNT INTEGER NOT NULL,
        CREATED_AT INTEGER NOT NULL,
        UPDATED_AT INTEGER NOT NULL,
        EXPIRES_AT INTEGER NOT NULL
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_turnstile_token_expires ON ${tokenTableName}(EXPIRES_AT)`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ${altchaTableName} (
        ALTCHA_TOKEN_HASH TEXT PRIMARY KEY,
        CLIENT_IP TEXT NOT NULL,
        FILEPATH_HASH TEXT NOT NULL,
        ACCESS_COUNT INTEGER NOT NULL DEFAULT 0,
        CREATED_AT INTEGER NOT NULL,
        EXPIRES_AT INTEGER NOT NULL
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_altcha_token_expires ON ${altchaTableName}(EXPIRES_AT)`),
  ]);
};

export const unifiedCheckD1 = async (path, clientIP, altchaTableName, config) => {
  if (!config?.env || !config?.databaseBinding) {
    throw new Error('[Unified Check D1] Missing D1 configuration');
  }

  const db = config.env[config.databaseBinding];
  if (!db) {
    throw new Error(`[Unified Check D1] D1 database binding '${config.databaseBinding}' not found`);
  }

  const now = Math.floor(Date.now() / 1000);
  const cacheTTL = Number(config.sizeTTL) || 0;
  const windowSeconds = Number(config.windowTimeSeconds) || 0;
  const limit = Number(config.limit) || 0;
  const blockSeconds = Number(config.blockTimeSeconds) || 0;
  const cacheTableName = config.cacheTableName || 'FILESIZE_CACHE_TABLE';
  const rateLimitTableName = config.rateLimitTableName || 'IP_LIMIT_TABLE';
  const ipv4Suffix = config.ipv4Suffix || '/32';
  const ipv6Suffix = config.ipv6Suffix || '/60';
  const tokenBindingEnabled = config.turnstileTokenBinding !== false;
  const tokenHash = tokenBindingEnabled ? (config.tokenHash || null) : null;
  const tokenIP = tokenBindingEnabled ? (config.tokenIP || clientIP || null) : null;
  const tokenTableName = config.tokenTableName || 'TURNSTILE_TOKEN_BINDING';
  const altchaTokenHash = config.altchaTokenHash || null;
  const altchaTokenIP = config.altchaTokenIP || clientIP || null;
  const resolvedAltchaTableName = altchaTableName || 'ALTCHA_TOKEN_LIST';

  if (cacheTTL <= 0) {
    throw new Error('[Unified Check D1] sizeTTL must be greater than zero');
  }
  if (!windowSeconds || !limit) {
    throw new Error('[Unified Check D1] windowTimeSeconds and limit are required');
  }

  await ensureTables(db, { cacheTableName, rateLimitTableName, tokenTableName, altchaTableName: resolvedAltchaTableName });

  console.log('[Unified Check D1] Starting unified check for path:', path);

  const pathHash = await sha256Hash(path);
  if (!pathHash) {
    throw new Error('[Unified Check D1] Failed to calculate path hash');
  }
  const filepathHash = await sha256Hash(path);
  if (!filepathHash) {
    throw new Error('[Unified Check D1] Failed to calculate filepath hash');
  }

  const ipSubnet = calculateIPSubnet(clientIP, ipv4Suffix, ipv6Suffix);
  if (!ipSubnet) {
    throw new Error('[Unified Check D1] Failed to calculate IP subnet');
  }

  const ipHash = await sha256Hash(ipSubnet);
  if (!ipHash) {
    throw new Error('[Unified Check D1] Failed to calculate IP hash');
  }

  const statements = [
    db.prepare(`SELECT SIZE, TIMESTAMP FROM ${cacheTableName} WHERE PATH_HASH = ?`).bind(pathHash),
    db.prepare(`
      INSERT INTO ${rateLimitTableName} (IP_HASH, IP_RANGE, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL)
      VALUES (?, ?, 1, ?, NULL)
      ON CONFLICT (IP_HASH) DO UPDATE SET
        ACCESS_COUNT = CASE
          WHEN ? - ${rateLimitTableName}.LAST_WINDOW_TIME >= ? THEN 1
          WHEN ${rateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${rateLimitTableName}.BLOCK_UNTIL <= ? THEN 1
          WHEN ${rateLimitTableName}.ACCESS_COUNT >= ? THEN ${rateLimitTableName}.ACCESS_COUNT
          ELSE ${rateLimitTableName}.ACCESS_COUNT + 1
        END,
        LAST_WINDOW_TIME = CASE
          WHEN ? - ${rateLimitTableName}.LAST_WINDOW_TIME >= ? THEN ?
          WHEN ${rateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${rateLimitTableName}.BLOCK_UNTIL <= ? THEN ?
          ELSE ${rateLimitTableName}.LAST_WINDOW_TIME
        END,
        BLOCK_UNTIL = CASE
          WHEN ? - ${rateLimitTableName}.LAST_WINDOW_TIME >= ? THEN NULL
          WHEN ${rateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${rateLimitTableName}.BLOCK_UNTIL <= ? THEN NULL
          WHEN ${rateLimitTableName}.ACCESS_COUNT >= ? AND ? > 0 THEN ? + ?
          ELSE ${rateLimitTableName}.BLOCK_UNTIL
        END
      RETURNING ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL
    `).bind(
      ipHash, ipSubnet, now,
      now, windowSeconds, now, limit,
      now, windowSeconds, now, now, now,
      now, windowSeconds, now, limit, blockSeconds, now, blockSeconds
    ),
    db.prepare(`SELECT CLIENT_IP, FILEPATH_HASH, ACCESS_COUNT, EXPIRES_AT FROM ${tokenTableName} WHERE TOKEN_HASH = ?`).bind(tokenHash),
  ];

  statements.push(
    altchaTokenHash
      ? db.prepare(`
          SELECT CLIENT_IP, FILEPATH_HASH, ACCESS_COUNT, EXPIRES_AT
          FROM ${resolvedAltchaTableName}
          WHERE ALTCHA_TOKEN_HASH = ?
        `).bind(altchaTokenHash)
      : db.prepare(`SELECT NULL AS CLIENT_IP, NULL AS FILEPATH_HASH, NULL AS ACCESS_COUNT, NULL AS EXPIRES_AT`)
  );

  console.log('[Unified Check D1] Executing batch (cache + rate limit + token binding)');
  const results = await db.batch(statements);
  if (!results || results.length < 4) {
    throw new Error('[Unified Check D1] Batch returned incomplete results');
  }

  const cacheRow = results[0].results?.[0];
  const cacheResult = {
    hit: false,
    size: null,
    timestamp: null,
  };

  if (cacheRow) {
    const timestamp = Number.parseInt(cacheRow.TIMESTAMP, 10);
    const sizeValue = Number.parseInt(cacheRow.SIZE, 10);
    const age = now - timestamp;
    if (Number.isFinite(timestamp) && Number.isFinite(sizeValue) && sizeValue >= 0 && age <= cacheTTL) {
      cacheResult.hit = true;
      cacheResult.size = sizeValue;
      cacheResult.timestamp = timestamp;
      console.log('[Unified Check D1] Cache HIT');
    } else if (age > cacheTTL) {
      console.log('[Unified Check D1] Cache expired (age:', age, 's)');
    } else {
      console.log('[Unified Check D1] Cache MISS (invalid record)');
    }
  } else {
    console.log('[Unified Check D1] Cache MISS');
  }

  const rateRow = results[1].results?.[0];
  if (!rateRow) {
    throw new Error('[Unified Check D1] Rate limit UPSERT returned no rows');
  }

  const accessCount = Number.parseInt(rateRow.ACCESS_COUNT, 10);
  const lastWindowTime = Number.parseInt(rateRow.LAST_WINDOW_TIME, 10);
  const blockUntil = rateRow.BLOCK_UNTIL !== null ? Number.parseInt(rateRow.BLOCK_UNTIL, 10) : null;

  let allowed = true;
  let retryAfter = 0;
  const safeAccess = Number.isFinite(accessCount) ? accessCount : 0;
  const safeLastWindow = Number.isFinite(lastWindowTime) ? lastWindowTime : now;

  if (Number.isFinite(blockUntil) && blockUntil > now) {
    allowed = false;
    retryAfter = Math.max(1, blockUntil - now);
    console.log('[Unified Check D1] Rate limit BLOCKED until:', new Date(blockUntil * 1000).toISOString());
  } else if (safeAccess >= limit) {
    const elapsed = now - safeLastWindow;
    retryAfter = Math.max(1, windowSeconds - elapsed);
    allowed = false;
    console.log('[Unified Check D1] Rate limit EXCEEDED:', safeAccess, '>=', limit);
  } else {
    console.log('[Unified Check D1] Rate limit OK:', safeAccess, '/', limit);
  }

  const tokenRow = results[2].results?.[0];
  let tokenAllowed = true;
  let tokenErrorCode = 0;
  let tokenAccessCount = 0;
  let tokenClientBinding = null;
  let tokenExpiresAt = null;
  let tokenFilepathBinding = null;

  if (tokenBindingEnabled && tokenHash) {
    if (tokenRow) {
      tokenClientBinding = typeof tokenRow.CLIENT_IP === 'string' ? tokenRow.CLIENT_IP : null;
      tokenFilepathBinding = typeof tokenRow.FILEPATH_HASH === 'string' ? tokenRow.FILEPATH_HASH : null;
      tokenAccessCount = Number.parseInt(tokenRow.ACCESS_COUNT, 10);
      tokenExpiresAt = tokenRow.EXPIRES_AT !== null ? Number.parseInt(tokenRow.EXPIRES_AT, 10) : null;

      if (!tokenClientBinding || tokenClientBinding !== tokenIP) {
        tokenAllowed = false;
        tokenErrorCode = 1;
      } else if (tokenClientBinding && tokenFilepathBinding && tokenFilepathBinding !== filepathHash) {
        tokenAllowed = false;
        tokenErrorCode = 4;
      } else if (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt < now) {
        tokenAllowed = false;
        tokenErrorCode = 2;
      } else if (Number.isFinite(tokenAccessCount) && tokenAccessCount >= 1) {
        tokenAllowed = false;
        tokenErrorCode = 3;
      } else {
        tokenAllowed = true;
        tokenErrorCode = 0;
      }
    } else {
      tokenAllowed = true;
      tokenErrorCode = 0;
      tokenAccessCount = 0;
      tokenClientBinding = null;
      tokenFilepathBinding = null;
      tokenExpiresAt = null;
    }
  } else {
    tokenAllowed = true;
    tokenErrorCode = 0;
    tokenAccessCount = 0;
    tokenClientBinding = null;
    tokenFilepathBinding = null;
    tokenExpiresAt = null;
  }

  const safeTokenAccess = Number.isFinite(tokenAccessCount) ? tokenAccessCount : 0;
  const safeTokenExpires = Number.isFinite(tokenExpiresAt) ? tokenExpiresAt : null;

  const altchaRow = results[3].results?.[0] || {};
  let altchaAllowed = true;
  let altchaErrorCode = 0;
  let altchaAccessCount = 0;
  let altchaExpiresAt = null;

  if (altchaTokenHash && altchaRow.ACCESS_COUNT !== null && typeof altchaRow.ACCESS_COUNT !== 'undefined') {
    altchaAccessCount = Number.parseInt(altchaRow.ACCESS_COUNT, 10);
    altchaExpiresAt = altchaRow.EXPIRES_AT !== null && typeof altchaRow.EXPIRES_AT !== 'undefined'
      ? Number.parseInt(altchaRow.EXPIRES_AT, 10)
      : null;

    if (altchaRow.CLIENT_IP !== altchaTokenIP) {
      altchaAllowed = false;
      altchaErrorCode = 1;
    } else if (altchaRow.FILEPATH_HASH !== filepathHash) {
      altchaAllowed = false;
      altchaErrorCode = 4;
    } else if (Number.isFinite(altchaExpiresAt) && altchaExpiresAt < now) {
      altchaAllowed = false;
      altchaErrorCode = 2;
    } else if (Number.isFinite(altchaAccessCount) && altchaAccessCount >= 1) {
      altchaAllowed = false;
      altchaErrorCode = 3;
    }
  }

  const safeAltchaAccess = Number.isFinite(altchaAccessCount) ? altchaAccessCount : 0;
  const safeAltchaExpires = Number.isFinite(altchaExpiresAt) ? altchaExpiresAt : null;

  return {
    cache: cacheResult,
    rateLimit: {
      allowed,
      accessCount: safeAccess,
      ipSubnet,
      retryAfter,
      lastWindowTime: safeLastWindow,
      blockUntil,
    },
    token: {
      allowed: tokenAllowed,
      errorCode: Number.isFinite(tokenErrorCode) ? tokenErrorCode : 0,
      accessCount: safeTokenAccess,
      clientIp: tokenClientBinding,
      filepath: tokenFilepathBinding,
      expiresAt: safeTokenExpires,
    },
    altcha: {
      allowed: altchaAllowed,
      errorCode: Number.isFinite(altchaErrorCode) ? altchaErrorCode : 0,
      accessCount: safeAltchaAccess,
      expiresAt: safeAltchaExpires,
    },
  };
};
