import {
  rotLower,
  uint8ToBase64,
  parseBoolean,
  parseInteger,
  parseNumber,
  parseWindowTime,
  sha256Hash,
} from './utils.js';
import { renderLandingPage } from './frontend.js';
import { createRateLimiter } from './ratelimit/factory.js';

const REQUIRED_ENV = ['TOKEN', 'WORKER_ADDRESS_DOWNLOAD'];

const TURNSTILE_VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_HEADER = 'cf-turnstile-response';

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

  // Validate PG_ERROR_HANDLE value
  const validPgErrorHandle = pgErrorHandle === 'fail-open' ? 'fail-open' : 'fail-closed';

  // Parse database-specific configuration
  let rateLimitEnabled = false;
  let rateLimitConfig = {};

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
      } else {
        throw new Error('DB_MODE is set to "d1-rest" but required environment variables are missing: D1_ACCOUNT_ID, D1_DATABASE_ID, D1_API_TOKEN, WINDOW_TIME, IPSUBNET_WINDOWTIME_LIMIT');
      }
    } else if (normalizedDbMode === 'custom-pg-rest') {
      // Custom PostgreSQL REST API (PostgREST) configuration
      const postgrestUrl = env.POSTGREST_URL && typeof env.POSTGREST_URL === 'string' ? env.POSTGREST_URL.trim() : '';
      const postgrestTableName = env.POSTGREST_TABLE_NAME && typeof env.POSTGREST_TABLE_NAME === 'string' ? env.POSTGREST_TABLE_NAME.trim() : '';
      const verifyHeader = env.VERIFY_HEADER && typeof env.VERIFY_HEADER === 'string' ? env.VERIFY_HEADER.trim() : '';
      const verifySecret = env.VERIFY_SECRET && typeof env.VERIFY_SECRET === 'string' ? env.VERIFY_SECRET.trim() : '';

      if (postgrestUrl && verifyHeader && verifySecret && windowTimeSeconds > 0 && ipSubnetLimit > 0) {
        rateLimitEnabled = true;
        rateLimitConfig = {
          postgrestUrl,
          verifyHeader,
          verifySecret,
          tableName: postgrestTableName || 'IP_LIMIT_TABLE',
          windowTimeSeconds,
          limit: ipSubnetLimit,
          ipv4Suffix,
          ipv6Suffix,
          pgErrorHandle: validPgErrorHandle,
          cleanupProbability,
          blockTimeSeconds,
        };
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
    verifyHeader: env.VERIFY_HEADER || '',
    verifySecret: env.VERIFY_SECRET || '',
    ipv4Only: parseBoolean(env.IPV4_ONLY, false),
    signSecret: env.SIGN_SECRET && env.SIGN_SECRET.trim() !== '' ? env.SIGN_SECRET : env.TOKEN,
    underAttack,
    fastRedirect: parseBoolean(env.FAST_REDIRECT, false),
    turnstileSiteKey,
    turnstileSecretKey,
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
  if (config.verifyHeader && config.verifySecret) {
    headers[config.verifyHeader] = config.verifySecret;
  }

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

const createAdditionalParams = async (config, decodedPath, clientIP) => {
  if (!config.appendAdditional) return null;
  const fileInfo = await fetchAlistFileInfo(config, decodedPath, clientIP);
  const sizeBytes = parseFileSize(fileInfo?.size);
  const expireTime = calculateExpireTimestamp(sizeBytes, config.minDurationSeconds, config.minBandwidthBytesPerSecond);
  const pathHash = await sha256Hash(decodedPath);
  const payload = JSON.stringify({
    pathHash,
    expireTime,
  });
  const additionalInfo = encodeTextToBase64(payload);
  const additionalInfoSign = await hmacSha256Sign(config.signSecret, additionalInfo, expireTime);
  return { additionalInfo, additionalInfoSign };
};

const createDownloadURL = async (config, { encodedPath, decodedPath, sign, clientIP }) => {
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
    const additionalParams = await createAdditionalParams(config, decodedPath, clientIP);
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

  // Check rate limit
  const clientIP = extractClientIP(request);
  if (rateLimiter && clientIP) {
    const rateLimitResult = await rateLimiter.checkRateLimit(clientIP, { ...config.rateLimitConfig, ctx });

    if (!rateLimitResult.allowed) {
      if (rateLimitResult.error) {
        // Database error with fail-closed
        return respondJson(origin, { code: 500, message: rateLimitResult.error }, 500);
      }
      // Rate limit exceeded
      return respondRateLimitExceeded(
        origin,
        rateLimitResult.ipSubnet,
        config.ipSubnetLimit,
        config.windowTime,
        rateLimitResult.retryAfter
      );
    }
  }

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

  if (needVerify) {
    const token =
      request.headers.get(TURNSTILE_HEADER) ||
      request.headers.get('x-turnstile-token') ||
      url.searchParams.get(TURNSTILE_HEADER) ||
      url.searchParams.get('turnstile_token') ||
      '';
    if (!token) {
      return respondJson(origin, { code: 461, message: 'turnstile token required' }, 403);
    }
    const verification = await verifyTurnstileToken(config.turnstileSecretKey, token, clientIP);
    if (!verification.ok) {
      return respondJson(origin, { code: 462, message: verification.message || 'turnstile verification failed' }, 403);
    }
  }

  const encodedPath = path;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(path);
  } catch (error) {
    return respondJson(origin, { code: 400, message: 'invalid path encoding' }, 400);
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

  const downloadURL = await createDownloadURL(config, {
    encodedPath,
    decodedPath,
    sign,
    clientIP,
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
    const sign = url.searchParams.get('sign') || '';
    const encodedPath = url.pathname;
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch (error) {
      return respondJson(request.headers.get('origin') || '*', { code: 400, message: 'invalid path encoding' }, 400);
    }

    // Verify signature
    const verifyResult = await verifySignature(config.signSecret, decodedPath, sign);
    if (verifyResult) {
      return respondJson(request.headers.get('origin') || '*', { code: 401, message: verifyResult }, 401);
    }

    // Check rate limit for fast redirect
    const clientIP = extractClientIP(request);
    if (rateLimiter && clientIP) {
      const rateLimitResult = await rateLimiter.checkRateLimit(clientIP, { ...config.rateLimitConfig, ctx });

      if (!rateLimitResult.allowed) {
        const origin = request.headers.get('origin') || '*';
        if (rateLimitResult.error) {
          // Database error with fail-closed
          return respondJson(origin, { code: 500, message: rateLimitResult.error }, 500);
        }
        // Rate limit exceeded
        return respondRateLimitExceeded(
          origin,
          rateLimitResult.ipSubnet,
          config.ipSubnetLimit,
          config.windowTime,
          rateLimitResult.retryAfter
        );
      }
    }

    // Generate download URL using URL object for proper encoding
    const expire = extractExpireFromSign(sign);

    const downloadURL = await createDownloadURL(config, {
      encodedPath,
      decodedPath,
      sign,
      clientIP,
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
