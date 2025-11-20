import { sha256Hash, calculateIPSubnet } from './utils.js';

const ALTCHA_DIFFICULTY_TABLE = 'ALTCHA_DIFFICULTY_STATE';

const executeQuery = async (accountId, databaseId, apiToken, sqlOrBatch, params = []) => {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  let body;
  if (Array.isArray(sqlOrBatch)) {
    body = sqlOrBatch;
  } else {
    body = { sql: sqlOrBatch };
    if (params.length > 0) {
      body.params = params;
    }
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`D1 REST API error (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  if (!payload.success) {
    throw new Error(`D1 REST API query failed: ${JSON.stringify(payload.errors || 'Unknown error')}`);
  }

  if (Array.isArray(sqlOrBatch)) {
    return payload.result || [];
  }

  return payload.result?.[0] || { results: [], success: true };
};

const ensureTables = async (
  accountId,
  databaseId,
  apiToken,
  {
    cacheTableName,
    rateLimitTableName,
    fileRateLimitTableName,
    tokenTableName,
    altchaTableName,
    altchaDifficultyTableName = ALTCHA_DIFFICULTY_TABLE,
    powTableName = 'POW_CHALLENGE_TICKET',
    powdetDifficultyTableName = 'POWDET_DIFFICULTY_STATE',
  }
) => {
  await executeQuery(accountId, databaseId, apiToken, `
    CREATE TABLE IF NOT EXISTS ${cacheTableName} (
      PATH_HASH TEXT PRIMARY KEY,
      PATH TEXT NOT NULL,
      SIZE INTEGER NOT NULL,
      TIMESTAMP INTEGER NOT NULL
    )
  `);
  await executeQuery(accountId, databaseId, apiToken, `CREATE INDEX IF NOT EXISTS idx_filesize_cache_timestamp ON ${cacheTableName}(TIMESTAMP)`);

  await executeQuery(accountId, databaseId, apiToken, `
    CREATE TABLE IF NOT EXISTS ${rateLimitTableName} (
      IP_HASH TEXT PRIMARY KEY,
      IP_RANGE TEXT NOT NULL,
      ACCESS_COUNT INTEGER NOT NULL,
      LAST_WINDOW_TIME INTEGER NOT NULL,
      BLOCK_UNTIL INTEGER
    )
  `);
  if (fileRateLimitTableName) {
    await executeQuery(accountId, databaseId, apiToken, `
      CREATE TABLE IF NOT EXISTS ${fileRateLimitTableName} (
        IP_HASH TEXT NOT NULL,
        PATH_HASH TEXT NOT NULL,
        IP_RANGE TEXT NOT NULL,
        ACCESS_COUNT INTEGER NOT NULL,
        LAST_WINDOW_TIME INTEGER NOT NULL,
        BLOCK_UNTIL INTEGER,
        PRIMARY KEY (IP_HASH, PATH_HASH)
      )
    `);
    await executeQuery(
      accountId,
      databaseId,
      apiToken,
      `CREATE INDEX IF NOT EXISTS idx_ip_file_limit_last_window ON ${fileRateLimitTableName}(LAST_WINDOW_TIME)`
    );
    await executeQuery(
      accountId,
      databaseId,
      apiToken,
      `CREATE INDEX IF NOT EXISTS idx_ip_file_limit_block_until ON ${fileRateLimitTableName}(BLOCK_UNTIL)`
    );
  }
  await executeQuery(accountId, databaseId, apiToken, `
    CREATE TABLE IF NOT EXISTS ${tokenTableName} (
      TOKEN_HASH TEXT PRIMARY KEY,
      CLIENT_IP TEXT NOT NULL,
      "FILEPATH_HASH" TEXT NOT NULL,
      ACCESS_COUNT INTEGER NOT NULL,
      CREATED_AT INTEGER NOT NULL,
      UPDATED_AT INTEGER NOT NULL,
      EXPIRES_AT INTEGER NOT NULL
    )
  `);
  await executeQuery(accountId, databaseId, apiToken, `CREATE INDEX IF NOT EXISTS idx_turnstile_token_expires ON ${tokenTableName}(EXPIRES_AT)`);
  await executeQuery(accountId, databaseId, apiToken, `
    CREATE TABLE IF NOT EXISTS ${altchaTableName} (
      ALTCHA_TOKEN_HASH TEXT PRIMARY KEY,
      CLIENT_IP TEXT NOT NULL,
      FILEPATH_HASH TEXT NOT NULL,
      ACCESS_COUNT INTEGER NOT NULL DEFAULT 0,
      CREATED_AT INTEGER NOT NULL,
      EXPIRES_AT INTEGER NOT NULL
    )
  `);
  await executeQuery(accountId, databaseId, apiToken, `CREATE INDEX IF NOT EXISTS idx_altcha_token_expires ON ${altchaTableName}(EXPIRES_AT)`);
  await executeQuery(accountId, databaseId, apiToken, `
    CREATE TABLE IF NOT EXISTS ${altchaDifficultyTableName} (
      IP_HASH TEXT PRIMARY KEY,
      IP_RANGE TEXT NOT NULL,
      LEVEL INTEGER NOT NULL DEFAULT 0,
      LAST_SUCCESS_AT INTEGER NOT NULL,
      BLOCK_UNTIL INTEGER
    )
  `);
  await executeQuery(accountId, databaseId, apiToken, `CREATE INDEX IF NOT EXISTS idx_altcha_diff_block_until ON ${altchaDifficultyTableName}(BLOCK_UNTIL)`);
  await executeQuery(accountId, databaseId, apiToken, `
    CREATE TABLE IF NOT EXISTS ${powTableName} (
      CHALLENGE_HASH TEXT PRIMARY KEY,
      FIRST_ISSUED_AT INTEGER NOT NULL,
      EXPIRE_AT INTEGER NOT NULL,
      CONSUMED INTEGER NOT NULL DEFAULT 0,
      CONSUMED_AT INTEGER,
      LAST_NONCE TEXT
    )
  `);
  await executeQuery(accountId, databaseId, apiToken, `CREATE INDEX IF NOT EXISTS idx_pow_challenge_expire ON ${powTableName}(EXPIRE_AT)`);
  await executeQuery(accountId, databaseId, apiToken, `
    CREATE TABLE IF NOT EXISTS ${powdetDifficultyTableName} (
      IP_HASH TEXT PRIMARY KEY,
      IP_RANGE TEXT NOT NULL,
      LEVEL INTEGER NOT NULL DEFAULT 0,
      LAST_SUCCESS_AT INTEGER NOT NULL,
      BLOCK_UNTIL INTEGER
    )
  `);
  await executeQuery(accountId, databaseId, apiToken, `CREATE INDEX IF NOT EXISTS idx_powdet_diff_block_until ON ${powdetDifficultyTableName}(BLOCK_UNTIL)`);
};

export const unifiedCheckD1Rest = async (path, clientIP, altchaTableName, config) => {
  if (!config?.accountId || !config?.databaseId || !config?.apiToken) {
    throw new Error('[Unified Check D1-REST] Missing D1 REST configuration');
  }

  const { accountId, databaseId, apiToken } = config;
  const now = Math.floor(Date.now() / 1000);
  const cacheTTL = Number(config.sizeTTL) || 0;
  const windowSeconds = Number(config.windowTimeSeconds) || 0;
  const limit = Number(config.limit) || 0;
  const blockSeconds = Number(config.blockTimeSeconds) || 0;
  const cacheTableName = config.cacheTableName || 'FILESIZE_CACHE_TABLE';
  const rateLimitTableName = config.rateLimitTableName || 'IP_LIMIT_TABLE';
  const fileRateLimitTableName = config.fileRateLimitTableName || 'IP_FILE_LIMIT_TABLE';
  const fileLimit = Number(config.fileLimit) || 0;
  const fileWindowSeconds = Number(config.fileWindowTimeSeconds) || 0;
  const fileBlockSeconds = Number(config.fileBlockTimeSeconds) || 0;
  const ipv4Suffix = config.ipv4Suffix || '/32';
  const ipv6Suffix = config.ipv6Suffix || '/60';
  const tokenBindingEnabled = config.turnstileTokenBinding !== false;
  const tokenHash = tokenBindingEnabled ? (config.tokenHash || null) : null;
  const tokenIP = tokenBindingEnabled ? (config.tokenIP || clientIP || null) : null;
  const tokenTableName = config.tokenTableName || 'TURNSTILE_TOKEN_BINDING';
  const altchaTokenHash = config.altchaTokenHash || null;
  const altchaTokenIP = config.altchaTokenIP || clientIP || null;
  const resolvedAltchaTableName = altchaTableName || 'ALTCHA_TOKEN_LIST';
  const powdetChallengeHash = config.powdetChallengeHash || null;
  const powdetTableName = config.powdetTableName || 'POW_CHALLENGE_TICKET';
  const powdetExpireSeconds = Number(config.powdetExpireSeconds) || 0;
  const powdetExpireAtFromConfig = Number.isFinite(config.powdetExpireAt) ? Number(config.powdetExpireAt) : null;
  const powdetExpireAt = Number.isFinite(powdetExpireAtFromConfig)
    ? powdetExpireAtFromConfig
    : (powdetExpireSeconds > 0 ? now + powdetExpireSeconds : now);
  const powdetDifficultyTableName = config.powdetDifficultyTableName || 'POWDET_DIFFICULTY_STATE';
  const ipCheckEnabled = windowSeconds > 0 && limit > 0;
  const fileCheckEnabled = fileWindowSeconds > 0 && fileLimit > 0;

  if (cacheTTL <= 0) {
    throw new Error('[Unified Check D1-REST] sizeTTL must be greater than zero');
  }

  if (config.initTables === true) {
    await ensureTables(accountId, databaseId, apiToken, {
      cacheTableName,
      rateLimitTableName,
      fileRateLimitTableName,
      tokenTableName,
      altchaTableName: resolvedAltchaTableName,
      altchaDifficultyTableName: ALTCHA_DIFFICULTY_TABLE,
      powTableName: powdetTableName,
      powdetDifficultyTableName,
    });
  }

  console.log('[Unified Check D1-REST] Starting unified check for path:', path);

  const pathHash = await sha256Hash(path);
  if (!pathHash) {
    throw new Error('[Unified Check D1-REST] Failed to calculate path hash');
  }
  const filepathHash = await sha256Hash(path);
  if (!filepathHash) {
    throw new Error('[Unified Check D1-REST] Failed to calculate filepath hash');
  }

  const ipSubnet = calculateIPSubnet(clientIP, ipv4Suffix, ipv6Suffix);
  if (!ipSubnet) {
    throw new Error('[Unified Check D1-REST] Failed to calculate IP subnet');
  }

  const ipHash = await sha256Hash(ipSubnet);
  if (!ipHash) {
    throw new Error('[Unified Check D1-REST] Failed to calculate IP hash');
  }

  console.log('[Unified Check D1-REST] Executing batch query (cache + dual rate limits + token + altcha)');

  const batchQueries = [
    {
      sql: `SELECT SIZE, TIMESTAMP FROM ${cacheTableName} WHERE PATH_HASH = ?`,
      params: [pathHash],
    },
    ipCheckEnabled
      ? {
          sql: `
            INSERT INTO ${rateLimitTableName} (IP_HASH, IP_RANGE, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL)
            VALUES (?, ?, 1, ?, NULL)
            ON CONFLICT (IP_HASH) DO UPDATE SET
              ACCESS_COUNT = CASE
                WHEN ${rateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${rateLimitTableName}.BLOCK_UNTIL > ? THEN ${rateLimitTableName}.ACCESS_COUNT
                WHEN ? - ${rateLimitTableName}.LAST_WINDOW_TIME >= ? THEN 1
                WHEN ${rateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${rateLimitTableName}.BLOCK_UNTIL <= ? THEN 1
                WHEN ${rateLimitTableName}.ACCESS_COUNT >= ? THEN ${rateLimitTableName}.ACCESS_COUNT
                ELSE ${rateLimitTableName}.ACCESS_COUNT + 1
              END,
              LAST_WINDOW_TIME = CASE
                WHEN ${rateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${rateLimitTableName}.BLOCK_UNTIL > ? THEN ${rateLimitTableName}.LAST_WINDOW_TIME
                WHEN ? - ${rateLimitTableName}.LAST_WINDOW_TIME >= ? THEN ?
                WHEN ${rateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${rateLimitTableName}.BLOCK_UNTIL <= ? THEN ?
                ELSE ${rateLimitTableName}.LAST_WINDOW_TIME
              END,
              BLOCK_UNTIL = CASE
                WHEN ${rateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${rateLimitTableName}.BLOCK_UNTIL > ? THEN ${rateLimitTableName}.BLOCK_UNTIL
                WHEN ${rateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${rateLimitTableName}.BLOCK_UNTIL <= ? THEN NULL
                WHEN (${rateLimitTableName}.BLOCK_UNTIL IS NULL OR ${rateLimitTableName}.BLOCK_UNTIL <= ?)
                     AND (
                       CASE
                         WHEN ? - ${rateLimitTableName}.LAST_WINDOW_TIME >= ? THEN 1
                         WHEN ${rateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${rateLimitTableName}.BLOCK_UNTIL <= ? THEN 1
                         WHEN ${rateLimitTableName}.ACCESS_COUNT >= ? THEN ${rateLimitTableName}.ACCESS_COUNT
                         ELSE ${rateLimitTableName}.ACCESS_COUNT + 1
                       END
                     ) >= ?
                     AND ? > 0 THEN ? + ?
                ELSE ${rateLimitTableName}.BLOCK_UNTIL
              END
            RETURNING ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL
          `,
          params: [
            ipHash, ipSubnet, now,
            now, now, windowSeconds, now, limit,
            now, now, windowSeconds, now, now, now,
            now, now, now,
            now, windowSeconds, now, limit, limit, blockSeconds, now, blockSeconds,
          ],
        }
      : {
          sql: 'SELECT NULL AS ACCESS_COUNT, NULL AS LAST_WINDOW_TIME, NULL AS BLOCK_UNTIL',
          params: [],
        },
    fileCheckEnabled
      ? {
          sql: `
            INSERT INTO ${fileRateLimitTableName} (IP_HASH, PATH_HASH, IP_RANGE, ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL)
            VALUES (?, ?, ?, 1, ?, NULL)
            ON CONFLICT (IP_HASH, PATH_HASH) DO UPDATE SET
              ACCESS_COUNT = CASE
                WHEN ${fileRateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileRateLimitTableName}.BLOCK_UNTIL > ? THEN ${fileRateLimitTableName}.ACCESS_COUNT
                WHEN ? - ${fileRateLimitTableName}.LAST_WINDOW_TIME >= ? THEN 1
                WHEN ${fileRateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileRateLimitTableName}.BLOCK_UNTIL <= ? THEN 1
                WHEN ${fileRateLimitTableName}.ACCESS_COUNT >= ? THEN ${fileRateLimitTableName}.ACCESS_COUNT
                ELSE ${fileRateLimitTableName}.ACCESS_COUNT + 1
              END,
              LAST_WINDOW_TIME = CASE
                WHEN ${fileRateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileRateLimitTableName}.BLOCK_UNTIL > ? THEN ${fileRateLimitTableName}.LAST_WINDOW_TIME
                WHEN ? - ${fileRateLimitTableName}.LAST_WINDOW_TIME >= ? THEN ?
                WHEN ${fileRateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileRateLimitTableName}.BLOCK_UNTIL <= ? THEN ?
                ELSE ${fileRateLimitTableName}.LAST_WINDOW_TIME
              END,
              BLOCK_UNTIL = CASE
                WHEN ${fileRateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileRateLimitTableName}.BLOCK_UNTIL > ? THEN ${fileRateLimitTableName}.BLOCK_UNTIL
                WHEN ${fileRateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileRateLimitTableName}.BLOCK_UNTIL <= ? THEN NULL
                WHEN (${fileRateLimitTableName}.BLOCK_UNTIL IS NULL OR ${fileRateLimitTableName}.BLOCK_UNTIL <= ?)
                     AND (
                       CASE
                         WHEN ? - ${fileRateLimitTableName}.LAST_WINDOW_TIME >= ? THEN 1
                         WHEN ${fileRateLimitTableName}.BLOCK_UNTIL IS NOT NULL AND ${fileRateLimitTableName}.BLOCK_UNTIL <= ? THEN 1
                         WHEN ${fileRateLimitTableName}.ACCESS_COUNT >= ? THEN ${fileRateLimitTableName}.ACCESS_COUNT
                         ELSE ${fileRateLimitTableName}.ACCESS_COUNT + 1
                       END
                     ) >= ?
                     AND ? > 0 THEN ? + ?
                ELSE ${fileRateLimitTableName}.BLOCK_UNTIL
              END
            RETURNING ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL
          `,
          params: [
            ipHash, filepathHash, ipSubnet, now,
            now, now, fileWindowSeconds, now, fileLimit,
            now, now, fileWindowSeconds, now, now, now,
            now, now, now,
            now, fileWindowSeconds, now, fileLimit, fileLimit, fileBlockSeconds, now, fileBlockSeconds,
          ],
        }
      : {
          sql: 'SELECT NULL AS ACCESS_COUNT, NULL AS LAST_WINDOW_TIME, NULL AS BLOCK_UNTIL',
          params: [],
        },
    tokenHash
      ? {
          sql: `SELECT CLIENT_IP, FILEPATH_HASH, ACCESS_COUNT, EXPIRES_AT FROM ${tokenTableName} WHERE TOKEN_HASH = ?`,
          params: [tokenHash],
        }
      : {
          sql: 'SELECT NULL AS CLIENT_IP, NULL AS FILEPATH_HASH, NULL AS ACCESS_COUNT, NULL AS EXPIRES_AT',
          params: [],
        },
    altchaTokenHash
      ? {
          sql: `SELECT CLIENT_IP, FILEPATH_HASH, ACCESS_COUNT, EXPIRES_AT FROM ${resolvedAltchaTableName} WHERE ALTCHA_TOKEN_HASH = ?`,
          params: [altchaTokenHash],
        }
      : {
          sql: 'SELECT NULL AS CLIENT_IP, NULL AS FILEPATH_HASH, NULL AS ACCESS_COUNT, NULL AS EXPIRES_AT',
          params: [],
        },
    powdetChallengeHash
      ? {
          sql: `
            INSERT INTO ${powdetTableName} (CHALLENGE_HASH, FIRST_ISSUED_AT, EXPIRE_AT, CONSUMED)
            VALUES (?, ?, ?, 0)
            ON CONFLICT (CHALLENGE_HASH) DO NOTHING
          `,
          params: [powdetChallengeHash, now, powdetExpireAt],
        }
      : {
          sql: 'SELECT 1 AS POW_NOOP',
          params: [],
        },
    powdetChallengeHash
      ? {
          sql: `
            UPDATE ${powdetTableName}
            SET CONSUMED = 1,
                CONSUMED_AT = ?
            WHERE CHALLENGE_HASH = ?
              AND CONSUMED = 0
          `,
          params: [now, powdetChallengeHash],
        }
      : {
          sql: 'SELECT 0 AS changes',
          params: [],
        },
  ];

  const batchResults = await executeQuery(accountId, databaseId, apiToken, batchQueries);

  if (!batchResults || batchResults.length < 7) {
    throw new Error(`[Unified Check D1-REST] Batch returned incomplete results: expected 7, got ${batchResults?.length || 0}`);
  }

  const cacheResult = batchResults[0];
  const rateLimitResult = batchResults[1];
  const fileRateLimitResult = batchResults[2];
  const tokenResult = batchResults[3];
  const altchaResult = batchResults[4];
  const powInsertResult = batchResults[5];
  const powUpdateResult = batchResults[6];

  const cacheRow = cacheResult?.results?.[0];
  const cacheData = {
    hit: false,
    size: null,
    timestamp: null,
  };

  if (cacheRow) {
    const timestamp = Number.parseInt(cacheRow.TIMESTAMP, 10);
    const sizeValue = Number.parseInt(cacheRow.SIZE, 10);
    const age = now - timestamp;
    if (Number.isFinite(timestamp) && Number.isFinite(sizeValue) && sizeValue >= 0 && age <= cacheTTL) {
      cacheData.hit = true;
      cacheData.size = sizeValue;
      cacheData.timestamp = timestamp;
      console.log('[Unified Check D1-REST] Cache HIT');
    } else if (age > cacheTTL) {
      console.log('[Unified Check D1-REST] Cache expired (age:', age, 's)');
    } else {
      console.log('[Unified Check D1-REST] Cache MISS (invalid record)');
    }
  } else {
    console.log('[Unified Check D1-REST] Cache MISS');
  }

  const rateRow = rateLimitResult?.results?.[0] || null;
  const fileRow = fileRateLimitResult?.results?.[0] || null;
  if (ipCheckEnabled && !rateRow) {
    throw new Error('[Unified Check D1-REST] Rate limit UPSERT returned no rows');
  }
  if (fileCheckEnabled && !fileRow) {
    throw new Error('[Unified Check D1-REST] File rate limit UPSERT returned no rows');
  }

  const accessCount = rateRow ? Number.parseInt(rateRow.ACCESS_COUNT, 10) : NaN;
  const lastWindowTime = rateRow ? Number.parseInt(rateRow.LAST_WINDOW_TIME, 10) : NaN;
  const blockUntil = rateRow && rateRow.BLOCK_UNTIL !== null ? Number.parseInt(rateRow.BLOCK_UNTIL, 10) : null;
  const fileAccessCount = fileRow ? Number.parseInt(fileRow.ACCESS_COUNT, 10) : NaN;
  const fileLastWindowTime = fileRow ? Number.parseInt(fileRow.LAST_WINDOW_TIME, 10) : NaN;
  const fileBlockUntil = fileRow && fileRow.BLOCK_UNTIL !== null ? Number.parseInt(fileRow.BLOCK_UNTIL, 10) : null;

  const safeAccess = Number.isFinite(accessCount) ? accessCount : 0;
  const safeLastWindow = Number.isFinite(lastWindowTime) ? lastWindowTime : now;
  const safeFileAccess = Number.isFinite(fileAccessCount) ? fileAccessCount : 0;
  const safeFileLastWindow = Number.isFinite(fileLastWindowTime) ? fileLastWindowTime : now;

  let ipAllowed = true;
  let ipRetryAfter = null;
  if (ipCheckEnabled && limit > 0) {
    if (Number.isFinite(blockUntil) && blockUntil > now) {
      ipAllowed = false;
      ipRetryAfter = Math.max(1, blockUntil - now);
      console.log('[Unified Check D1-REST] IP rate limit BLOCKED until:', new Date(blockUntil * 1000).toISOString());
    } else if (safeAccess >= limit) {
      const elapsed = now - safeLastWindow;
      ipAllowed = false;
      ipRetryAfter = Math.max(1, windowSeconds - elapsed);
      console.log('[Unified Check D1-REST] IP rate limit EXCEEDED:', safeAccess, '>=', limit);
    } else {
      console.log('[Unified Check D1-REST] IP rate limit OK:', safeAccess, '/', limit);
    }
  }

  let fileAllowed = true;
  let fileRetryAfter = null;
  if (fileCheckEnabled && fileLimit > 0) {
    if (Number.isFinite(fileBlockUntil) && fileBlockUntil > now) {
      fileAllowed = false;
      fileRetryAfter = Math.max(1, fileBlockUntil - now);
      console.log('[Unified Check D1-REST] File rate limit BLOCKED until:', new Date(fileBlockUntil * 1000).toISOString());
    } else if (safeFileAccess >= fileLimit) {
      const elapsed = now - safeFileLastWindow;
      fileAllowed = false;
      fileRetryAfter = Math.max(1, fileWindowSeconds - elapsed);
      console.log('[Unified Check D1-REST] File rate limit EXCEEDED:', safeFileAccess, '>=', fileLimit);
    } else {
      console.log('[Unified Check D1-REST] File rate limit OK:', safeFileAccess, '/', fileLimit);
    }
  }

  const tokenRow = tokenResult?.results?.[0];
  let tokenAllowed = true;
  let tokenErrorCode = 0;
  let tokenAccessCount = 0;
  let tokenClientBinding = null;
  let tokenFilepathBinding = null;
  let tokenExpiresAt = null;

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

  const altchaRow = altchaResult?.results?.[0] || {};
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

  let powConsumed = true;
  let powErrorCode = 0;
  if (powdetChallengeHash) {
    const changes = Number(
      (powUpdateResult && typeof powUpdateResult.meta?.changes !== 'undefined' ? powUpdateResult.meta?.changes : undefined) ||
        (Array.isArray(powUpdateResult?.results) && typeof powUpdateResult.results[0]?.changes !== 'undefined'
          ? powUpdateResult.results[0]?.changes
          : undefined) ||
        powUpdateResult?.changes
    );
    powConsumed = changes > 0;
    powErrorCode = powConsumed ? 0 : 1;
  }

  return {
    cache: cacheData,
    rateLimit: {
      allowed: ipAllowed && fileAllowed,
      ipAllowed,
      ipRetryAfter,
      ipSubnet,
      ipAccessCount: safeAccess,
      ipLastWindowTime: safeLastWindow,
      ipBlockUntil: blockUntil,
      fileAllowed,
      fileRetryAfter,
      fileAccessCount: safeFileAccess,
      fileLastWindowTime: safeFileLastWindow,
      fileBlockUntil,
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
    powdet: {
      consumed: powConsumed,
      errorCode: Number.isFinite(powErrorCode) ? powErrorCode : 0,
    },
  };
};
