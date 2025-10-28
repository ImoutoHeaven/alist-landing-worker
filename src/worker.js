import {
  rotLower,
  uint8ToBase64,
  parseBoolean,
  parseInteger,
  parseNumber,
  parseWindowTime,
  sha256Hash,
  applyVerifyHeaders,
} from './utils.js';
import { renderLandingPage } from './frontend.js';
import { createRateLimiter } from './ratelimit/factory.js';
import { createCacheManager } from './cache/factory.js';
import { unifiedCheck } from './unified-check.js';
import { unifiedCheckD1 } from './unified-check-d1.js';
import { unifiedCheckD1Rest } from './unified-check-d1-rest.js';

const REQUIRED_ENV = ['TOKEN', 'WORKER_ADDRESS_DOWNLOAD'];

const TURNSTILE_VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_HEADER = 'cf-turnstile-response';
const TOKEN_BINDING_ERROR_MESSAGES = {
  1: 'turnstile token ip mismatch',
  2: 'turnstile token expired',
  3: 'turnstile token already used',
  4: 'turnstile token path mismatch',
};

const VALID_ACTIONS = new Set(['block', 'verify', 'pass-web', 'pass-server', 'pass-asis']);

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'host',
]);

const ensureRequiredEnv = (env) => {
  REQUIRED_ENV.forEach((key) => {
    if (!env[key] || String(env[key]).trim() === '') {
      throw new Error(`environment variable ${key} is required`);
    }
  });
};

const resolveConfig = (env = {}) => {
  ensureRequiredEnv(env);
  const underAttack = parseBoolean(env.UNDER_ATTACK, false);
  const turnstileSiteKey = env.TURNSTILE_SITE_KEY ? String(env.TURNSTILE_SITE_KEY).trim() : '';
  const turnstileSecretKey = env.TURNSTILE_SECRET_KEY ? String(env.TURNSTILE_SECRET_KEY).trim() : '';
  if (underAttack && (!turnstileSiteKey || !turnstileSecretKey)) {
    throw new Error('environment variables TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are required when UNDER_ATTACK is true');
  }
  let turnstileTokenBindingEnabled = parseBoolean(env.TURNSTILE_TOKEN_BINDING, true);
  const rawTurnstileTokenTTL = env.TURNSTILE_TOKEN_TTL && typeof env.TURNSTILE_TOKEN_TTL === 'string'
    ? env.TURNSTILE_TOKEN_TTL.trim()
    : '10m';
  let turnstileTokenTTLSeconds = parseWindowTime(rawTurnstileTokenTTL);
  if (turnstileTokenTTLSeconds <= 0) {
    turnstileTokenTTLSeconds = parseWindowTime('10m');
  }
  const turnstileTokenTableName = env.TURNSTILE_TOKEN_TABLE && typeof env.TURNSTILE_TOKEN_TABLE === 'string'
    ? env.TURNSTILE_TOKEN_TABLE.trim()
    : 'TURNSTILE_TOKEN_BINDING';

  // Parse prefix lists (comma-separated)
  const parsePrefixList = (value) => {
    if (!value || typeof value !== 'string') return [];
    return value.split(',').map(p => p.trim()).filter(p => p.length > 0);
  };

  // Validate action value
  const validateAction = (action, paramName) => {
    if (!action) return '';
    const normalizedAction = String(action).trim().toLowerCase();
    if (!VALID_ACTIONS.has(normalizedAction)) {
      throw new Error(`${paramName} must be one of: ${Array.from(VALID_ACTIONS).join(', ')}`);
    }
    return normalizedAction;
  };

  const blacklistPrefixes = parsePrefixList(env.BLACKLIST_PREFIX);
  const whitelistPrefixes = parsePrefixList(env.WHITELIST_PREFIX);
  const blacklistAction = validateAction(env.BLACKLIST_ACTION, 'BLACKLIST_ACTION');
  const whitelistAction = validateAction(env.WHITELIST_ACTION, 'WHITELIST_ACTION');

  // Parse except action (format: {action}-except)
  const exceptPrefixes = parsePrefixList(env.EXCEPT_PREFIX);
  let exceptAction = '';
  if (env.EXCEPT_ACTION && typeof env.EXCEPT_ACTION === 'string') {
    const rawExceptAction = env.EXCEPT_ACTION.trim().toLowerCase();
    if (rawExceptAction && exceptPrefixes.length > 0) {
      // Validate format: must end with '-except'
      if (!rawExceptAction.endsWith('-except')) {
        throw new Error('EXCEPT_ACTION must be in format "{action}-except" (e.g., "block-except")');
      }
      // Extract the actual action part
      const actionPart = rawExceptAction.slice(0, -7); // Remove '-except'
      if (!actionPart) {
        throw new Error('EXCEPT_ACTION must specify an action (e.g., "block-except")');
      }
      if (!VALID_ACTIONS.has(actionPart)) {
        throw new Error(`EXCEPT_ACTION action part must be one of: ${Array.from(VALID_ACTIONS).join(', ')}`);
      }
      exceptAction = actionPart;
    }
  }

  // Parse database mode for rate limiting
  const dbMode = env.DB_MODE && typeof env.DB_MODE === 'string' ? env.DB_MODE.trim() : '';

  if (!dbMode) {
    if (turnstileTokenBindingEnabled) {
      console.log('[CONFIG] Turnstile token binding disabled because DB_MODE is empty');
    }
    turnstileTokenBindingEnabled = false;
  }

  // Parse common rate limit configuration
  const windowTime = env.WINDOW_TIME && typeof env.WINDOW_TIME === 'string' ? env.WINDOW_TIME.trim() : '';
  const windowTimeSeconds = parseWindowTime(windowTime);
  const ipSubnetLimit = parseInteger(env.IPSUBNET_WINDOWTIME_LIMIT, 0);
  const ipv4Suffix = env.IPV4_SUFFIX && typeof env.IPV4_SUFFIX === 'string' ? env.IPV4_SUFFIX.trim() : '/32';
  const ipv6Suffix = env.IPV6_SUFFIX && typeof env.IPV6_SUFFIX === 'string' ? env.IPV6_SUFFIX.trim() : '/60';
  const pgErrorHandle = env.PG_ERROR_HANDLE && typeof env.PG_ERROR_HANDLE === 'string'
    ? env.PG_ERROR_HANDLE.trim().toLowerCase()
    : 'fail-closed';
  const blockTime = env.BLOCK_TIME && typeof env.BLOCK_TIME === 'string' ? env.BLOCK_TIME.trim() : '10m';
  const blockTimeSeconds = parseWindowTime(blockTime);

  // Parse cleanup percentage (default 1%)
  const cleanupPercentage = parseNumber(env.CLEANUP_PERCENTAGE, 1);
  // Clamp between 0 and 100 (supports decimal percentages)
  const validCleanupPercentage = Math.max(0, Math.min(100, cleanupPercentage));
  // Convert to probability (0.0 to 1.0)
  const cleanupProbability = validCleanupPercentage / 100;

  // Filesize cache configuration
  const rawSizeTTL = env.SIZE_TTL && typeof env.SIZE_TTL === 'string' ? env.SIZE_TTL.trim() : '24h';
  let sizeTTLSeconds = parseWindowTime(rawSizeTTL);
  if (sizeTTLSeconds <= 0) {
    sizeTTLSeconds = parseWindowTime('24h');
  }
  const sizeTTL = rawSizeTTL && rawSizeTTL.length > 0 ? rawSizeTTL : '24h';
  const filesizeCacheTableName = env.FILESIZE_CACHE_TABLE && typeof env.FILESIZE_CACHE_TABLE === 'string'
    ? env.FILESIZE_CACHE_TABLE.trim()
    : 'FILESIZE_CACHE_TABLE';
  console.log('[CONFIG] Filesize cache config:', { rawSizeTTL, sizeTTLSeconds, filesizeCacheTableName });

  // Validate PG_ERROR_HANDLE value
  const validPgErrorHandle = pgErrorHandle === 'fail-open' ? 'fail-open' : 'fail-closed';

  const parseVerifyValues = (value) => {
    if (!value || typeof value !== 'string') {
      return [];
    }
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  };

  const verifyHeaders = parseVerifyValues(env.VERIFY_HEADER);
  const verifySecrets = parseVerifyValues(env.VERIFY_SECRET);

  if (verifyHeaders.length > 0 && verifySecrets.length > 0 && verifyHeaders.length !== verifySecrets.length) {
    throw new Error('VERIFY_HEADER and VERIFY_SECRET must have the same number of comma-separated entries');
  }

  // Parse database-specific configuration
  let rateLimitEnabled = false;
  let rateLimitConfig = {};
  let cacheEnabled = false;
  let cacheConfig = {};

  if (dbMode) {
    const normalizedDbMode = dbMode.toLowerCase();

    if (normalizedDbMode === 'd1') {
      // D1 (Cloudflare D1 Binding) configuration
      const d1DatabaseBinding = env.D1_DATABASE_BINDING && typeof env.D1_DATABASE_BINDING === 'string' ? env.D1_DATABASE_BINDING.trim() : 'DB';
      const d1TableName = env.D1_TABLE_NAME && typeof env.D1_TABLE_NAME === 'string' ? env.D1_TABLE_NAME.trim() : '';

      if (d1DatabaseBinding && windowTimeSeconds > 0 && ipSubnetLimit > 0) {
        rateLimitEnabled = true;
        rateLimitConfig = {
          env, // Pass env object so rate limiter can access the binding
          databaseBinding: d1DatabaseBinding,
          tableName: d1TableName || 'IP_LIMIT_TABLE',
          windowTimeSeconds,
          limit: ipSubnetLimit,
          ipv4Suffix,
          ipv6Suffix,
          pgErrorHandle: validPgErrorHandle,
          cleanupProbability,
          blockTimeSeconds,
        };
        if (sizeTTLSeconds > 0) {
          cacheEnabled = true;
          cacheConfig = {
            env,
            databaseBinding: d1DatabaseBinding,
            tableName: filesizeCacheTableName,
            sizeTTL: sizeTTLSeconds,
            cleanupProbability,
          };
        }
      } else {
        throw new Error('DB_MODE is set to "d1" but required environment variables are missing: WINDOW_TIME, IPSUBNET_WINDOWTIME_LIMIT');
      }
    } else if (normalizedDbMode === 'd1-rest') {
      // D1 REST API configuration
      const d1AccountId = env.D1_ACCOUNT_ID && typeof env.D1_ACCOUNT_ID === 'string' ? env.D1_ACCOUNT_ID.trim() : '';
      const d1DatabaseId = env.D1_DATABASE_ID && typeof env.D1_DATABASE_ID === 'string' ? env.D1_DATABASE_ID.trim() : '';
      const d1ApiToken = env.D1_API_TOKEN && typeof env.D1_API_TOKEN === 'string' ? env.D1_API_TOKEN.trim() : '';
      const d1TableName = env.D1_TABLE_NAME && typeof env.D1_TABLE_NAME === 'string' ? env.D1_TABLE_NAME.trim() : '';

      if (d1AccountId && d1DatabaseId && d1ApiToken && windowTimeSeconds > 0 && ipSubnetLimit > 0) {
        rateLimitEnabled = true;
        rateLimitConfig = {
          accountId: d1AccountId,
          databaseId: d1DatabaseId,
          apiToken: d1ApiToken,
          tableName: d1TableName || 'IP_LIMIT_TABLE',
          windowTimeSeconds,
          limit: ipSubnetLimit,
          ipv4Suffix,
          ipv6Suffix,
          pgErrorHandle: validPgErrorHandle,
          cleanupProbability,
          blockTimeSeconds,
        };
        if (sizeTTLSeconds > 0) {
          cacheEnabled = true;
          cacheConfig = {
            accountId: d1AccountId,
            databaseId: d1DatabaseId,
            apiToken: d1ApiToken,
            tableName: filesizeCacheTableName,
            sizeTTL: sizeTTLSeconds,
            cleanupProbability,
          };
        }
      } else {
        throw new Error('DB_MODE is set to "d1-rest" but required environment variables are missing: D1_ACCOUNT_ID, D1_DATABASE_ID, D1_API_TOKEN, WINDOW_TIME, IPSUBNET_WINDOWTIME_LIMIT');
      }
    } else if (normalizedDbMode === 'custom-pg-rest') {
      // Custom PostgreSQL REST API (PostgREST) configuration
      const postgrestUrl = env.POSTGREST_URL && typeof env.POSTGREST_URL === 'string' ? env.POSTGREST_URL.trim() : '';
      const postgrestTableName = env.POSTGREST_TABLE_NAME && typeof env.POSTGREST_TABLE_NAME === 'string' ? env.POSTGREST_TABLE_NAME.trim() : '';

      if (postgrestUrl && verifyHeaders.length > 0 && verifySecrets.length > 0 && windowTimeSeconds > 0 && ipSubnetLimit > 0) {
        rateLimitEnabled = true;
        rateLimitConfig = {
          postgrestUrl,
          verifyHeader: verifyHeaders,
          verifySecret: verifySecrets,
          tableName: postgrestTableName || 'IP_LIMIT_TABLE',
          windowTimeSeconds,
          limit: ipSubnetLimit,
          ipv4Suffix,
          ipv6Suffix,
          pgErrorHandle: validPgErrorHandle,
          cleanupProbability,
          blockTimeSeconds,
        };
        if (sizeTTLSeconds > 0) {
          cacheEnabled = true;
          cacheConfig = {
            postgrestUrl,
            verifyHeader: verifyHeaders,
            verifySecret: verifySecrets,
            tableName: filesizeCacheTableName,
            sizeTTL: sizeTTLSeconds,
            cleanupProbability,
          };
          console.log('[CONFIG] Cache ENABLED for custom-pg-rest:', {
            tableName: filesizeCacheTableName,
            sizeTTL: sizeTTLSeconds,
            postgrestUrl,
            hasVerifyHeader: verifyHeaders.length > 0,
            hasVerifySecret: verifySecrets.length > 0,
          });
        } else {
          console.warn('[CONFIG] Cache DISABLED: sizeTTLSeconds =', sizeTTLSeconds);
        }
      } else {
        throw new Error('DB_MODE is set to "custom-pg-rest" but required environment variables are missing: POSTGREST_URL, VERIFY_HEADER, VERIFY_SECRET, WINDOW_TIME, IPSUBNET_WINDOWTIME_LIMIT');
      }
    } else {
      throw new Error(`Invalid DB_MODE: "${dbMode}". Valid options are: "d1", "d1-rest", "custom-pg-rest"`);
    }
  }

  const appendAdditional = parseBoolean(env.IF_APPEND_ADDITIONAL, true);
  const addressCandidates = [
    typeof env.ALIST_ADDRESS === 'string' ? env.ALIST_ADDRESS.trim() : '',
    typeof env.ALIST_BASE_URL === 'string' ? env.ALIST_BASE_URL.trim() : '',
    typeof env.ADDRESS === 'string' ? env.ADDRESS.trim() : '',
  ];
  const rawAlistAddress = addressCandidates.find((value) => value) || '';
  const normalizedAlistAddress = rawAlistAddress.replace(/\/$/, '');
  const minBandwidthMbps = parseNumber(env.MIN_ALLOWED_BANDWIDTH, 10);
  const bandwidthBytesPerSecond = minBandwidthMbps > 0
    ? (minBandwidthMbps * 1_000_000) / 8
    : (10 * 1_000_000) / 8;
  const minDurationLabel = env.MIN_DURATION_TIME && typeof env.MIN_DURATION_TIME === 'string'
    ? env.MIN_DURATION_TIME.trim()
    : '';
  const parsedMinDurationSeconds = parseWindowTime(minDurationLabel);
  const minDurationSeconds = parsedMinDurationSeconds > 0 ? parsedMinDurationSeconds : 3600;

  if (appendAdditional && !normalizedAlistAddress) {
    throw new Error('ALIST_ADDRESS (or ADDRESS) is required when IF_APPEND_ADDITIONAL is true');
  }

  return {
    token: env.TOKEN,
    workerAddresses: env.WORKER_ADDRESS_DOWNLOAD,
    verifyHeader: verifyHeaders,
    verifySecret: verifySecrets,
    ipv4Only: parseBoolean(env.IPV4_ONLY, false),
    signSecret: env.SIGN_SECRET && env.SIGN_SECRET.trim() !== '' ? env.SIGN_SECRET : env.TOKEN,
    underAttack,
    fastRedirect: parseBoolean(env.FAST_REDIRECT, false),
    turnstileSiteKey,
    turnstileSecretKey,
    turnstileTokenBindingEnabled,
    turnstileTokenTTL: rawTurnstileTokenTTL,
    turnstileTokenTTLSeconds,
    turnstileTokenTableName,
    blacklistPrefixes,
    whitelistPrefixes,
    blacklistAction,
    whitelistAction,
    exceptPrefixes,
    exceptAction,
    // Rate limit configuration
    dbMode,
    rateLimitEnabled,
    rateLimitConfig,
    cacheEnabled,
    cacheConfig,
    sizeTTL,
    sizeTTLSeconds,
    filesizeCacheTableName,
    windowTime,
    ipSubnetLimit,
    appendAdditional,
    alistAddress: normalizedAlistAddress,
    minBandwidthBytesPerSecond: bandwidthBytesPerSecond,
    minDurationSeconds,
  };
};

const verifyTurnstileToken = async (secretKey, token, remoteIP) => {
  if (!token) {
    return { ok: false, message: 'turnstile token missing' };
  }
  if (!secretKey) {
    return { ok: false, message: 'turnstile secret missing' };
  }
  const payload = new URLSearchParams();
  payload.set('secret', secretKey);
  payload.set('response', token);
  const normalizedRemoteIP =
    typeof remoteIP === 'string' ? remoteIP.trim() : '';
  if (normalizedRemoteIP) {
    payload.set('remoteip', normalizedRemoteIP);
  }
  const response = await fetch(TURNSTILE_VERIFY_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: payload,
  });
  if (!response.ok) {
    return { ok: false, message: `turnstile verify http ${response.status}` };
  }
  let result;
  try {
    result = await response.json();
  } catch (error) {
    return { ok: false, message: 'turnstile verify parse failed' };
  }
  if (!result.success) {
    const errorCodes = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
    const reason = errorCodes.length > 0 ? String(errorCodes[0]) : 'turnstile verification failed';
    return { ok: false, message: reason };
  }
  return { ok: true };
};

const computeHmac = async (secret, payload) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const buf = await crypto.subtle.sign(
    { name: 'HMAC', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(payload),
  );
  return new Uint8Array(buf);
};

const encodeUrlSafeBase64 = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

const hmacSha256Sign = async (secret, data, expire) => {
  const bytes = await computeHmac(secret, `${data}:${expire}`);
  return `${encodeUrlSafeBase64(bytes)}:${expire}`;
};

const verifySignature = async (secret, data, signature) => {
  if (!signature) return 'sign missing';
  const parts = signature.split(':');
  const expirePart = parts[parts.length - 1];
  if (!expirePart) return 'expire missing';
  const expire = Number.parseInt(expirePart, 10);
  if (Number.isNaN(expire)) return 'expire invalid';
  if (expire < Date.now() / 1e3 && expire > 0) return 'expire expired';
  const expected = await hmacSha256Sign(secret, data, expire);
  if (expected !== signature) return 'sign mismatch';
  return '';
};

const extractExpireFromSign = (signature) => {
  if (!signature) return 0;
  const parts = signature.split(':');
  const expirePart = parts[parts.length - 1];
  if (!expirePart) return 0;
  const expire = Number.parseInt(expirePart, 10);
  return Number.isNaN(expire) ? 0 : expire;
};

const safeHeaders = (origin) => {
  const headers = new Headers();
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.append('Vary', 'Origin');
  } else {
    headers.set('Access-Control-Allow-Origin', '*');
  }
  headers.set('Access-Control-Allow-Headers', '*');
  headers.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  return headers;
};

const respondJson = (origin, payload, status = 200) => {
  const headers = safeHeaders(origin);
  headers.set('content-type', 'application/json;charset=UTF-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(payload), { status, headers });
};

const respondRateLimitExceeded = (origin, ipSubnet, limit, windowTime, retryAfter) => {
  const headers = safeHeaders(origin);
  headers.set('content-type', 'application/json;charset=UTF-8');
  headers.set('cache-control', 'no-store');
  const retryAfterSeconds = Math.ceil(retryAfter);
  headers.set('Retry-After', String(retryAfterSeconds));
  const message = `${ipSubnet} exceeds the limit of ${limit} requests in ${windowTime}`;
  return new Response(JSON.stringify({
    code: 429,
    message,
    'retry-after': retryAfterSeconds
  }), { status: 429, headers });
};

const extractClientIP = (request) => {
  const raw = request.headers.get('CF-Connecting-IP');
  if (!raw) return '';
  const [first] = raw.split(',');
  return first ? first.trim() : '';
};

const ensureIPv4 = (request, ipv4Only) => {
  if (!ipv4Only) return null;
  const clientIP = extractClientIP(request);
  if (clientIP.includes(':')) {
    return respondJson(
      request.headers.get('origin') || '*',
      { code: 403, message: 'ipv6 access is prohibited' },
      403,
    );
  }
  return null;
};

const selectRandomWorker = (workerAddresses) => {
  if (!workerAddresses || typeof workerAddresses !== 'string') {
    throw new Error('WORKER_ADDRESS_DOWNLOAD is not configured');
  }
  const addresses = workerAddresses
    .split(',')
    .map((addr) => addr.trim())
    .filter((addr) => addr.length > 0);

  if (addresses.length === 0) {
    throw new Error('WORKER_ADDRESS_DOWNLOAD contains no valid addresses');
  }

  const selected = addresses[Math.floor(Math.random() * addresses.length)];
  return selected.replace(/\/$/, '');
};

const encodeTextToBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  return uint8ToBase64(bytes);
};

const parseFileSize = (rawSize) => {
  if (typeof rawSize === 'number' && Number.isFinite(rawSize)) {
    return rawSize;
  }
  if (typeof rawSize === 'string') {
    const parsed = Number.parseInt(rawSize, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

const calculateExpireTimestamp = (sizeBytes, minDurationSeconds, bandwidthBytesPerSecond) => {
  const safeMinDuration = minDurationSeconds > 0 ? minDurationSeconds : 3600;
  const safeBandwidth = bandwidthBytesPerSecond > 0 ? bandwidthBytesPerSecond : (10 * 1_000_000) / 8;
  const estimatedDuration = sizeBytes > 0 ? Math.ceil(sizeBytes / safeBandwidth) : 0;
  const totalDuration = Math.max(safeMinDuration, estimatedDuration);
  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds + totalDuration;
};

const fetchAlistFileInfo = async (config, path, clientIP) => {
  if (!config.alistAddress) {
    throw new Error('alist address is not configured');
  }

  const headers = {
    'content-type': 'application/json;charset=UTF-8',
    Authorization: config.token,
  };
  if (clientIP) {
    headers['CF-Connecting-IP-WORKERS'] = clientIP;
  }
  applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);

  const response = await fetch(`${config.alistAddress}/api/fs/get`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      path,
    }),
  });

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('alist fs/get response is not json');
  }

  const payload = await response.json();
  if (!response.ok || payload.code !== 200 || !payload.data) {
    const message = payload && typeof payload.message === 'string' && payload.message.trim() !== ''
      ? payload.message
      : `alist fs/get failed with http ${response.status}`;
    throw new Error(message);
  }

  return payload.data;
};

const createAdditionalParams = async (config, decodedPath, clientIP, options = {}) => {
  if (!config.appendAdditional) return null;
  let { sizeBytes, expireTime, fileInfo } = options;

  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    if (!fileInfo) {
      fileInfo = await fetchAlistFileInfo(config, decodedPath, clientIP);
    }
    sizeBytes = parseFileSize(fileInfo?.size);
  }

  if (!Number.isFinite(expireTime) || expireTime <= 0) {
    expireTime = calculateExpireTimestamp(sizeBytes, config.minDurationSeconds, config.minBandwidthBytesPerSecond);
  }

  const pathHash = await sha256Hash(decodedPath);
  const payload = JSON.stringify({
    pathHash,
    expireTime,
  });
  const rawAdditionalInfo = encodeTextToBase64(payload);
  const additionalInfo = rawAdditionalInfo.replace(/=+$/, '');
  const additionalInfoSign = await hmacSha256Sign(config.signSecret, additionalInfo, expireTime);
  return { additionalInfo, additionalInfoSign };
};

const createDownloadURL = async (config, { encodedPath, decodedPath, sign, clientIP, sizeBytes, expireTime, fileInfo }) => {
  const expire = extractExpireFromSign(sign);

  const pathBytes = new TextEncoder().encode(decodedPath);
  const base64Path = uint8ToBase64(pathBytes);
  const hashSign = await hmacSha256Sign(config.signSecret, base64Path, expire);

  const workerBaseURL = selectRandomWorker(config.workerAddresses);
  const workerSignData = JSON.stringify({ path: decodedPath, worker_addr: workerBaseURL });
  const workerSign = await hmacSha256Sign(config.signSecret, workerSignData, expire);

  const ipSignData = JSON.stringify({ path: decodedPath, ip: clientIP });
  const ipSign = await hmacSha256Sign(config.signSecret, ipSignData, expire);

  const downloadURLObj = new URL(encodedPath, workerBaseURL);
  downloadURLObj.searchParams.set('sign', sign);
  downloadURLObj.searchParams.set('hashSign', hashSign);
  downloadURLObj.searchParams.set('workerSign', workerSign);
  downloadURLObj.searchParams.set('ipSign', ipSign);

  if (config.appendAdditional) {
    const additionalParams = await createAdditionalParams(config, decodedPath, clientIP, {
      sizeBytes,
      expireTime,
      fileInfo,
    });
    if (additionalParams) {
      downloadURLObj.searchParams.set('additionalInfo', additionalParams.additionalInfo);
      downloadURLObj.searchParams.set('additionalInfoSign', additionalParams.additionalInfoSign);
    }
  }

  return downloadURLObj.toString();
};

const checkPathListAction = (path, config) => {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(path);
  } catch (error) {
    // If path cannot be decoded, use as-is
    decodedPath = path;
  }

  // Check blacklist first (higher priority)
  if (config.blacklistPrefixes.length > 0 && config.blacklistAction) {
    for (const prefix of config.blacklistPrefixes) {
      if (decodedPath.startsWith(prefix)) {
        return config.blacklistAction;
      }
    }
  }

  // Check whitelist second
  if (config.whitelistPrefixes.length > 0 && config.whitelistAction) {
    for (const prefix of config.whitelistPrefixes) {
      if (decodedPath.startsWith(prefix)) {
        return config.whitelistAction;
      }
    }
  }

  // Check except third (inverse logic)
  if (config.exceptPrefixes.length > 0 && config.exceptAction) {
    // Check if path matches any except prefix
    let matchesExceptPrefix = false;
    for (const prefix of config.exceptPrefixes) {
      if (decodedPath.startsWith(prefix)) {
        matchesExceptPrefix = true;
        break;
      }
    }
    // If path does NOT match any except prefix, apply the except action
    if (!matchesExceptPrefix) {
      return config.exceptAction;
    }
  }

  // No match - undefined action
  return null;
};

const handleOptions = (request) => new Response(null, { headers: safeHeaders(request.headers.get('Origin')) });

const handleInfo = async (request, config, rateLimiter, ctx) => {
  const origin = request.headers.get('origin') || '*';
  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  const sign = url.searchParams.get('sign') || '';

  if (!path) {
    return respondJson(origin, { code: 400, message: 'path is required' }, 400);
  }

  const clientIP = extractClientIP(request);
  const rawTurnstileToken =
    request.headers.get(TURNSTILE_HEADER) ||
    request.headers.get('x-turnstile-token') ||
    url.searchParams.get(TURNSTILE_HEADER) ||
    url.searchParams.get('turnstile_token') ||
    '';

  // Check blacklist/whitelist
  const action = checkPathListAction(path, config);

  // Handle block action
  if (action === 'block') {
    return respondJson(origin, { code: 403, message: 'access denied' }, 403);
  }

  // Determine if we need verification
  const forceVerify = action === 'verify';
  const skipVerify = action === 'pass-web' || action === 'pass-server' || action === 'pass-asis';
  const needVerify = forceVerify || (config.underAttack && !skipVerify);

  const hasDbMode = typeof config.dbMode === 'string'
    ? config.dbMode.length > 0
    : Boolean(config.dbMode);
  const tokenTTLSeconds = Number(config.turnstileTokenTTLSeconds) || 0;
  const tokenTableName = config.turnstileTokenTableName || 'TURNSTILE_TOKEN_BINDING';

  let tokenHash = null;
  if (config.turnstileTokenBindingEnabled && rawTurnstileToken) {
    try {
      tokenHash = await sha256Hash(rawTurnstileToken);
    } catch (error) {
      console.error('[Turnstile Binding] Failed to hash token:', error instanceof Error ? error.message : String(error));
    }
  }

  const shouldBindToken = Boolean(
    config.turnstileTokenBindingEnabled &&
    tokenHash &&
    clientIP &&
    tokenTTLSeconds > 0 &&
    hasDbMode
  );

  let tokenBindingAllowed = !shouldBindToken;
  let tokenBindingErrorCode = 0;
  let shouldRecordTokenBinding = false;

  const scheduleTokenBindingInsert = (filepathHashValue) => {
    if (!shouldBindToken || !tokenHash || !clientIP) {
      return;
    }
    if (!filepathHashValue) {
      console.error('[Turnstile Binding] Missing filepath hash; cannot insert token binding');
      return;
    }
    if (!Number.isFinite(tokenTTLSeconds) || tokenTTLSeconds <= 0) {
      console.warn('[Turnstile Binding] Skipping token insert due to invalid TTL:', tokenTTLSeconds);
      return;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = nowSeconds + tokenTTLSeconds;

    if (config.dbMode === 'custom-pg-rest') {
      const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        console.error('[Turnstile Binding] PostgREST URL missing; cannot insert token binding');
        return;
      }
      const headers = {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal,resolution=ignore-duplicates',
      };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      const payload = {
        TOKEN_HASH: tokenHash,
        CLIENT_IP: clientIP,
        FILEPATH_HASH: filepathHashValue,
        ACCESS_COUNT: 0,
        CREATED_AT: nowSeconds,
        UPDATED_AT: nowSeconds,
        EXPIRES_AT: expiresAt,
      };
      ctx.waitUntil((async () => {
        try {
          const endpoint = new URL(`${postgrestUrl}/${tokenTableName}`);
          const response = await fetch(endpoint.toString(), {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
          });
          if (!response.ok && response.status !== 409) {
            const errorText = await response.text().catch(() => '');
            console.error('[Turnstile Binding] PostgREST insert failed:', response.status, errorText);
          }
        } catch (error) {
          console.error('[Turnstile Binding] PostgREST insert error:', error instanceof Error ? error.message : String(error));
        }
      })());
    } else if (config.dbMode === 'd1') {
      const envSource = config.cacheConfig?.env || config.rateLimitConfig?.env;
      const bindingName = config.cacheConfig?.databaseBinding || config.rateLimitConfig?.databaseBinding || 'DB';
      const db = envSource ? envSource[bindingName] : null;
      if (!db) {
        console.error('[Turnstile Binding] D1 binding not available; cannot insert token binding');
        return;
      }
      const statement = db.prepare(`
        INSERT INTO ${tokenTableName} (TOKEN_HASH, CLIENT_IP, FILEPATH_HASH, ACCESS_COUNT, CREATED_AT, UPDATED_AT, EXPIRES_AT)
        VALUES (?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(TOKEN_HASH) DO NOTHING
      `).bind(tokenHash, clientIP, filepathHashValue, nowSeconds, nowSeconds, expiresAt);
      ctx.waitUntil((async () => {
        try {
          await statement.run();
        } catch (error) {
          console.error('[Turnstile Binding] D1 insert failed:', error instanceof Error ? error.message : String(error));
        }
      })());
    } else if (config.dbMode === 'd1-rest') {
      const accountId = config.rateLimitConfig?.accountId || config.cacheConfig?.accountId;
      const databaseId = config.rateLimitConfig?.databaseId || config.cacheConfig?.databaseId;
      const apiToken = config.rateLimitConfig?.apiToken || config.cacheConfig?.apiToken;
      if (!accountId || !databaseId || !apiToken) {
        console.error('[Turnstile Binding] D1 REST credentials missing; cannot insert token binding');
        return;
      }
      const sql = `
        INSERT INTO ${tokenTableName} (TOKEN_HASH, CLIENT_IP, FILEPATH_HASH, ACCESS_COUNT, CREATED_AT, UPDATED_AT, EXPIRES_AT)
        VALUES (?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(TOKEN_HASH) DO NOTHING
      `;
      const body = {
        sql,
        params: [tokenHash, clientIP, filepathHashValue, nowSeconds, nowSeconds, expiresAt],
      };
      ctx.waitUntil((async () => {
        try {
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            }
          );
          if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.error('[Turnstile Binding] D1 REST insert failed:', response.status, text);
          }
        } catch (error) {
          console.error('[Turnstile Binding] D1 REST insert error:', error instanceof Error ? error.message : String(error));
        }
      })());
    }
  };

  const scheduleTokenBindingWrite = (filepathHashValue) => {
    if (!shouldRecordTokenBinding || !tokenHash || !clientIP) {
      return;
    }
    if (!filepathHashValue) {
      console.error('[Turnstile Binding] Missing filepath hash; cannot update token binding');
      return;
    }
    if (!Number.isFinite(tokenTTLSeconds) || tokenTTLSeconds <= 0) {
      console.warn('[Turnstile Binding] Skipping token update due to invalid TTL:', tokenTTLSeconds);
      return;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = nowSeconds + tokenTTLSeconds;

    if (config.dbMode === 'custom-pg-rest') {
      const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        console.error('[Turnstile Binding] PostgREST URL missing; cannot update token binding');
        return;
      }
      const headers = {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      ctx.waitUntil((async () => {
        try {
          const endpoint = new URL(`${postgrestUrl}/${tokenTableName}`);
          endpoint.searchParams.set('TOKEN_HASH', `eq.${tokenHash}`);
          endpoint.searchParams.set('CLIENT_IP', `eq.${clientIP}`);
          endpoint.searchParams.set('FILEPATH_HASH', `eq.${filepathHashValue}`);
          const response = await fetch(endpoint.toString(), {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              ACCESS_COUNT: 1,
              UPDATED_AT: nowSeconds,
              EXPIRES_AT: expiresAt,
            }),
          });
          if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            console.error('[Turnstile Binding] PostgREST update failed:', response.status, errorText);
          }
        } catch (error) {
          console.error('[Turnstile Binding] PostgREST update error:', error instanceof Error ? error.message : String(error));
        }
      })());
    } else if (config.dbMode === 'd1') {
      const envSource = config.cacheConfig?.env || config.rateLimitConfig?.env;
      const bindingName = config.cacheConfig?.databaseBinding || config.rateLimitConfig?.databaseBinding || 'DB';
      const db = envSource ? envSource[bindingName] : null;
      if (!db) {
        console.error('[Turnstile Binding] D1 binding not available; cannot update token binding');
        return;
      }
      const statement = db.prepare(`
        UPDATE ${tokenTableName}
        SET ACCESS_COUNT = MIN(ACCESS_COUNT + 1, 2147483647),
            UPDATED_AT = ?,
            EXPIRES_AT = CASE
              WHEN EXPIRES_AT IS NULL OR EXPIRES_AT < ? THEN ?
              ELSE EXPIRES_AT
            END
        WHERE TOKEN_HASH = ? AND CLIENT_IP = ? AND FILEPATH_HASH = ?
      `).bind(nowSeconds, expiresAt, expiresAt, tokenHash, clientIP, filepathHashValue);
      ctx.waitUntil((async () => {
        try {
          await statement.run();
        } catch (error) {
          console.error('[Turnstile Binding] D1 update failed:', error instanceof Error ? error.message : String(error));
        }
      })());
    } else if (config.dbMode === 'd1-rest') {
      const accountId = config.rateLimitConfig?.accountId || config.cacheConfig?.accountId;
      const databaseId = config.rateLimitConfig?.databaseId || config.cacheConfig?.databaseId;
      const apiToken = config.rateLimitConfig?.apiToken || config.cacheConfig?.apiToken;
      if (!accountId || !databaseId || !apiToken) {
        console.error('[Turnstile Binding] D1 REST credentials missing; cannot update token binding');
        return;
      }
      const sql = `
        UPDATE ${tokenTableName}
        SET ACCESS_COUNT = MIN(ACCESS_COUNT + 1, 2147483647),
            UPDATED_AT = ?,
            EXPIRES_AT = CASE
              WHEN EXPIRES_AT IS NULL OR EXPIRES_AT < ? THEN ?
              ELSE EXPIRES_AT
            END
        WHERE TOKEN_HASH = ? AND CLIENT_IP = ? AND FILEPATH_HASH = ?
      `;
      const body = {
        sql,
        params: [nowSeconds, expiresAt, expiresAt, tokenHash, clientIP, filepathHashValue],
      };
      ctx.waitUntil((async () => {
        try {
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            }
          );
          if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.error('[Turnstile Binding] D1 REST update failed:', response.status, text);
          }
        } catch (error) {
          console.error('[Turnstile Binding] D1 REST update error:', error instanceof Error ? error.message : String(error));
        }
      })());
    }
  };

  const encodedPath = path;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(path);
  } catch (error) {
    return respondJson(origin, { code: 400, message: 'invalid path encoding' }, 400);
  }

  let filepathHash = null;
  if (shouldBindToken && decodedPath) {
    try {
      filepathHash = await sha256Hash(decodedPath);
    } catch (error) {
      console.error('[Turnstile Binding] Failed to hash filepath:', error instanceof Error ? error.message : String(error));
    }
  }

  if (needVerify) {
    if (!rawTurnstileToken) {
      return respondJson(origin, { code: 461, message: 'turnstile token required' }, 403);
    }
    const verification = await verifyTurnstileToken(config.turnstileSecretKey, rawTurnstileToken, clientIP);
    if (!verification.ok) {
      return respondJson(origin, { code: 462, message: verification.message || 'turnstile verification failed' }, 403);
    }
    if (shouldBindToken) {
      scheduleTokenBindingInsert(filepathHash);
    }
  }

  const verifyResult = await verifySignature(config.signSecret, decodedPath, sign);
  if (verifyResult) {
    return respondJson(origin, { code: 401, message: verifyResult }, 401);
  }

  const expire = extractExpireFromSign(sign);
  const recalculatedSign = await hmacSha256Sign(config.signSecret, decodedPath, expire);
  if (recalculatedSign !== sign) {
    return respondJson(
      origin,
      { code: 500, message: 'sign algorithm mismatch - internal error' },
      500
    );
  }

  const cacheManager = config.cacheEnabled ? createCacheManager(config.dbMode) : null;
  const cacheConfigWithCtx = cacheManager && config.cacheEnabled
    ? { ...config.cacheConfig, ctx }
    : null;

  console.log('[CACHE] Cache initialization:', {
    cacheEnabled: config.cacheEnabled,
    hasCacheManager: !!cacheManager,
    hasCacheConfig: !!cacheConfigWithCtx,
    cacheConfigKeys: cacheConfigWithCtx ? Object.keys(cacheConfigWithCtx) : [],
  });

  const hasCacheSupport = Boolean(cacheManager && config.cacheEnabled);
  const canUseUnified = Boolean(
    config.rateLimitEnabled &&
    hasDbMode &&
    clientIP &&
    (hasCacheSupport || shouldBindToken)
  );

  console.log('[CACHE] Unified check eligibility:', {
    canUseUnified,
    hasCacheManager: !!cacheManager,
    cacheEnabled: config.cacheEnabled,
    rateLimitEnabled: config.rateLimitEnabled,
    dbMode: config.dbMode,
    hasClientIP: !!clientIP,
    shouldBindToken,
  });

  if (shouldBindToken && !canUseUnified) {
    console.error('[Turnstile Binding] Token binding enabled but unified check is unavailable');
    return respondJson(origin, { code: 500, message: 'turnstile token binding unavailable' }, 500);
  }

  let unifiedResult = null;
  let cacheHit = false;
  let sizeBytes = 0;
  let fileInfo = null;

  if (canUseUnified) {
    try {
      console.log(`[Unified Check] Using unified check for mode=${config.dbMode}`);
      const limitValue = config.rateLimitConfig?.limit ?? config.ipSubnetLimit;

      if (config.dbMode === 'custom-pg-rest') {
        const unifiedConfig = {
          postgrestUrl: config.rateLimitConfig.postgrestUrl,
          verifyHeader: config.rateLimitConfig.verifyHeader,
          verifySecret: config.rateLimitConfig.verifySecret,
          sizeTTL: config.cacheConfig.sizeTTL ?? config.sizeTTLSeconds,
          cacheTableName: config.cacheConfig.tableName || config.filesizeCacheTableName || 'FILESIZE_CACHE_TABLE',
          windowTimeSeconds: config.rateLimitConfig.windowTimeSeconds,
          limit: limitValue,
          blockTimeSeconds: config.rateLimitConfig.blockTimeSeconds,
          rateLimitTableName: config.rateLimitConfig.tableName || 'IP_LIMIT_TABLE',
          ipv4Suffix: config.rateLimitConfig.ipv4Suffix,
          ipv6Suffix: config.rateLimitConfig.ipv6Suffix,
          turnstileTokenBinding: shouldBindToken,
          tokenHash,
          tokenIP: clientIP,
          tokenTTLSeconds: config.turnstileTokenTTLSeconds,
          tokenTableName: config.turnstileTokenTableName,
        };
        console.log('[Unified Check] Config for custom-pg-rest:', {
          postgrestUrl: unifiedConfig.postgrestUrl,
          hasVerifyHeader: Array.isArray(unifiedConfig.verifyHeader) ? unifiedConfig.verifyHeader.length : !!unifiedConfig.verifyHeader,
          hasVerifySecret: Array.isArray(unifiedConfig.verifySecret) ? unifiedConfig.verifySecret.length : !!unifiedConfig.verifySecret,
          sizeTTL: unifiedConfig.sizeTTL,
          cacheTableName: unifiedConfig.cacheTableName,
        });
        unifiedResult = await unifiedCheck(decodedPath, clientIP, unifiedConfig);
      } else if (config.dbMode === 'd1') {
        unifiedResult = await unifiedCheckD1(decodedPath, clientIP, {
          env: config.cacheConfig.env || config.rateLimitConfig.env,
          databaseBinding: config.cacheConfig.databaseBinding || config.rateLimitConfig.databaseBinding || 'DB',
          sizeTTL: config.cacheConfig.sizeTTL ?? config.sizeTTLSeconds,
          cacheTableName: config.cacheConfig.tableName || config.filesizeCacheTableName || 'FILESIZE_CACHE_TABLE',
          windowTimeSeconds: config.rateLimitConfig.windowTimeSeconds,
          limit: limitValue,
          blockTimeSeconds: config.rateLimitConfig.blockTimeSeconds,
          rateLimitTableName: config.rateLimitConfig.tableName || 'IP_LIMIT_TABLE',
          ipv4Suffix: config.rateLimitConfig.ipv4Suffix,
          ipv6Suffix: config.rateLimitConfig.ipv6Suffix,
          turnstileTokenBinding: shouldBindToken,
          tokenHash,
          tokenIP: clientIP,
          tokenTTLSeconds: config.turnstileTokenTTLSeconds,
          tokenTableName: config.turnstileTokenTableName,
        });
      } else if (config.dbMode === 'd1-rest') {
        unifiedResult = await unifiedCheckD1Rest(decodedPath, clientIP, {
          accountId: config.rateLimitConfig.accountId || config.cacheConfig.accountId,
          databaseId: config.rateLimitConfig.databaseId || config.cacheConfig.databaseId,
          apiToken: config.rateLimitConfig.apiToken || config.cacheConfig.apiToken,
          sizeTTL: config.cacheConfig.sizeTTL ?? config.sizeTTLSeconds,
          cacheTableName: config.cacheConfig.tableName || config.filesizeCacheTableName || 'FILESIZE_CACHE_TABLE',
          windowTimeSeconds: config.rateLimitConfig.windowTimeSeconds,
          limit: limitValue,
          blockTimeSeconds: config.rateLimitConfig.blockTimeSeconds,
          rateLimitTableName: config.rateLimitConfig.tableName || 'IP_LIMIT_TABLE',
          ipv4Suffix: config.rateLimitConfig.ipv4Suffix,
          ipv6Suffix: config.rateLimitConfig.ipv6Suffix,
          turnstileTokenBinding: shouldBindToken,
          tokenHash,
          tokenIP: clientIP,
          tokenTTLSeconds: config.turnstileTokenTTLSeconds,
          tokenTableName: config.turnstileTokenTableName,
        });
      } else {
        console.log('[Unified Check] Unsupported DB mode for unified check, falling back');
        unifiedResult = null;
      }

      if (unifiedResult) {
        if (shouldBindToken) {
          const tokenResult = unifiedResult.token || { allowed: true, errorCode: 0, accessCount: 0 };
          tokenBindingAllowed = tokenResult.allowed !== false;
          tokenBindingErrorCode = Number.isFinite(tokenResult.errorCode) ? tokenResult.errorCode : 0;

          if (!tokenBindingAllowed) {
            const tokenMessage = TOKEN_BINDING_ERROR_MESSAGES[tokenBindingErrorCode] || 'turnstile token binding failed';
            console.warn('[Turnstile Binding] Token rejected:', tokenMessage);
            return respondJson(origin, { code: 463, message: tokenMessage }, 403);
          }

          shouldRecordTokenBinding = true;
          console.log('[Turnstile Binding] Token accepted:', {
            accessCount: Number.isFinite(unifiedResult.token?.accessCount) ? unifiedResult.token.accessCount : null,
            errorCode: tokenBindingErrorCode,
          });
        } else {
          tokenBindingAllowed = true;
          tokenBindingErrorCode = 0;
        }

        if (!unifiedResult.rateLimit.allowed) {
          return respondRateLimitExceeded(
            origin,
            unifiedResult.rateLimit.ipSubnet || clientIP,
            config.ipSubnetLimit,
            config.windowTime,
            unifiedResult.rateLimit.retryAfter
          );
        }

        if (unifiedResult.cache.hit && Number.isFinite(unifiedResult.cache.size)) {
          sizeBytes = Number(unifiedResult.cache.size);
          cacheHit = true;
          console.log('[Filesize Cache] HIT via unified check');
        } else {
          console.log('[Filesize Cache] MISS via unified check');
        }
      }
    } catch (error) {
      console.error('[Unified Check] Failed:', error instanceof Error ? error.message : String(error));
      const pgHandle = config.rateLimitConfig?.pgErrorHandle || 'fail-closed';
      if (pgHandle === 'fail-open') {
        console.warn('[Unified Check] fail-open: continuing with standalone checks');
        unifiedResult = null;
        cacheHit = false;
        if (shouldBindToken) {
          console.warn('[Unified Check] Token binding DB unavailable, will fallback to stateless siteverify');
          tokenBindingAllowed = false;
          shouldRecordTokenBinding = false;
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        return respondJson(origin, { code: 500, message: `unified check failed: ${message}` }, 500);
      }
    }
  }

  // 当 unified check 未能启用 token binding 时，尝试回落到无状态的 Turnstile siteverify
  if (shouldBindToken && !tokenBindingAllowed && needVerify) {
    console.log('[Turnstile] Falling back to stateless siteverify (token binding DB unavailable)');
    const verification = await verifyTurnstileToken(
      config.turnstileSecretKey,
      rawTurnstileToken,
      clientIP
    );
    if (!verification.ok) {
      console.error('[Turnstile] Stateless verification failed:', verification.message);
      const pgHandle = config.rateLimitConfig?.pgErrorHandle || 'fail-closed';
      if (pgHandle === 'fail-closed') {
        return respondJson(origin, {
          code: 462,
          message: verification.message || 'turnstile verification failed'
        }, 403);
      }
      console.warn('[Turnstile] fail-open: allowing request despite verification failure');
    } else {
      console.log('[Turnstile] Stateless verification passed');
    }
  }

  if (shouldBindToken && !tokenBindingAllowed) {
    const pgHandle = config.rateLimitConfig?.pgErrorHandle || 'fail-closed';
    if (pgHandle === 'fail-open') {
      console.warn('[Turnstile Binding] Token binding unavailable; continuing without binding');
    } else {
      console.error('[Turnstile Binding] Token binding could not be validated');
      return respondJson(origin, { code: 500, message: 'turnstile token binding unavailable' }, 500);
    }
  }

  shouldRecordTokenBinding = shouldBindToken && tokenBindingAllowed;

  if (!canUseUnified || !unifiedResult) {
    if (rateLimiter && clientIP) {
      const rateLimitResult = await rateLimiter.checkRateLimit(clientIP, { ...config.rateLimitConfig, ctx });

      if (!rateLimitResult.allowed) {
        if (rateLimitResult.error) {
          return respondJson(origin, { code: 500, message: rateLimitResult.error }, 500);
        }
        return respondRateLimitExceeded(
          origin,
          rateLimitResult.ipSubnet,
          config.ipSubnetLimit,
          config.windowTime,
          rateLimitResult.retryAfter
        );
      }
    }

    if (!cacheHit && cacheManager && cacheConfigWithCtx) {
      console.log('[CACHE] Starting standalone cache check for path:', decodedPath);
      try {
        const cached = await cacheManager.checkCache(decodedPath, cacheConfigWithCtx);
        if (cached && Number.isFinite(cached.size)) {
          sizeBytes = Number(cached.size);
          cacheHit = true;
          console.log('[Filesize Cache] HIT via standalone lookup');
        } else {
          console.log('[Filesize Cache] MISS via standalone lookup');
        }
      } catch (error) {
        console.error('[Filesize Cache] Standalone cache check failed:', error instanceof Error ? error.message : String(error));
      }
    } else {
      console.log('[CACHE] Skipping standalone cache check:', {
        cacheHit,
        hasCacheManager: !!cacheManager,
        hasCacheConfig: !!cacheConfigWithCtx,
      });
    }
  }

  if (!cacheHit) {
    try {
      fileInfo = await fetchAlistFileInfo(config, decodedPath, clientIP);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'alist fs/get failed';
      return respondJson(origin, { code: 500, message }, 500);
    }
    sizeBytes = parseFileSize(fileInfo?.size);
    if (cacheManager && cacheConfigWithCtx) {
      console.log('[CACHE] Attempting to save cache:', {
        path: decodedPath,
        size: sizeBytes,
        configKeys: Object.keys(cacheConfigWithCtx),
      });
      ctx.waitUntil(
        cacheManager
          .saveCache(decodedPath, sizeBytes, cacheConfigWithCtx)
          .then(() => {
            console.log('[Filesize Cache] Saved filesize to cache');
          })
          .catch((error) => {
            console.error('[Filesize Cache] Save failed:', error instanceof Error ? error.message : String(error));
          })
      );
    } else {
      console.log('[CACHE] Skipping cache save:', {
        hasCacheManager: !!cacheManager,
        hasCacheConfig: !!cacheConfigWithCtx,
      });
    }
  }

  const expireTime = calculateExpireTimestamp(sizeBytes, config.minDurationSeconds, config.minBandwidthBytesPerSecond);
  const downloadURL = await createDownloadURL(config, {
    encodedPath,
    decodedPath,
    sign,
    clientIP,
    sizeBytes,
    expireTime,
    fileInfo,
  });

  const responsePayload = {
    code: 200,
    data: {
      download: {
        url: downloadURL,
      },
      meta: {
        path: decodedPath,
      },
      settings: {
        underAttack: needVerify,
      },
    },
  };
  scheduleTokenBindingWrite(filepathHash);
  return respondJson(origin, responsePayload, 200);
};

const handleFileRequest = async (request, config, rateLimiter, ctx) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return respondJson(request.headers.get('origin') || '*', { code: 405, message: 'method not allowed' }, 405);
  }
  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=UTF-8',
        'cache-control': 'no-store',
      },
    });
  }

  const url = new URL(request.url);

  // Check blacklist/whitelist
  const action = checkPathListAction(url.pathname, config);

  // Handle block action
  if (action === 'block') {
    return respondJson(request.headers.get('origin') || '*', { code: 403, message: 'access denied' }, 403);
  }

  // Determine behavior based on action
  const forceVerify = action === 'verify';
  const skipVerify = action === 'pass-web' || action === 'pass-server' || action === 'pass-asis';
  const forceWeb = action === 'pass-web';
  const forceRedirect = action === 'pass-server';

  // Determine if we need verification
  const needVerify = forceVerify || (config.underAttack && !skipVerify);

  // Determine if we should do fast redirect
  const shouldRedirect = forceRedirect || (config.fastRedirect && !forceWeb && !needVerify);

  // Fast redirect logic
  if (shouldRedirect) {
    const origin = request.headers.get('origin') || '*';
    const sign = url.searchParams.get('sign') || '';
    const encodedPath = url.pathname;
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch (error) {
      return respondJson(origin, { code: 400, message: 'invalid path encoding' }, 400);
    }

    // Verify signature
    const verifyResult = await verifySignature(config.signSecret, decodedPath, sign);
    if (verifyResult) {
      return respondJson(origin, { code: 401, message: verifyResult }, 401);
    }

    const clientIP = extractClientIP(request);

    const cacheManager = config.cacheEnabled ? createCacheManager(config.dbMode) : null;
    const cacheConfigWithCtx = cacheManager && config.cacheEnabled
      ? { ...config.cacheConfig, ctx }
      : null;

    console.log('[Fast Redirect][CACHE] Cache initialization:', {
      cacheEnabled: config.cacheEnabled,
      hasCacheManager: !!cacheManager,
      hasCacheConfig: !!cacheConfigWithCtx,
      cacheConfigKeys: cacheConfigWithCtx ? Object.keys(cacheConfigWithCtx) : [],
    });

    const canUseUnified = Boolean(
      cacheManager &&
      config.cacheEnabled &&
      config.rateLimitEnabled &&
      config.dbMode &&
      clientIP
    );

    console.log('[Fast Redirect][CACHE] Unified check eligibility:', {
      canUseUnified,
      hasCacheManager: !!cacheManager,
      cacheEnabled: config.cacheEnabled,
      rateLimitEnabled: config.rateLimitEnabled,
      dbMode: config.dbMode,
      hasClientIP: !!clientIP,
    });

    let unifiedResult = null;
    let cacheHit = false;
    let sizeBytes = 0;
    let fileInfo = null;

    if (canUseUnified) {
      try {
        console.log(`[Fast Redirect][Unified Check] Using unified check for mode=${config.dbMode}`);
        const limitValue = config.rateLimitConfig?.limit ?? config.ipSubnetLimit;

        if (config.dbMode === 'custom-pg-rest') {
          const unifiedConfig = {
            postgrestUrl: config.rateLimitConfig.postgrestUrl,
            verifyHeader: config.rateLimitConfig.verifyHeader,
            verifySecret: config.rateLimitConfig.verifySecret,
            sizeTTL: config.cacheConfig.sizeTTL ?? config.sizeTTLSeconds,
            cacheTableName: config.cacheConfig.tableName || config.filesizeCacheTableName || 'FILESIZE_CACHE_TABLE',
            windowTimeSeconds: config.rateLimitConfig.windowTimeSeconds,
            limit: limitValue,
            blockTimeSeconds: config.rateLimitConfig.blockTimeSeconds,
            rateLimitTableName: config.rateLimitConfig.tableName || 'IP_LIMIT_TABLE',
            ipv4Suffix: config.rateLimitConfig.ipv4Suffix,
            ipv6Suffix: config.rateLimitConfig.ipv6Suffix,
          };
          console.log('[Fast Redirect][Unified Check] Config for custom-pg-rest:', {
            postgrestUrl: unifiedConfig.postgrestUrl,
            hasVerifyHeader: Array.isArray(unifiedConfig.verifyHeader) ? unifiedConfig.verifyHeader.length : !!unifiedConfig.verifyHeader,
            hasVerifySecret: Array.isArray(unifiedConfig.verifySecret) ? unifiedConfig.verifySecret.length : !!unifiedConfig.verifySecret,
            sizeTTL: unifiedConfig.sizeTTL,
            cacheTableName: unifiedConfig.cacheTableName,
          });
          unifiedResult = await unifiedCheck(decodedPath, clientIP, unifiedConfig);
        } else if (config.dbMode === 'd1') {
          unifiedResult = await unifiedCheckD1(decodedPath, clientIP, {
            env: config.cacheConfig.env || config.rateLimitConfig.env,
            databaseBinding: config.cacheConfig.databaseBinding || config.rateLimitConfig.databaseBinding || 'DB',
            sizeTTL: config.cacheConfig.sizeTTL ?? config.sizeTTLSeconds,
            cacheTableName: config.cacheConfig.tableName || config.filesizeCacheTableName || 'FILESIZE_CACHE_TABLE',
            windowTimeSeconds: config.rateLimitConfig.windowTimeSeconds,
            limit: limitValue,
            blockTimeSeconds: config.rateLimitConfig.blockTimeSeconds,
            rateLimitTableName: config.rateLimitConfig.tableName || 'IP_LIMIT_TABLE',
            ipv4Suffix: config.rateLimitConfig.ipv4Suffix,
            ipv6Suffix: config.rateLimitConfig.ipv6Suffix,
          });
        } else if (config.dbMode === 'd1-rest') {
          unifiedResult = await unifiedCheckD1Rest(decodedPath, clientIP, {
            accountId: config.rateLimitConfig.accountId || config.cacheConfig.accountId,
            databaseId: config.rateLimitConfig.databaseId || config.cacheConfig.databaseId,
            apiToken: config.rateLimitConfig.apiToken || config.cacheConfig.apiToken,
            sizeTTL: config.cacheConfig.sizeTTL ?? config.sizeTTLSeconds,
            cacheTableName: config.cacheConfig.tableName || config.filesizeCacheTableName || 'FILESIZE_CACHE_TABLE',
            windowTimeSeconds: config.rateLimitConfig.windowTimeSeconds,
            limit: limitValue,
            blockTimeSeconds: config.rateLimitConfig.blockTimeSeconds,
            rateLimitTableName: config.rateLimitConfig.tableName || 'IP_LIMIT_TABLE',
            ipv4Suffix: config.rateLimitConfig.ipv4Suffix,
            ipv6Suffix: config.rateLimitConfig.ipv6Suffix,
          });
        } else {
          console.log('[Fast Redirect][Unified Check] Unsupported DB mode for unified check, falling back');
          unifiedResult = null;
        }

        if (unifiedResult) {
          if (!unifiedResult.rateLimit.allowed) {
            return respondRateLimitExceeded(
              origin,
              unifiedResult.rateLimit.ipSubnet || clientIP,
              config.ipSubnetLimit,
              config.windowTime,
              unifiedResult.rateLimit.retryAfter
            );
          }

          if (unifiedResult.cache.hit && Number.isFinite(unifiedResult.cache.size)) {
            sizeBytes = Number(unifiedResult.cache.size);
            cacheHit = true;
            console.log('[Fast Redirect][Filesize Cache] HIT via unified check');
          } else {
            console.log('[Fast Redirect][Filesize Cache] MISS via unified check');
          }
        }
      } catch (error) {
        console.error('[Fast Redirect][Unified Check] Failed:', error instanceof Error ? error.message : String(error));
        const pgHandle = config.rateLimitConfig?.pgErrorHandle || 'fail-closed';
        if (pgHandle === 'fail-open') {
          console.warn('[Fast Redirect][Unified Check] fail-open: continuing with standalone checks');
          unifiedResult = null;
          cacheHit = false;
        } else {
          const message = error instanceof Error ? error.message : String(error);
          return respondJson(origin, { code: 500, message: `unified check failed: ${message}` }, 500);
        }
      }
    }

    if (!canUseUnified || !unifiedResult) {
      if (rateLimiter && clientIP) {
        const rateLimitResult = await rateLimiter.checkRateLimit(clientIP, { ...config.rateLimitConfig, ctx });

        if (!rateLimitResult.allowed) {
          if (rateLimitResult.error) {
            return respondJson(origin, { code: 500, message: rateLimitResult.error }, 500);
          }
          return respondRateLimitExceeded(
            origin,
            rateLimitResult.ipSubnet,
            config.ipSubnetLimit,
            config.windowTime,
            rateLimitResult.retryAfter
          );
        }
      }

      if (!cacheHit && cacheManager && cacheConfigWithCtx) {
        console.log('[Fast Redirect][CACHE] Starting standalone cache check for path:', decodedPath);
        try {
          const cached = await cacheManager.checkCache(decodedPath, cacheConfigWithCtx);
          if (cached && Number.isFinite(cached.size)) {
            sizeBytes = Number(cached.size);
            cacheHit = true;
            console.log('[Fast Redirect][Filesize Cache] HIT via standalone lookup');
          } else {
            console.log('[Fast Redirect][Filesize Cache] MISS via standalone lookup');
          }
        } catch (error) {
          console.error('[Fast Redirect][Filesize Cache] Standalone cache check failed:', error instanceof Error ? error.message : String(error));
        }
      } else {
        console.log('[Fast Redirect][CACHE] Skipping standalone cache check:', {
          cacheHit,
          hasCacheManager: !!cacheManager,
          hasCacheConfig: !!cacheConfigWithCtx,
        });
      }
    }

    if (!cacheHit) {
      try {
        fileInfo = await fetchAlistFileInfo(config, decodedPath, clientIP);
        sizeBytes = parseFileSize(fileInfo?.size);
      } catch (error) {
        console.error('[Fast Redirect] Failed to fetch file info:', error instanceof Error ? error.message : String(error));
      }
      if (cacheManager && cacheConfigWithCtx && fileInfo) {
        console.log('[Fast Redirect][CACHE] Attempting to save cache:', {
          path: decodedPath,
          size: sizeBytes,
          configKeys: Object.keys(cacheConfigWithCtx),
        });
        ctx.waitUntil(
          cacheManager
            .saveCache(decodedPath, sizeBytes, cacheConfigWithCtx)
            .then(() => {
              console.log('[Fast Redirect][Filesize Cache] Saved filesize to cache');
            })
            .catch((error) => {
              console.error('[Fast Redirect][Filesize Cache] Save failed:', error instanceof Error ? error.message : String(error));
            })
        );
      } else {
        console.log('[Fast Redirect][CACHE] Skipping cache save:', {
          hasCacheManager: !!cacheManager,
          hasCacheConfig: !!cacheConfigWithCtx,
          hasFileInfo: !!fileInfo,
        });
      }
    }

    const expireTime = calculateExpireTimestamp(sizeBytes, config.minDurationSeconds, config.minBandwidthBytesPerSecond);

    const downloadURL = await createDownloadURL(config, {
      encodedPath,
      decodedPath,
      sign,
      clientIP,
      sizeBytes,
      expireTime,
      fileInfo,
    });

    // Return 302 redirect
    return new Response(null, {
      status: 302,
      headers: {
        'Location': downloadURL,
        'Cache-Control': 'no-store',
      },
    });
  }

  // Default: render landing page
  return renderLandingPage(url.pathname, {
    underAttack: needVerify,
    turnstileSiteKey: config.turnstileSiteKey,
  });
};

const routeRequest = async (request, config, rateLimiter, ctx) => {
  if (request.method === 'OPTIONS') {
    return handleOptions(request);
  }

  const pathname = new URL(request.url).pathname || '/';
  if (request.method === 'GET' && pathname === '/info') {
    const ipv4Error = ensureIPv4(request, config.ipv4Only);
    if (ipv4Error) return ipv4Error;
    return handleInfo(request, config, rateLimiter, ctx);
  }
  return handleFileRequest(request, config, rateLimiter, ctx);
};

export default {
  async fetch(request, env, ctx) {
    const config = resolveConfig(env || {});
    try {
      // Create rate limiter instance based on DB_MODE
      const rateLimiter = config.rateLimitEnabled ? createRateLimiter(config.dbMode) : null;

      return await routeRequest(request, config, rateLimiter, ctx);
    } catch (error) {
      const origin = request.headers.get('origin') || '*';
      const message = error instanceof Error ? error.message : String(error);
      return respondJson(origin, { code: 500, message }, 500);
    }
  },
};
