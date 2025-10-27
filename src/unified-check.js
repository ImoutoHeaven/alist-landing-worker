import { sha256Hash, calculateIPSubnet, applyVerifyHeaders, hasVerifyCredentials } from './utils.js';

export const unifiedCheck = async (path, clientIP, config) => {
  if (!config?.postgrestUrl || !hasVerifyCredentials(config.verifyHeader, config.verifySecret)) {
    throw new Error('[Unified Check] Missing PostgREST configuration');
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
  const tokenTTLSeconds = Number(config.tokenTTLSeconds) || 0;
  const tokenTableName = config.tokenTableName || 'TURNSTILE_TOKEN_BINDING';

  if (cacheTTL <= 0) {
    throw new Error('[Unified Check] sizeTTL must be greater than zero');
  }
  if (!windowSeconds || !limit) {
    throw new Error('[Unified Check] windowTimeSeconds and limit are required');
  }

  console.log('[Unified Check] Starting unified check for path:', path);

  const pathHash = await sha256Hash(path);
  if (!pathHash) {
    throw new Error('[Unified Check] Failed to calculate path hash');
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
    p_window_seconds: windowSeconds,
    p_limit: limit,
    p_block_seconds: blockSeconds,
    p_ratelimit_table_name: rateLimitTableName,
    p_token_hash: tokenHash,
    p_token_ip: tokenIP,
    p_token_ttl: tokenTTLSeconds,
    p_token_table_name: tokenTableName,
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
  const tokenErrorRaw = row.token_error_code === null || typeof row.token_error_code === 'undefined'
    ? 0
    : Number.parseInt(row.token_error_code, 10);
  const tokenAccessRaw = row.token_access_count === null || typeof row.token_access_count === 'undefined'
    ? 0
    : Number.parseInt(row.token_access_count, 10);
  const tokenAllowedRaw = row.token_allowed;

  let allowed = true;
  let retryAfter = 0;
  const safeAccess = Number.isFinite(accessCount) ? accessCount : 0;
  const safeLastWindow = Number.isFinite(lastWindowTime) ? lastWindowTime : now;

  if (Number.isFinite(blockUntil) && blockUntil > now) {
    allowed = false;
    retryAfter = Math.max(1, blockUntil - now);
    console.log('[Unified Check] Rate limit BLOCKED until:', new Date(blockUntil * 1000).toISOString());
  } else if (safeAccess >= limit) {
    const elapsed = now - safeLastWindow;
    retryAfter = Math.max(1, windowSeconds - elapsed);
    allowed = false;
    console.log('[Unified Check] Rate limit EXCEEDED:', safeAccess, '>=', limit);
  } else {
    console.log('[Unified Check] Rate limit OK:', safeAccess, '/', limit);
  }

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
      allowed: tokenBindingEnabled ? tokenAllowedRaw !== false : true,
      errorCode: Number.isFinite(tokenErrorRaw) ? tokenErrorRaw : 0,
      accessCount: Number.isFinite(tokenAccessRaw) ? tokenAccessRaw : 0,
      clientIp: typeof row.token_client_ip === 'string' ? row.token_client_ip : null,
      expiresAt: row.token_expires_at !== null ? Number.parseInt(row.token_expires_at, 10) : null,
    },
  };
};
