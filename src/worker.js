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
import { createChallenge, verifySolution } from 'altcha-lib';
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

const VALID_ACTIONS = [
  'block',
  'verify-pow',
  'verify-turn',
  'verify-both',
  'pass-web',
  'pass-server',
  'pass-asis',
];
const VALID_ACTIONS_SET = new Set(VALID_ACTIONS);

/**
 * 解析 ACTION 值为验证需求对象
 * @param {string} action - ACTION 值
 * @param {object} config - 配置对象（包含 ALTCHA_ENABLED 和 UNDER_ATTACK）
 * @returns {{needAltcha: boolean, needTurnstile: boolean}}
 */
function parseVerificationNeeds(action, config) {
  switch (action) {
    case 'verify-pow':
      return { needAltcha: true, needTurnstile: false };
    case 'verify-turn':
      return { needAltcha: false, needTurnstile: true };
    case 'verify-both':
      return { needAltcha: true, needTurnstile: true };
    case 'block':
    case 'pass-web':
    case 'pass-server':
    case 'pass-asis':
      return { needAltcha: false, needTurnstile: false };
    default:
      // 不再支持旧的 'verify' 值，抛出错误
      throw new Error(`Invalid ACTION value: "${action}". Please use verify-pow, verify-turn, or verify-both instead of verify.`);
  }
}

/**
 * 校验 action 是否为允许的值
 * @param {string|null|undefined} action
 * @returns {string|null}
 */
function ensureValidActionValue(action) {
  if (!action) {
    return null;
  }
  if (action === 'verify') {
    throw new Error('Invalid ACTION value: "verify". Please use verify-pow, verify-turn, or verify-both.');
  }
  if (!VALID_ACTIONS_SET.has(action)) {
    throw new Error(`Invalid ACTION value: "${action}". Valid actions: ${VALID_ACTIONS.join(', ')}`);
  }
  return action;
}

/**
 * Base64url 解码工具（URL 安全字符集）
 * @param {string} base64url
 * @returns {string}
 */
function base64urlDecode(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return atob(base64);
}

/**
 * 执行 D1 REST 查询
 * @param {{accountId:string,databaseId:string,apiToken:string}} restConfig
 * @param {Array<{sql:string,params?:any[]}>|{sql:string,params?:any[]}} statements
 */
async function executeD1RestQuery(restConfig, statements) {
  if (!restConfig || !restConfig.accountId || !restConfig.databaseId || !restConfig.apiToken) {
    throw new Error('D1 REST configuration is incomplete');
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${restConfig.accountId}/d1/database/${restConfig.databaseId}/query`;
  const payload = Array.isArray(statements) ? statements : [statements];
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${restConfig.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`D1 REST API error (${response.status}): ${text}`);
  }
  const result = await response.json().catch(() => ({}));
  if (result && result.success === false) {
    throw new Error(`D1 REST API query failed: ${JSON.stringify(result.errors || [])}`);
  }
  return result?.result || [];
}

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
  const rawToken = env.TOKEN;
  const normalizedToken = typeof rawToken === 'string' ? rawToken : String(rawToken || '');
  const pageSecret = typeof env.PAGE_SECRET === 'string' && env.PAGE_SECRET.trim() !== ''
    ? env.PAGE_SECRET.trim()
    : normalizedToken;
  const altchaEnabled = env.ALTCHA_ENABLED === 'true';
  const parsedAltchaDifficulty = Number.parseInt(env.ALTCHA_DIFFICULTY || '250000', 10);
  const altchaDifficulty = Number.isFinite(parsedAltchaDifficulty) && parsedAltchaDifficulty > 0
    ? parsedAltchaDifficulty
    : 250000;
  const rawAltchaTokenExpire = typeof env.ALTCHA_TOKEN_EXPIRE === 'string' ? env.ALTCHA_TOKEN_EXPIRE.trim() : '';
  let altchaTokenExpire = parseWindowTime(rawAltchaTokenExpire || '3m');
  if (!Number.isFinite(altchaTokenExpire) || altchaTokenExpire <= 0) {
    altchaTokenExpire = parseWindowTime('3m');
  }
  const altchaTokenTable = env.ALTCHA_TOKEN_BINDING_TABLE && typeof env.ALTCHA_TOKEN_BINDING_TABLE === 'string'
    ? env.ALTCHA_TOKEN_BINDING_TABLE.trim()
    : '';
  const altchaTableName = altchaTokenTable || 'ALTCHA_TOKEN_LIST';
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
    if (normalizedAction === 'verify') {
      throw new Error(`${paramName} value "verify" is no longer supported. Please use verify-pow, verify-turn, or verify-both.`);
    }
    if (!VALID_ACTIONS_SET.has(normalizedAction)) {
      throw new Error(`${paramName} must be one of: ${VALID_ACTIONS.join(', ')}`);
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
      const actionPart = rawExceptAction.slice(0, -7);

      // Reject legacy 'verify-except' (ambiguous)
      if (actionPart === 'verify') {
        throw new Error('EXCEPT_ACTION value "verify-except" is no longer supported. Please use verify-pow-except, verify-turn-except, or verify-both-except.');
      }

      // Validate action part is in VALID_ACTIONS
      if (!VALID_ACTIONS_SET.has(actionPart)) {
        throw new Error(`EXCEPT_ACTION action part must be one of: ${VALID_ACTIONS.join(', ')}`);
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

  // Parse cleanup percentage (默认 5%)
  let cleanupPercentage = Number.parseFloat(typeof env.CLEANUP_PERCENTAGE === 'string' ? env.CLEANUP_PERCENTAGE.trim() : '');
  if (!Number.isFinite(cleanupPercentage)) {
    cleanupPercentage = 5;
  }
  if (cleanupPercentage < 0 || cleanupPercentage > 100) {
    cleanupPercentage = 5;
  }
  // Convert to probability (0.0 to 1.0)
  const cleanupProbability = cleanupPercentage / 100;

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
  let d1RestConfig = null;

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
        d1RestConfig = {
          accountId: d1AccountId,
          databaseId: d1DatabaseId,
          apiToken: d1ApiToken,
        };
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
    altchaEnabled,
    altchaDifficulty,
    altchaTokenExpire,
    altchaTableName,
    pageSecret,
    turnstileSiteKey,
    turnstileSecretKey,
    turnstileTokenBindingEnabled,
    turnstileTokenTTL: rawTurnstileTokenTTL,
    turnstileTokenTTLSeconds,
    turnstileTokenTableName,
    cleanupPercentage,
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
    d1RestConfig,
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
        return ensureValidActionValue(config.blacklistAction);
      }
    }
  }

  // Check whitelist second
  if (config.whitelistPrefixes.length > 0 && config.whitelistAction) {
    for (const prefix of config.whitelistPrefixes) {
      if (decodedPath.startsWith(prefix)) {
        return ensureValidActionValue(config.whitelistAction);
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
      return ensureValidActionValue(config.exceptAction);
    }
  }

  // No match - undefined action
  return null;
};

const handleOptions = (request) => new Response(null, { headers: safeHeaders(request.headers.get('Origin')) });

const handleInfo = async (request, env, config, rateLimiter, ctx) => {
  const origin = request.headers.get('origin') || '*';
  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  const sign = url.searchParams.get('sign') || '';

  if (!path) {
    return respondJson(origin, { code: 400, message: 'path is required' }, 400);
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(path);
  } catch (error) {
    return respondJson(origin, { code: 400, message: 'invalid path encoding' }, 400);
  }

  const clientIP = extractClientIP(request);
  const rawTurnstileToken =
    request.headers.get(TURNSTILE_HEADER) ||
    request.headers.get('x-turnstile-token') ||
    url.searchParams.get(TURNSTILE_HEADER) ||
    url.searchParams.get('turnstile_token') ||
    '';
  const altChallengeResultParam = url.searchParams.get('altChallengeResult');
  let altchaPayload = null;
  if (altChallengeResultParam) {
    try {
      const decoded = base64urlDecode(altChallengeResultParam);
      altchaPayload = JSON.parse(decoded);
    } catch (error) {
      console.error('[ALTCHA] Failed to decode altChallengeResult:', error instanceof Error ? error.message : String(error));
      return new Response('Invalid altChallengeResult format', { status: 400 });
    }
  }

  // Check blacklist/whitelist
  const action = checkPathListAction(decodedPath, config);

  // Handle block action
  if (action === 'block') {
    return respondJson(origin, { code: 403, message: 'access denied' }, 403);
  }

  let needAltcha = config.altchaEnabled;
  let needTurnstile = config.underAttack;

  if (action) {
    const parsedNeeds = parseVerificationNeeds(action, config);
    needAltcha = parsedNeeds.needAltcha;
    needTurnstile = parsedNeeds.needTurnstile;
  }

  const hasDbMode = typeof config.dbMode === 'string'
    ? config.dbMode.length > 0
    : Boolean(config.dbMode);
  const tokenTTLSeconds = Number(config.turnstileTokenTTLSeconds) || 0;
  const tokenTableName = config.turnstileTokenTableName || 'TURNSTILE_TOKEN_BINDING';
  const altchaTableName = config.altchaTableName || 'ALTCHA_TOKEN_LIST';

  let tokenHash = null;
  if (needTurnstile && config.turnstileTokenBindingEnabled && rawTurnstileToken) {
    try {
      tokenHash = await sha256Hash(rawTurnstileToken);
    } catch (error) {
      console.error('[Turnstile Binding] Failed to hash token:', error instanceof Error ? error.message : String(error));
    }
  }

  const shouldBindToken = Boolean(
    needTurnstile &&
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

  let filepathHash = null;
  if (decodedPath) {
    try {
      filepathHash = await sha256Hash(decodedPath);
    } catch (error) {
      console.error('[Turnstile Binding] Failed to hash filepath:', error instanceof Error ? error.message : String(error));
    }
  }

  let altchaTokenHash = null;
  if (needAltcha) {
    if (!altchaPayload) {
      return respondJson(origin, { code: 403, message: 'ALTCHA solution required' }, 403);
    }
    try {
      // Stateless 验证：verifySolution 的内置过期检查（120 秒）
      const verified = await verifySolution(altchaPayload, config.pageSecret, true);
      if (!verified) {
        return respondJson(origin, { code: 403, message: 'ALTCHA verification failed' }, 403);
      }
      // Stateful 验证会在 unified check 中额外检查 DB 的 EXPIRES_AT 字段
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return respondJson(origin, { code: 403, message: `ALTCHA error: ${message}` }, 403);
    }
  }

  if (needAltcha && altchaPayload) {
    try {
      const canonicalToken = `${altchaPayload.algorithm}:${altchaPayload.challenge}:${altchaPayload.number}:${altchaPayload.salt}:${altchaPayload.signature}`;
      altchaTokenHash = await sha256Hash(canonicalToken);
    } catch (error) {
      console.error('[ALTCHA] Failed to compute token hash:', error instanceof Error ? error.message : String(error));
      if (hasDbMode) {
        return respondJson(origin, { code: 500, message: 'ALTCHA token hashing failed' }, 500);
      }
    }
  }

  if (needTurnstile) {
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
  const requiresAltchaStateful = Boolean(needAltcha && altchaTokenHash && hasDbMode);
  const unifiedEligible = Boolean(
    (config.rateLimitEnabled && hasDbMode) ||
    shouldBindToken ||
    requiresAltchaStateful
  );
  const canUseUnified = Boolean(unifiedEligible && hasDbMode && clientIP);

  console.log('[CACHE] Unified check eligibility:', {
    canUseUnified,
    unifiedEligible,
    hasCacheManager: !!cacheManager,
    cacheEnabled: config.cacheEnabled,
    rateLimitEnabled: config.rateLimitEnabled,
    dbMode: config.dbMode,
    hasClientIP: !!clientIP,
    shouldBindToken,
    requiresAltchaStateful,
  });

  if (requiresAltchaStateful && !filepathHash) {
    console.error('[ALTCHA] Missing filepath hash for stateful verification');
    return respondJson(origin, { code: 500, message: 'ALTCHA token validation unavailable' }, 500);
  }

  if (shouldBindToken && !canUseUnified) {
    console.error('[Turnstile Binding] Token binding enabled but unified check is unavailable');
    return respondJson(origin, { code: 500, message: 'turnstile token binding unavailable' }, 500);
  }

  if (requiresAltchaStateful && !canUseUnified) {
    console.error('[ALTCHA] Token validation enabled but unified check is unavailable');
    return respondJson(origin, { code: 500, message: 'ALTCHA token validation unavailable' }, 500);
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
          altchaTokenHash,
          altchaTokenIP: clientIP,
          altchaTableName,
        };
        console.log('[Unified Check] Config for custom-pg-rest:', {
          postgrestUrl: unifiedConfig.postgrestUrl,
          hasVerifyHeader: Array.isArray(unifiedConfig.verifyHeader) ? unifiedConfig.verifyHeader.length : !!unifiedConfig.verifyHeader,
          hasVerifySecret: Array.isArray(unifiedConfig.verifySecret) ? unifiedConfig.verifySecret.length : !!unifiedConfig.verifySecret,
          sizeTTL: unifiedConfig.sizeTTL,
          cacheTableName: unifiedConfig.cacheTableName,
        });
        unifiedResult = await unifiedCheck(decodedPath, clientIP, config.altchaTableName, unifiedConfig);
      } else if (config.dbMode === 'd1') {
        unifiedResult = await unifiedCheckD1(decodedPath, clientIP, config.altchaTableName, {
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
          altchaTokenHash,
          altchaTokenIP: clientIP,
          altchaTableName,
        });
      } else if (config.dbMode === 'd1-rest') {
        unifiedResult = await unifiedCheckD1Rest(decodedPath, clientIP, config.altchaTableName, {
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
          altchaTokenHash,
          altchaTokenIP: clientIP,
          altchaTableName,
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

        if (needAltcha && altchaTokenHash) {
          const altchaResult = unifiedResult.altcha || { allowed: true, errorCode: 0 };
          if (altchaResult.allowed === false) {
            const altchaErrorMessages = {
              1: 'ALTCHA token IP mismatch',
              2: 'ALTCHA token expired',
              3: 'ALTCHA token already used (replay attack detected)',
              4: 'ALTCHA token filepath mismatch',
            };
            const message = altchaErrorMessages[altchaResult.errorCode] || 'ALTCHA token validation failed';
            console.warn('[ALTCHA] Token rejected:', message);
            return respondJson(origin, { code: 463, message }, 403);
          }
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

  // Unified cleanup scheduler (handles all tables)
  await scheduleAllCleanups(config, env, ctx);

  // 当 unified check 未能启用 token binding 时，尝试回落到无状态的 Turnstile siteverify
  if (shouldBindToken && !tokenBindingAllowed && needTurnstile) {
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
  let downloadURL = await createDownloadURL(config, {
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
        underAttack: needTurnstile,
      },
    },
  };
  if (needAltcha && altchaTokenHash && canUseUnified) {
    ctx.waitUntil(
      (async () => {
        if (!filepathHash) {
          console.warn('[ALTCHA Token Recording] Skipped: missing filepath hash');
          return;
        }
        if (!clientIP) {
          console.warn('[ALTCHA Token Recording] Skipped: missing client IP');
          return;
        }
        const ttlSeconds = Number.isFinite(config.altchaTokenExpire) && config.altchaTokenExpire > 0
          ? Math.floor(config.altchaTokenExpire)
          : 180;
        if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
          console.warn('[ALTCHA Token Recording] Skipped: invalid TTL', config.altchaTokenExpire);
          return;
        }
        const nowSeconds = Math.floor(Date.now() / 1000);
        const expiresAt = nowSeconds + ttlSeconds;
        const normalizedDbMode = typeof config.dbMode === 'string' ? config.dbMode.toLowerCase() : '';
        try {
          if (normalizedDbMode === 'custom-pg-rest') {
            const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
            if (!postgrestUrl) {
              console.warn('[ALTCHA Token Recording] PostgREST URL missing');
              return;
            }
            const rpcUrl = `${postgrestUrl}/rpc/landing_record_altcha_token`;
            const headers = { 'Content-Type': 'application/json' };
            applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
            const rpcBody = {
              p_token_hash: altchaTokenHash,
              p_client_ip: clientIP,
              p_filepath_hash: filepathHash,
              p_now: nowSeconds,
              p_ttl_seconds: ttlSeconds,
              p_table_name: altchaTableName,
            };
            const response = await fetch(rpcUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify(rpcBody),
            });
            if (!response.ok) {
              const text = await response.text().catch(() => '');
              console.error('[ALTCHA Token Recording] PostgREST failed:', response.status, text);
            }
          } else if (normalizedDbMode === 'd1') {
            const envSource = config.cacheConfig?.env || config.rateLimitConfig?.env;
            const bindingName = config.cacheConfig?.databaseBinding || config.rateLimitConfig?.databaseBinding || 'DB';
            const db = envSource ? envSource[bindingName] : null;
            if (!db) {
              console.warn('[ALTCHA Token Recording] D1 binding missing');
              return;
            }
            await db.prepare(`
              INSERT INTO ${altchaTableName} (ALTCHA_TOKEN_HASH, CLIENT_IP, FILEPATH_HASH, ACCESS_COUNT, CREATED_AT, EXPIRES_AT)
              VALUES (?, ?, ?, 1, ?, ?)
              ON CONFLICT (ALTCHA_TOKEN_HASH) DO UPDATE SET ACCESS_COUNT = ACCESS_COUNT + 1
            `).bind(altchaTokenHash, clientIP, filepathHash, nowSeconds, expiresAt).run();
          } else if (normalizedDbMode === 'd1-rest') {
            const accountId = config.rateLimitConfig?.accountId || config.cacheConfig?.accountId;
            const databaseId = config.rateLimitConfig?.databaseId || config.cacheConfig?.databaseId;
            const apiToken = config.rateLimitConfig?.apiToken || config.cacheConfig?.apiToken;
            if (!accountId || !databaseId || !apiToken) {
              console.warn('[ALTCHA Token Recording] D1 REST credentials missing');
              return;
            }
            const sql = `
              INSERT INTO ${altchaTableName} (ALTCHA_TOKEN_HASH, CLIENT_IP, FILEPATH_HASH, ACCESS_COUNT, CREATED_AT, EXPIRES_AT)
              VALUES (?, ?, ?, 1, ?, ?)
              ON CONFLICT (ALTCHA_TOKEN_HASH) DO UPDATE SET ACCESS_COUNT = ACCESS_COUNT + 1
            `;
            const body = {
              sql,
              params: [altchaTokenHash, clientIP, filepathHash, nowSeconds, expiresAt],
            };
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
              console.error('[ALTCHA Token Recording] D1 REST failed:', response.status, text);
            }
          }
        } catch (error) {
          console.error('[ALTCHA Token Recording] Failed:', error instanceof Error ? error.message : String(error));
        }
      })()
    );
  }
  scheduleTokenBindingWrite(filepathHash);
  return respondJson(origin, responsePayload, 200);
};

/**
 * 清理过期 ALTCHA token 记录
 * @param {object} config
 * @param {object} env
 */
async function cleanupExpiredAltchaTokens(config, env) {
  try {
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (config.dbMode === 'custom-pg-rest') {
      const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        console.error('[ALTCHA Cleanup] PostgREST URL missing');
        return;
      }
      const rpcUrl = `${postgrestUrl}/rpc/landing_cleanup_expired_altcha_tokens`;
      const headers = { 'Content-Type': 'application/json' };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_now: nowSeconds,
          p_table_name: config.altchaTableName,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error('[ALTCHA Cleanup] PostgREST RPC failed:', response.status, text);
      }
      return;
    }

    if (config.dbMode === 'd1') {
      const envSource = config.cacheConfig?.env || config.rateLimitConfig?.env || env;
      const bindingName = config.cacheConfig?.databaseBinding || config.rateLimitConfig?.databaseBinding || 'DB';
      const db = envSource ? envSource[bindingName] : null;
      if (!db) {
        console.error('[ALTCHA Cleanup] D1 binding not available');
        return;
      }
      await db.prepare(
        `DELETE FROM ${config.altchaTableName} WHERE EXPIRES_AT < ?`
      ).bind(nowSeconds).run();
      return;
    }

    if (config.dbMode === 'd1-rest') {
      const restConfig = config.d1RestConfig;
      if (!restConfig) {
        console.error('[ALTCHA Cleanup] D1 REST config missing');
        return;
      }
      const sql = `DELETE FROM ${config.altchaTableName} WHERE EXPIRES_AT < ?`;
      await executeD1RestQuery(restConfig, [{ sql, params: [nowSeconds] }]);
    }
  } catch (error) {
    console.error('[ALTCHA Cleanup] Failed:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * 清理过期的 Turnstile Token Binding 记录
 * @param {object} config - 配置对象
 * @param {object} env - 环境变量
 */
async function cleanupExpiredTurnstileTokens(config, env) {
  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const turnstileTableName = config.turnstileTokenTableName || 'TURNSTILE_TOKEN_BINDING';

    if (config.dbMode === 'custom-pg-rest') {
      const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        console.error('[Turnstile Cleanup] PostgREST URL missing');
        return;
      }
      const rpcUrl = `${postgrestUrl}/rpc/landing_cleanup_expired_tokens`;
      const headers = { 'Content-Type': 'application/json' };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_now: nowSeconds,
          p_table_name: turnstileTableName,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error('[Turnstile Cleanup] PostgREST RPC failed:', response.status, text);
      }
      return;
    }

    if (config.dbMode === 'd1') {
      const envSource = config.cacheConfig?.env || config.rateLimitConfig?.env || env;
      const bindingName = config.cacheConfig?.databaseBinding || config.rateLimitConfig?.databaseBinding || 'DB';
      const db = envSource ? envSource[bindingName] : null;
      if (!db) {
        console.error('[Turnstile Cleanup] D1 binding not available');
        return;
      }
      await db.prepare(
        `DELETE FROM ${turnstileTableName} WHERE EXPIRES_AT < ?`
      ).bind(nowSeconds).run();
      return;
    }

    if (config.dbMode === 'd1-rest') {
      const restConfig = config.d1RestConfig;
      if (!restConfig) {
        console.error('[Turnstile Cleanup] D1 REST config missing');
        return;
      }
      const sql = `DELETE FROM ${turnstileTableName} WHERE EXPIRES_AT < ?`;
      await executeD1RestQuery(restConfig, [{ sql, params: [nowSeconds] }]);
    }
  } catch (error) {
    console.error('[Turnstile Cleanup] Failed:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * 清理过期的 Rate Limit 记录
 * @param {object} config - 配置对象
 * @param {object} env - 环境变量
 */
async function cleanupExpiredRateLimits(config, env) {
  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const tableName = config.rateLimitConfig?.tableName || 'IP_LIMIT_TABLE';
    const windowTimeSeconds = config.rateLimitConfig?.windowTimeSeconds || 0;
    
    if (windowTimeSeconds <= 0) {
      return; // No cleanup if no window time configured
    }

    const cutoffTime = nowSeconds - (windowTimeSeconds * 2);

    if (config.dbMode === 'custom-pg-rest') {
      const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        console.error('[Rate Limit Cleanup] PostgREST URL missing');
        return;
      }
      
      // Use direct SQL via PostgREST (no RPC for rate limit cleanup in init.sql)
      const headers = {
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      
      // PostgREST DELETE syntax: table?condition
      const deleteUrl = `${postgrestUrl}/${tableName}?LAST_WINDOW_TIME=lt.${cutoffTime}&or=(BLOCK_UNTIL.is.null,BLOCK_UNTIL.lt.${nowSeconds})`;
      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers,
      });
      
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error('[Rate Limit Cleanup] PostgREST DELETE failed:', response.status, text);
      }
      return;
    }

    if (config.dbMode === 'd1') {
      const envSource = config.rateLimitConfig?.env || env;
      const bindingName = config.rateLimitConfig?.databaseBinding || 'DB';
      const db = envSource ? envSource[bindingName] : null;
      if (!db) {
        console.error('[Rate Limit Cleanup] D1 binding not available');
        return;
      }
      const sql = `DELETE FROM ${tableName}
                   WHERE LAST_WINDOW_TIME < ?
                     AND (BLOCK_UNTIL IS NULL OR BLOCK_UNTIL < ?)`;
      await db.prepare(sql).bind(cutoffTime, nowSeconds).run();
      return;
    }

    if (config.dbMode === 'd1-rest') {
      const restConfig = config.d1RestConfig;
      if (!restConfig) {
        console.error('[Rate Limit Cleanup] D1 REST config missing');
        return;
      }
      const sql = `DELETE FROM ${tableName}
                   WHERE LAST_WINDOW_TIME < ?
                     AND (BLOCK_UNTIL IS NULL OR BLOCK_UNTIL < ?)`;
      await executeD1RestQuery(restConfig, [{ sql, params: [cutoffTime, nowSeconds] }]);
    }
  } catch (error) {
    console.error('[Rate Limit Cleanup] Failed:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * 清理过期的 Filesize Cache 记录
 * @param {object} config - 配置对象
 * @param {object} env - 环境变量
 */
async function cleanupExpiredCache(config, env) {
  try {
    const sizeTTL = config.cacheConfig?.sizeTTL || config.sizeTTLSeconds || 0;
    if (sizeTTL <= 0) {
      return; // No cleanup if no TTL configured
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const cutoffTime = nowSeconds - (sizeTTL * 2);
    const tableName = config.cacheConfig?.tableName || config.filesizeCacheTableName || 'FILESIZE_CACHE_TABLE';

    if (config.dbMode === 'custom-pg-rest') {
      const postgrestUrl = config.cacheConfig?.postgrestUrl || config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        console.error('[Cache Cleanup] PostgREST URL missing');
        return;
      }
      const rpcUrl = `${postgrestUrl}/rpc/landing_cleanup_expired_cache`;
      const headers = { 'Content-Type': 'application/json' };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_ttl_seconds: sizeTTL,
          p_table_name: tableName,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error('[Cache Cleanup] PostgREST RPC failed:', response.status, text);
      }
      return;
    }

    if (config.dbMode === 'd1') {
      const envSource = config.cacheConfig?.env || config.rateLimitConfig?.env || env;
      const bindingName = config.cacheConfig?.databaseBinding || config.rateLimitConfig?.databaseBinding || 'DB';
      const db = envSource ? envSource[bindingName] : null;
      if (!db) {
        console.error('[Cache Cleanup] D1 binding not available');
        return;
      }
      const sql = `DELETE FROM ${tableName} WHERE TIMESTAMP < ?`;
      await db.prepare(sql).bind(cutoffTime).run();
      return;
    }

    if (config.dbMode === 'd1-rest') {
      const restConfig = config.d1RestConfig || config.cacheConfig;
      if (!restConfig || !restConfig.accountId) {
        console.error('[Cache Cleanup] D1 REST config missing');
        return;
      }
      const sql = `DELETE FROM ${tableName} WHERE TIMESTAMP < ?`;
      await executeD1RestQuery(restConfig, [{ sql, params: [cutoffTime] }]);
    }
  } catch (error) {
    console.error('[Cache Cleanup] Failed:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * 统一清理调度器：按概率触发所有过期数据清理
 * @param {object} config - 配置对象
 * @param {object} env - 环境变量
 * @param {ExecutionContext} ctx - Workers ExecutionContext
 */
async function scheduleAllCleanups(config, env, ctx) {
  const hasDbMode = typeof config.dbMode === 'string' && config.dbMode.length > 0;
  if (!hasDbMode || config.cleanupPercentage <= 0) {
    return; // Skip if no DB or cleanup disabled
  }

  // Probabilistic trigger
  const shouldCleanup = Math.random() * 100 < config.cleanupPercentage;
  if (!shouldCleanup) {
    return;
  }

  console.log(`[Cleanup Scheduler] Triggered cleanup (probability: ${config.cleanupPercentage}%)`);

  // Run all cleanups in parallel (Promise.allSettled ensures one failure doesn't block others)
  const cleanupTasks = [
    { name: 'Rate Limit', fn: () => cleanupExpiredRateLimits(config, env) },
    { name: 'Filesize Cache', fn: () => cleanupExpiredCache(config, env) },
    { name: 'ALTCHA Token', fn: () => cleanupExpiredAltchaTokens(config, env) },
    { name: 'Turnstile Token', fn: () => cleanupExpiredTurnstileTokens(config, env) },
  ];

  const cleanupPromise = Promise.allSettled(
    cleanupTasks.map(task =>
      task.fn().catch(error => {
        console.error(`[Cleanup Scheduler] ${task.name} failed:`, error instanceof Error ? error.message : String(error));
      })
    )
  ).then(results => {
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    console.log(`[Cleanup Scheduler] Completed: ${succeeded}/${cleanupTasks.length} tasks succeeded`);
  });

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(cleanupPromise);
  }
}

const handleFileRequest = async (request, env, config, rateLimiter, ctx) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return respondJson(request.headers.get('origin') || '*', { code: 405, message: 'method not allowed' }, 405);
  }
  // Unified cleanup scheduler (handles all tables)
  await scheduleAllCleanups(config, env, ctx);

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=UTF-8',
        'cache-control': 'no-store',
      },
    });
  }

  const origin = request.headers.get('origin') || '*';
  const url = new URL(request.url);

  // Check blacklist/whitelist
  const action = checkPathListAction(url.pathname, config);

  // Handle block action
  if (action === 'block') {
    return respondJson(request.headers.get('origin') || '*', { code: 403, message: 'access denied' }, 403);
  }

  // Determine behavior based on action
  const forceWeb = action === 'pass-web';
  const forceRedirect = action === 'pass-server';

  let needAltcha = config.altchaEnabled;
  let needTurnstile = config.underAttack;

  if (action) {
    const parsedNeeds = parseVerificationNeeds(action, config);
    needAltcha = parsedNeeds.needAltcha;
    needTurnstile = parsedNeeds.needTurnstile;
  }

  const needsVerification = needAltcha || needTurnstile;

  const fastRedirectCandidate = forceRedirect || (config.fastRedirect && !forceWeb && !needsVerification);
  const shouldRedirect = fastRedirectCandidate;

  // Fast redirect logic
  if (shouldRedirect) {
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
          unifiedResult = await unifiedCheck(decodedPath, clientIP, config.altchaTableName, unifiedConfig);
        } else if (config.dbMode === 'd1') {
          unifiedResult = await unifiedCheckD1(decodedPath, clientIP, config.altchaTableName, {
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
          unifiedResult = await unifiedCheckD1Rest(decodedPath, clientIP, config.altchaTableName, {
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
  let altchaChallengePayload = null;
  const needsAltchaChallenge = needAltcha;
  if (!shouldRedirect && needsAltchaChallenge) {
    try {
      const challenge = await createChallenge({
        hmacKey: config.pageSecret,
        maxnumber: config.altchaDifficulty,
        expires: new Date(Date.now() + 120000),
      });
      altchaChallengePayload = {
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        signature: challenge.signature,
        maxnumber: challenge.maxnumber,
      };
    } catch (error) {
      console.error('[ALTCHA] Failed to create challenge:', error instanceof Error ? error.message : String(error));
    }
  }

  return renderLandingPage(url.pathname, {
    underAttack: needTurnstile,
    turnstileSiteKey: config.turnstileSiteKey,
    altchaChallenge: altchaChallengePayload,
  });
};

const routeRequest = async (request, env, config, rateLimiter, ctx) => {
  if (request.method === 'OPTIONS') {
    return handleOptions(request);
  }

  const pathname = new URL(request.url).pathname || '/';
  if (request.method === 'GET' && pathname === '/info') {
    const ipv4Error = ensureIPv4(request, config.ipv4Only);
    if (ipv4Error) return ipv4Error;
    return handleInfo(request, env, config, rateLimiter, ctx);
  }
  return handleFileRequest(request, env, config, rateLimiter, ctx);
};

export default {
  async fetch(request, env, ctx) {
    const config = resolveConfig(env || {});
    try {
      // Create rate limiter instance based on DB_MODE
      const rateLimiter = config.rateLimitEnabled ? createRateLimiter(config.dbMode) : null;

      return await routeRequest(request, env, config, rateLimiter, ctx);
    } catch (error) {
      const origin = request.headers.get('origin') || '*';
      const message = error instanceof Error ? error.message : String(error);
      return respondJson(origin, { code: 500, message }, 500);
    }
  },
};
