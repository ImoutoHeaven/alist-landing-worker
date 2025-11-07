import { sha256Hash, calculateIPSubnet, applyVerifyHeaders, hasVerifyCredentials } from './utils.js';

export const unifiedCheck = async (path, clientIP, altchaTableName, config) => {
  if (!config?.postgrestUrl || !hasVerifyCredentials(config.verifyHeader, config.verifySecret)) {
    throw new Error('[Unified Check] Missing PostgREST configuration');
  }

  const now = Math.floor(Date.now() / 1000);
  const cacheTTL = Number(config.sizeTTL) || 0;
  const windowSeconds = Number(config.windowTimeSeconds) || 0;
  const limit = Number(config.limit) || 0;
  const blockSeconds = Number(config.blockTimeSeconds) || 0;
  const fileLimit = Number(config.fileLimit) || 0;
  const fileWindowSeconds = Number(config.fileWindowTimeSeconds) || 0;
  const fileBlockSeconds = Number(config.fileBlockTimeSeconds) || 0;
  const cacheTableName = config.cacheTableName || 'FILESIZE_CACHE_TABLE';
  const rateLimitTableName = config.rateLimitTableName || 'IP_LIMIT_TABLE';
  const fileRateLimitTableName = config.fileRateLimitTableName || 'IP_FILE_LIMIT_TABLE';
  const ipv4Suffix = config.ipv4Suffix || '/32';
  const ipv6Suffix = config.ipv6Suffix || '/60';
  const tokenBindingEnabled = config.turnstileTokenBinding !== false;
  const tokenHash = tokenBindingEnabled ? (config.tokenHash || null) : null;
  const tokenIP = tokenBindingEnabled ? (config.tokenIP || clientIP || null) : null;
  const tokenTTLSeconds = Number(config.tokenTTLSeconds) || 0;
  const tokenTableName = config.tokenTableName || 'TURNSTILE_TOKEN_BINDING';
  const altchaTokenHash = config.altchaTokenHash || null;
  const altchaTokenIP = config.altchaTokenIP || clientIP || null;
  const normalizedAltchaTableName = altchaTableName || 'ALTCHA_TOKEN_LIST';

  if (cacheTTL <= 0) {
    throw new Error('[Unified Check] sizeTTL must be greater than zero');
  }
  const ipCheckEnabled = windowSeconds > 0 && limit > 0;
  const fileCheckEnabled = fileWindowSeconds > 0 && fileLimit > 0;

  console.log('[Unified Check] Starting unified check for path:', path);

  const pathHash = await sha256Hash(path);
  if (!pathHash) {
    throw new Error('[Unified Check] Failed to calculate path hash');
  }

  const filepathHash = await sha256Hash(path);
  if (!filepathHash) {
    throw new Error('[Unified Check] Failed to calculate filepath hash');
  }

  const ipSubnet = calculateIPSubnet(clientIP, ipv4Suffix, ipv6Suffix);
  if (!ipSubnet) {
    throw new Error('[Unified Check] Failed to calculate IP subnet');
  }

  const ipHash = await sha256Hash(ipSubnet);
  if (!ipHash) {
    throw new Error('[Unified Check] Failed to calculate IP hash');
  }

  const rpcUrl = `${config.postgrestUrl}/rpc/landing_unified_check`;
  const rpcBody = {
    p_path_hash: pathHash,
    p_cache_ttl: cacheTTL,
    p_cache_table_name: cacheTableName,
    p_ip_hash: ipHash,
    p_ip_range: ipSubnet,
    p_now: now,
    p_window_seconds: ipCheckEnabled ? windowSeconds : 0,
    p_limit: ipCheckEnabled ? limit : 0,
    p_block_seconds: ipCheckEnabled ? blockSeconds : 0,
    p_ratelimit_table_name: rateLimitTableName,
    p_file_limit: fileCheckEnabled ? fileLimit : 0,
    p_file_window_seconds: fileCheckEnabled ? fileWindowSeconds : 0,
    p_file_block_seconds: fileBlockSeconds,
    p_file_limit_table_name: fileRateLimitTableName,
    p_token_hash: tokenHash,
    p_token_ip: tokenIP,
    p_token_ttl: tokenTTLSeconds,
    p_token_table_name: tokenTableName,
    p_filepath_hash: filepathHash,
    p_altcha_token_hash: altchaTokenHash,
    p_altcha_token_ip: altchaTokenIP,
    p_altcha_filepath_hash: filepathHash,
    p_altcha_table_name: normalizedAltchaTableName,
  };

  console.log('[Unified Check] Calling landing_unified_check with params:', JSON.stringify(rpcBody));

  const headers = { 'Content-Type': 'application/json' };
  applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(rpcBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Unified Check] RPC error:', response.status, errorText);
    throw new Error(`landing_unified_check failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('[Unified Check] RPC returned no rows');
  }

  const row = payload[0];
  console.log('[Unified Check] RPC result:', JSON.stringify(row));

  const cacheSizeRaw = row.cache_size;
  const cacheTimestampRaw = row.cache_timestamp;
  const cacheHit = cacheSizeRaw !== null && cacheTimestampRaw !== null;
  const timestamp = cacheTimestampRaw !== null ? Number.parseInt(cacheTimestampRaw, 10) : null;
  const size = cacheSizeRaw !== null ? Number.parseInt(cacheSizeRaw, 10) : null;

  const cacheResult = {
    hit: cacheHit && Number.isFinite(size) && size >= 0,
    size: Number.isFinite(size) && size >= 0 ? size : null,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
  };

  const accessCount = Number.parseInt(row.rate_access_count, 10);
  const lastWindowTime = Number.parseInt(row.rate_last_window_time, 10);
  const blockUntil = row.rate_block_until !== null ? Number.parseInt(row.rate_block_until, 10) : null;
  const fileAccessCount = row.file_access_count !== null ? Number.parseInt(row.file_access_count, 10) : null;
  const fileLastWindowTime = row.file_last_window_time !== null ? Number.parseInt(row.file_last_window_time, 10) : null;
  const fileBlockUntil = row.file_block_until !== null ? Number.parseInt(row.file_block_until, 10) : null;
  const tokenErrorRaw = row.token_error_code === null || typeof row.token_error_code === 'undefined'
    ? 0
    : Number.parseInt(row.token_error_code, 10);
  const tokenAccessRaw = row.token_access_count === null || typeof row.token_access_count === 'undefined'
    ? 0
    : Number.parseInt(row.token_access_count, 10);
  const tokenAllowedRaw = row.token_allowed;
  const tokenFilepathRaw = row.token_filepath;
  const altchaErrorRaw = row.altcha_error_code === null || typeof row.altcha_error_code === 'undefined'
    ? 0
    : Number.parseInt(row.altcha_error_code, 10);
  const altchaAccessRaw = row.altcha_access_count === null || typeof row.altcha_access_count === 'undefined'
    ? 0
    : Number.parseInt(row.altcha_access_count, 10);
  const altchaAllowedRaw = row.altcha_allowed;

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
      console.log('[Unified Check] IP rate limit BLOCKED until:', new Date(blockUntil * 1000).toISOString());
    } else if (safeAccess >= limit) {
      const elapsed = now - safeLastWindow;
      ipAllowed = false;
      ipRetryAfter = Math.max(1, windowSeconds - elapsed);
      console.log('[Unified Check] IP rate limit EXCEEDED:', safeAccess, '>=', limit);
    } else {
      console.log('[Unified Check] IP rate limit OK:', safeAccess, '/', limit);
    }
  }

  let fileAllowed = true;
  let fileRetryAfter = null;
  if (fileCheckEnabled && fileLimit > 0) {
    if (Number.isFinite(fileBlockUntil) && fileBlockUntil > now) {
      fileAllowed = false;
      fileRetryAfter = Math.max(1, fileBlockUntil - now);
      console.log('[Unified Check] File rate limit BLOCKED until:', new Date(fileBlockUntil * 1000).toISOString());
    } else if (safeFileAccess >= fileLimit) {
      const elapsed = now - safeFileLastWindow;
      fileAllowed = false;
      fileRetryAfter = Math.max(1, fileWindowSeconds - elapsed);
      console.log('[Unified Check] File rate limit EXCEEDED:', safeFileAccess, '>=', fileLimit);
    } else {
      console.log('[Unified Check] File rate limit OK:', safeFileAccess, '/', fileLimit);
    }
  }

  const overallAllowed = ipAllowed && fileAllowed;

  return {
    cache: cacheResult,
    rateLimit: {
      allowed: overallAllowed,
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
      allowed: tokenBindingEnabled ? tokenAllowedRaw !== false : true,
      errorCode: Number.isFinite(tokenErrorRaw) ? tokenErrorRaw : 0,
      accessCount: Number.isFinite(tokenAccessRaw) ? tokenAccessRaw : 0,
      clientIp: typeof row.token_client_ip === 'string' ? row.token_client_ip : null,
      filepath: typeof tokenFilepathRaw === 'string' ? tokenFilepathRaw : null,
      expiresAt: row.token_expires_at !== null ? Number.parseInt(row.token_expires_at, 10) : null,
    },
    altcha: {
      allowed: altchaAllowedRaw !== false,
      errorCode: Number.isFinite(altchaErrorRaw) ? altchaErrorRaw : 0,
      accessCount: Number.isFinite(altchaAccessRaw) ? altchaAccessRaw : 0,
      expiresAt: row.altcha_expires_at !== null ? Number.parseInt(row.altcha_expires_at, 10) : null,
    },
  };
};
