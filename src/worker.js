import {
  rotLower,
  uint8ToBase64,
  parseBoolean,
  parseInteger,
  parseNumber,
  parseWindowTime,
  sha256Hash,
  calculateIPSubnet,
  applyVerifyHeaders,
} from './utils.js';
import {
  buildOriginSnapshot,
  encryptOriginSnapshot,
  getClientIp,
} from './origin-binding.js';
import { createChallenge, verifySolution } from 'altcha-lib';
import { renderLandingPage } from './frontend.js';
import { createRateLimiter } from './ratelimit/factory.js';
import { createCacheManager } from './cache/factory.js';
import { unifiedCheck } from './unified-check.js';
import { handleInternalApiIfAny } from './internal-api.js';
import { fetchControllerState } from './controller-adapter.js';
import { BootstrapDO } from './do/bootstrap-do.js';
import { DecisionDO } from './do/decision-do.js';
import { MetricsDO } from './do/metrics-do.js';

const REQUIRED_ENV = ['TOKEN', 'WORKER_ADDRESS_DOWNLOAD'];

const TURNSTILE_VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_HEADER = 'cf-turnstile-response';
const TURNSTILE_BINDING_HEADER = 'x-turnstile-binding';
const TURNSTILE_BINDING_QUERY = 'turnstile_binding';
const TOKEN_BINDING_ERROR_MESSAGES = {
  1: 'turnstile token ip mismatch',
  2: 'turnstile token expired',
  3: 'turnstile token already used',
  4: 'turnstile token path mismatch',
};

const VALID_ACTIONS = [
  'block',
  'verify-altcha',
  'verify-turn',
  'verify-powdet',
  'verify-web-download',
  'verify-decrypt',
  'pass-web-download',
  'pass-decrypt',
  'pass-web',
  'pass-server',
  'pass-asis',
];
const VALID_ACTIONS_SET = new Set(VALID_ACTIONS);

const DEFAULT_CRYPT_FILE_HEADER_SIZE = 32;
const DEFAULT_CRYPT_BLOCK_HEADER_SIZE = 16;
const DEFAULT_CRYPT_BLOCK_DATA_SIZE = 64 * 1024;
const DEFAULT_WEB_DOWNLOADER_MAX_CONNECTIONS = 16;
const MIN_WEB_DOWNLOADER_MAX_CONNECTIONS = 1;
const MAX_WEB_DOWNLOADER_MAX_CONNECTIONS = 32;
const CRYPT_DATA_KEY_LENGTH = 32;

const ALTCHA_DEFAULT_BASE_DIFFICULTY = 250000;
const ALTCHA_DIFFICULTY_TABLE = 'ALTCHA_DIFFICULTY_STATE';
const ALTCHA_DIFFICULTY_CLEANUP_MAX_AGE = 86400; // 1d default cleanup horizon
const ALTCHA_MAX_EXPONENT_FALLBACK = 10;
const ALTCHA_MIN_UPGRADE_DEFAULT = 3;
const ALTCHA_DEFAULT_ALGORITHM = 'SHA-256';
const ALTCHA_ALGORITHM_POOL = ['SHA-256', 'SHA-384', 'SHA-512'];
const POWDET_DIFFICULTY_TABLE = 'POWDET_DIFFICULTY_STATE';
const POWDET_DEFAULT_TABLE = 'POW_CHALLENGE_TICKET';
const getNormalizedDbMode = (config) => {
  if (!config || typeof config.dbMode !== 'string') {
    return '';
  }
  const normalized = config.dbMode.trim().toLowerCase();
  return normalized === 'custom-pg-rest' ? 'custom-pg-rest' : '';
};

let ipRateLimitDisabledLogged = false;

const hexToUint8Array = (hexString) => {
  if (typeof hexString !== 'string') {
    return null;
  }
  let normalized = hexString.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith('0x') || normalized.startsWith('0X')) {
    normalized = normalized.slice(2);
  }
  if (normalized.length % 2 !== 0) {
    throw new Error('CRYPT_DATA_KEY must be an even-length hex string');
  }
  const byteLength = normalized.length / 2;
  const result = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    const byteHex = normalized.slice(i * 2, i * 2 + 2);
    const byteValue = Number.parseInt(byteHex, 16);
    if (Number.isNaN(byteValue)) {
      throw new Error(`CRYPT_DATA_KEY contains invalid hex characters near "${byteHex}"`);
    }
    result[i] = byteValue;
  }
  return result;
};

/**
 * 解析 ACTION 值为验证需求对象
 * @param {string} action - ACTION 值
 * @param {object} config - 配置对象（包含 ALTCHA_ENABLED / UNDER_ATTACK / POWDET_ENABLED）
 * @returns {{blocked: boolean, needAltcha: boolean, needTurnstile: boolean, needPowdet: boolean}}
 */
function parseVerificationNeeds(action, config) {
  const defaults = {
    needAltcha: !!(config && config.altchaEnabled),
    needTurnstile: !!(config && config.underAttack),
    needPowdet: !!(config && config.powdetEnabled),
  };

  if (!action) {
    return { blocked: false, ...defaults };
  }

  const normalized = String(action).trim().toLowerCase();
  if (!normalized) {
    return { blocked: false, ...defaults };
  }

  const tokens = new Set(
    normalized
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  );

  if (tokens.has('block')) {
    return { blocked: true, needAltcha: false, needTurnstile: false, needPowdet: false };
  }

  let needAltcha = defaults.needAltcha;
  let needTurnstile = defaults.needTurnstile;
  let needPowdet = defaults.needPowdet;

  const verifyTokens = ['verify-altcha', 'verify-turn', 'verify-powdet'];
  const hasVerifyToken = verifyTokens.some((t) => tokens.has(t));

  if (hasVerifyToken) {
    needAltcha = false;
    needTurnstile = false;
    needPowdet = false;
  }

  if (tokens.has('verify-altcha')) {
    needAltcha = true;
  }
  if (tokens.has('verify-turn')) {
    needTurnstile = true;
  }
  if (tokens.has('verify-powdet')) {
    needPowdet = true;
  }

  if (
    tokens.has('pass-web') ||
    tokens.has('pass-server') ||
    tokens.has('pass-asis') ||
    tokens.has('pass-web-download') ||
    tokens.has('pass-decrypt')
  ) {
    needAltcha = false;
    needTurnstile = false;
    needPowdet = false;
  }

  return { blocked: false, needAltcha, needTurnstile, needPowdet };
}

/**
 * 校验 action 是否为允许的值
 * @param {string|null|undefined} action
 * @param {string} [contextLabel='ACTION']
 * @returns {string|null}
 */
function ensureValidActionValue(action, contextLabel = 'ACTION') {
  if (action === null || typeof action === 'undefined') {
    return null;
  }
  if (typeof action !== 'string') {
    throw new Error(`${contextLabel} must be a string`);
  }
  const normalized = action.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const tokens = normalized
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return null;
  }

  for (const token of tokens) {
    if (token === 'verify') {
      throw new Error(`Invalid ${contextLabel} value: "verify". Please use verify-altcha, verify-turn, or verify-powdet.`);
    }
    if (token === 'verify-pow' || token === 'verify-both') {
      throw new Error(`Invalid ${contextLabel} value: "${token}". Please use verify-altcha, verify-turn, or verify-powdet.`);
    }
    if (token === 'web-download') {
      throw new Error(`Invalid ${contextLabel} value: "web-download". Please use verify-web-download or pass-web-download.`);
    }
    if (!VALID_ACTIONS_SET.has(token)) {
      throw new Error(`Invalid ${contextLabel} value: "${token}". Valid actions: ${VALID_ACTIONS.join(', ')}`);
    }
  }

  return tokens.join(',');
}

const normalizeDifficultyRangeValue = (value, fallback) => {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
};

const parseAltchaDifficultyRange = (rawValue) => {
  const fallback = {
    baseMin: ALTCHA_DEFAULT_BASE_DIFFICULTY,
    baseMax: ALTCHA_DEFAULT_BASE_DIFFICULTY,
  };
  if (typeof rawValue !== 'string') {
    return fallback;
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed.includes('-')) {
    const [minRaw, maxRaw] = trimmed.split('-', 2);
    const minValue = normalizeDifficultyRangeValue(Number(minRaw?.trim()), fallback.baseMin);
    const maxValue = normalizeDifficultyRangeValue(Number(maxRaw?.trim()), minValue);
    if (minValue > 0 && maxValue >= minValue) {
      return { baseMin: minValue, baseMax: maxValue };
    }
    return fallback;
  }
  const singleValue = normalizeDifficultyRangeValue(Number(trimmed), fallback.baseMin);
  if (singleValue > 0) {
    return { baseMin: singleValue, baseMax: singleValue };
  }
  return fallback;
};

const parseExponentMultiplier = (rawValue, fallback, { allowZero = false } = {}) => {
  if (rawValue === undefined || rawValue === null) {
    return fallback;
  }
  const normalized = String(rawValue).trim();
  if (!normalized) {
    return fallback;
  }
  let parsedValue = null;
  const suffixedMatch = normalized.match(/^(\d+)\s*x$/i);
  if (suffixedMatch) {
    parsedValue = Number.parseInt(suffixedMatch[1], 10);
  } else if (/^\d+$/u.test(normalized)) {
    parsedValue = Number.parseInt(normalized, 10);
  }
  if (!Number.isFinite(parsedValue)) {
    return fallback;
  }
  if (!allowZero && parsedValue <= 0) {
    return fallback;
  }
  if (allowZero && parsedValue < 0) {
    return fallback;
  }
  return parsedValue;
};

const parseMaxExponent = (rawValue, fallback = ALTCHA_MAX_EXPONENT_FALLBACK) =>
  parseExponentMultiplier(rawValue, fallback, { allowZero: false });

const parseMinUpgradeExponent = (rawValue, fallback, maxExponent) => {
  const parsed = parseExponentMultiplier(rawValue, fallback, { allowZero: true });
  const maxChallengeExponent = Math.max(0, Math.floor(maxExponent) - 1);
  if (maxChallengeExponent <= 0) {
    return 0;
  }
  if (!Number.isFinite(parsed)) {
    return Math.min(fallback, maxChallengeExponent);
  }
  if (parsed < 0) {
    return 0;
  }
  return Math.min(parsed, maxChallengeExponent);
};

const parseDurationToSeconds = (rawValue, fallbackSeconds) => {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
    return Math.floor(rawValue);
  }
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return fallbackSeconds;
    }
    const parsedWindow = parseWindowTime(trimmed);
    if (Number.isFinite(parsedWindow) && parsedWindow > 0) {
      return parsedWindow;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return fallbackSeconds;
};

const pickAltchaBaseDifficulty = (range) => {
  const min = normalizeDifficultyRangeValue(range?.baseMin, ALTCHA_DEFAULT_BASE_DIFFICULTY);
  const maxCandidate = normalizeDifficultyRangeValue(range?.baseMax, min);
  if (min === maxCandidate) {
    return min;
  }
  const span = maxCandidate - min + 1;
  const offset = Math.floor(Math.random() * span);
  return min + offset;
};

const pickAltchaAlgorithm = (effectiveExponent, dynamicConfig) => {
  if (!dynamicConfig) {
    return ALTCHA_DEFAULT_ALGORITHM;
  }
  const minUpgradeExponent = Number.isFinite(dynamicConfig.minUpgradeExponent)
    ? dynamicConfig.minUpgradeExponent
    : ALTCHA_MIN_UPGRADE_DEFAULT;
  if (!Number.isFinite(effectiveExponent) || effectiveExponent < minUpgradeExponent) {
    return ALTCHA_DEFAULT_ALGORITHM;
  }
  const randomIndex = Math.floor(Math.random() * ALTCHA_ALGORITHM_POOL.length);
  return ALTCHA_ALGORITHM_POOL[randomIndex] || ALTCHA_DEFAULT_ALGORITHM;
};

const computeNextAltchaDifficultyState = (prev, nowSeconds, cfg) => {
  if (!cfg) {
    return {
      level: 0,
      lastSuccessAt: nowSeconds,
      blockUntil: null,
    };
  }
  if (!prev) {
    return {
      level: 0,
      lastSuccessAt: nowSeconds,
      blockUntil: null,
    };
  }

  const prevLevel = Number.isFinite(prev.level) ? prev.level : 0;
  const prevLastSuccess = Number.isFinite(prev.lastSuccessAt) ? prev.lastSuccessAt : nowSeconds;
  const prevBlockUntil = Number.isFinite(prev.blockUntil) ? prev.blockUntil : null;
  const delta = nowSeconds - prevLastSuccess;
  let level = prevLevel;

  if (delta >= cfg.resetSeconds) {
    level = 0;
  } else if (delta <= cfg.windowSeconds) {
    level = prevLevel + 1;
  } else {
    level = Math.max(prevLevel - 1, 0);
  }

  let blockUntil = prevBlockUntil;
  if (level >= cfg.maxExponent && cfg.blockSeconds > 0) {
    blockUntil = nowSeconds + cfg.blockSeconds;
  } else if (blockUntil !== null && blockUntil <= nowSeconds) {
    blockUntil = null;
  }

  return {
    level,
    lastSuccessAt: nowSeconds,
    blockUntil,
  };
};

const getAltchaDifficultyForClient = (state, nowSeconds, cfg) => {
  if (!cfg) {
    const fallback = pickAltchaBaseDifficulty(null);
    return {
      difficulty: fallback,
      effectiveExponent: 0,
      blocked: false,
      retryAfterSeconds: 0,
    };
  }
  if (state?.blockUntil && state.blockUntil > nowSeconds) {
    return {
      difficulty: 0,
      effectiveExponent: Number.isFinite(state.level) ? state.level : 0,
      blocked: true,
      retryAfterSeconds: Math.max(1, state.blockUntil - nowSeconds),
    };
  }

  let exponent = Number.isFinite(state?.level) ? state.level : 0;
  if (state?.lastSuccessAt && nowSeconds - state.lastSuccessAt >= cfg.resetSeconds) {
    exponent = 0;
  }
  const maxForChallenge = Math.max(cfg.maxExponent - 1, 0);
  const effectiveExponent = Math.min(Math.max(exponent, 0), maxForChallenge);
  const base = pickAltchaBaseDifficulty(cfg);
  const multiplier = 2 ** effectiveExponent;

  return {
    difficulty: base * multiplier,
    effectiveExponent,
    blocked: false,
    retryAfterSeconds: 0,
  };
};

const computeNextPowdetDifficultyState = (prev, nowSeconds, cfg) => {
  if (!cfg) {
    return {
      level: 0,
      lastSuccessAt: nowSeconds,
      blockUntil: null,
    };
  }
  if (!prev) {
    return {
      level: 0,
      lastSuccessAt: nowSeconds,
      blockUntil: null,
    };
  }

  const prevLevel = Number.isFinite(prev.level) ? prev.level : 0;
  const prevLastSuccess = Number.isFinite(prev.lastSuccessAt) ? prev.lastSuccessAt : nowSeconds;
  const prevBlockUntil = Number.isFinite(prev.blockUntil) ? prev.blockUntil : null;
  const delta = nowSeconds - prevLastSuccess;
  let level = prevLevel;

  if (delta >= cfg.resetSeconds) {
    level = 0;
  } else if (delta <= cfg.windowSeconds) {
    level = prevLevel + 1;
  } else {
    level = Math.max(prevLevel - 1, 0);
  }

  let blockUntil = prevBlockUntil;
  if (level >= cfg.maxLevel && cfg.blockSeconds > 0) {
    blockUntil = nowSeconds + cfg.blockSeconds;
  } else if (blockUntil !== null && blockUntil <= nowSeconds) {
    blockUntil = null;
  }

  return {
    level,
    lastSuccessAt: nowSeconds,
    blockUntil,
  };
};

const getPowdetDifficultyForClient = (state, nowSeconds, cfg) => {
  if (!cfg) {
    return {
      difficultyLevel: 12,
      effectiveLevel: 0,
      blocked: false,
      retryAfterSeconds: 0,
    };
  }

  if (state?.blockUntil && state.blockUntil > nowSeconds) {
    return {
      difficultyLevel: cfg.baseLevelMin,
      effectiveLevel: Number.isFinite(state.level) ? state.level : 0,
      blocked: true,
      retryAfterSeconds: Math.max(1, state.blockUntil - nowSeconds),
    };
  }

  const rawLevel = Number.isFinite(state?.level) ? state.level : 0;
  const level = Math.max(0, Math.min(rawLevel, cfg.maxLevel));

  let difficulty = cfg.baseLevelMin + level * cfg.levelStep;
  if (difficulty > cfg.baseLevelMax) {
    difficulty = cfg.baseLevelMax;
  }

  return {
    difficultyLevel: difficulty,
    effectiveLevel: level,
    blocked: false,
    retryAfterSeconds: 0,
  };
};

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

function timingSafeEqualHex(a, b) {
  const aNorm = typeof a === 'string' ? a.trim() : '';
  const bNorm = typeof b === 'string' ? b.trim() : '';
  if (aNorm.length !== bNorm.length) return false;
  let diff = 0;
  for (let i = 0; i < aNorm.length; i += 1) {
    diff |= aNorm.charCodeAt(i) ^ bNorm.charCodeAt(i);
  }
  return diff === 0;
}

async function computePowdetHmac(config, payload) {
  const secret = String(config?.token || '').trim();
  if (!secret) {
    throw new Error('TOKEN is required when POWDET is enabled');
  }
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = encoder.encode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign('HMAC', key, message);
  const bytes = new Uint8Array(signature);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

const computeAltchaIpScope = async (clientIP, ipv4Suffix, ipv6Suffix) => {
  if (!clientIP || typeof clientIP !== 'string') {
    return { ipRange: '', ipHash: '' };
  }
  try {
    const ipRange = calculateIPSubnet(clientIP, ipv4Suffix, ipv6Suffix);
    if (!ipRange) {
      return { ipRange: '', ipHash: '' };
    }
    const ipHash = await sha256Hash(ipRange);
    return {
      ipRange,
      ipHash,
    };
  } catch (error) {
    console.error('[ALTCHA Dynamic] Failed to compute IP scope:', error instanceof Error ? error.message : String(error));
    return { ipRange: '', ipHash: '' };
  }
};

const ALTCHA_PATH_HASH_VERSION = 1;

const normalizeAltchaExponentValue = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.floor(parsed));
  }
  return 0;
};

const buildAltchaPathBindingValue = (pathHash, scopeHash, difficultyLevel) => {
  const normalizedPathHash = typeof pathHash === 'string' ? pathHash : '';
  const normalizedScopeHash = typeof scopeHash === 'string' ? scopeHash : '';
  const normalizedLevel = normalizeAltchaExponentValue(difficultyLevel);
  return JSON.stringify({
    v: ALTCHA_PATH_HASH_VERSION,
    p: normalizedPathHash,
    s: normalizedScopeHash,
    l: normalizedLevel,
  });
};

const parseAltchaPathBindingValue = (value) => {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  let payload = null;
  try {
    payload = JSON.parse(value);
  } catch (error) {
    return null;
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const pathHash = typeof payload.p === 'string' ? payload.p : '';
  if (!pathHash) {
    return null;
  }
  const scopeHash = typeof payload.s === 'string' ? payload.s : '';
  const level = normalizeAltchaExponentValue(payload.l);
  const canonicalValue = buildAltchaPathBindingValue(pathHash, scopeHash, level);
  const version = Number.isFinite(payload.v) ? Number(payload.v) : ALTCHA_PATH_HASH_VERSION;
  return {
    version,
    pathHash,
    scopeHash,
    level,
    canonicalValue,
  };
};

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

const resolveConfig = (env = {}, bootstrap = null) => {
  ensureRequiredEnv(env);
  const normalizeString = (value, defaultValue = '') => {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value !== 'string') return defaultValue;
    const trimmed = value.trim();
    return trimmed === '' ? defaultValue : trimmed;
  };
  const rawToken = env.TOKEN;
  const normalizedToken = typeof rawToken === 'string' ? rawToken : String(rawToken || '');
  const landingBootstrap = bootstrap && typeof bootstrap === 'object'
    ? bootstrap.landing || null
    : null;
  if (!landingBootstrap) {
    throw new Error('controller bootstrap.landing is required');
  }
  const pageSecret = typeof landingBootstrap.pageSecret === 'string' && landingBootstrap.pageSecret.trim() !== ''
    ? landingBootstrap.pageSecret.trim()
    : '';
  if (!pageSecret) {
    throw new Error('controller bootstrap.landing.pageSecret is required');
  }
  const altchaConfig = landingBootstrap.altcha && typeof landingBootstrap.altcha === 'object'
    ? landingBootstrap.altcha
    : null;
  if (!altchaConfig) {
    throw new Error('controller bootstrap.landing.altcha is required');
  }
  const altchaEnabled = Boolean(altchaConfig.enabled);
  const altchaBaseMin = normalizeDifficultyRangeValue(
    Number.isFinite(Number(altchaConfig.baseDifficultyMin)) ? Number(altchaConfig.baseDifficultyMin) : altchaConfig.baseDifficultyMin,
    ALTCHA_DEFAULT_BASE_DIFFICULTY
  );
  const altchaBaseMax = normalizeDifficultyRangeValue(
    Number.isFinite(Number(altchaConfig.baseDifficultyMax)) ? Number(altchaConfig.baseDifficultyMax) : altchaBaseMin,
    altchaBaseMin
  );
  const altchaDifficultyRange = {
    baseMin: altchaBaseMin,
    baseMax: altchaBaseMax >= altchaBaseMin ? altchaBaseMax : altchaBaseMin,
  };
  const altchaDifficultyStatic = altchaDifficultyRange.baseMin;
  const altchaTokenExpire = parseDurationToSeconds(altchaConfig.tokenExpireSeconds, parseWindowTime('3m'));
  const altchaTableName = typeof altchaConfig.tokenTable === 'string' && altchaConfig.tokenTable.trim()
    ? altchaConfig.tokenTable.trim()
    : 'ALTCHA_TOKEN_LIST';
  const altchaDifficultyWindowSeconds = parseDurationToSeconds(altchaConfig.difficultyWindowSeconds, 30);
  const altchaDifficultyResetSeconds = parseDurationToSeconds(altchaConfig.difficultyResetSeconds, 120);
  const altchaDifficultyBlockSeconds = parseDurationToSeconds(altchaConfig.maxBlockSeconds, 120);
  const altchaMaxExponent = parseMaxExponent(
    altchaConfig.maxExponent ?? altchaConfig.maxMultiplier ?? ALTCHA_MAX_EXPONENT_FALLBACK,
    ALTCHA_MAX_EXPONENT_FALLBACK
  );
  const altchaMinUpgradeExponent = parseMinUpgradeExponent(
    altchaConfig.minUpgradeExponent ?? altchaConfig.minUpgradeMultiplier ?? `${ALTCHA_MIN_UPGRADE_DEFAULT}x`,
    ALTCHA_MIN_UPGRADE_DEFAULT,
    altchaMaxExponent
  );
  const turnstileConfig = landingBootstrap.turnstile || {};
  const underAttack = Boolean(turnstileConfig.enabled);
  const turnstileSiteKey = typeof turnstileConfig.siteKey === 'string' ? turnstileConfig.siteKey.trim() : '';
  const turnstileSecretKey = typeof turnstileConfig.secretKey === 'string' ? turnstileConfig.secretKey.trim() : '';
  if (underAttack && (!turnstileSiteKey || !turnstileSecretKey)) {
    throw new Error('controller landing.turnstile.siteKey and secretKey are required when turnstile.enabled is true');
  }
  let turnstileTokenBindingEnabled = turnstileConfig.tokenBinding !== false;
  let turnstileTokenTTLSeconds = Number(turnstileConfig.tokenTTLSeconds);
  if (!Number.isFinite(turnstileTokenTTLSeconds) || turnstileTokenTTLSeconds <= 0) {
    turnstileTokenTTLSeconds = parseWindowTime('10m');
  }
  const turnstileTokenTTL = `${turnstileTokenTTLSeconds}s`;
  const turnstileTokenTableName = typeof turnstileConfig.tokenTable === 'string' && turnstileConfig.tokenTable.trim()
    ? turnstileConfig.tokenTable.trim()
    : 'TURNSTILE_TOKEN_BINDING';
  let turnstileCookieExpireSeconds = Number(turnstileConfig.cookieExpireSeconds);
  if (!Number.isFinite(turnstileCookieExpireSeconds) || turnstileCookieExpireSeconds <= 0) {
    turnstileCookieExpireSeconds = parseWindowTime('2m');
  }
  const rawTurnstileExpectedAction = typeof turnstileConfig.expectedAction === 'string'
    ? turnstileConfig.expectedAction.trim()
    : '';
  const turnstileExpectedAction = rawTurnstileExpectedAction || 'download';
  const turnstileEnforceAction = turnstileConfig.enforceAction !== false;
  const normalizedAllowedHostnames = Array.isArray(turnstileConfig.allowedHostnames)
    ? turnstileConfig.allowedHostnames
        .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
        .filter((entry) => entry.length > 0)
    : [];
  const hasAllowedHostnames = normalizedAllowedHostnames.length > 0;
  const turnstileEnforceHostname = Boolean(turnstileConfig.enforceHostname) && hasAllowedHostnames;

  const powdetConfig = landingBootstrap.powdet && typeof landingBootstrap.powdet === 'object'
    ? landingBootstrap.powdet
    : {};
  const powdetEnabled = Boolean(powdetConfig.enabled);
  const powdetBaseUrl = normalizeString(powdetConfig.baseUrl);
  const powdetStaticBaseUrl = normalizeString(powdetConfig.staticBaseUrl);
  const powdetApiToken = normalizeString(powdetConfig.token);
  const powdetTableName = normalizeString(powdetConfig.table, 'POW_CHALLENGE_TICKET');
  const powdetDifficultyTableName = normalizeString(powdetConfig.difficultyTable, POWDET_DIFFICULTY_TABLE);
  const powdetExpireSeconds = parseDurationToSeconds(powdetConfig.expireSeconds, 180);
  const powdetClockSkewSeconds = parseDurationToSeconds(powdetConfig.clockSkewSeconds, 60);
  const powdetMaxWindowSeconds = parseDurationToSeconds(powdetConfig.maxWindowSeconds, 600);
  let powdetStaticLevel = Number.isFinite(powdetConfig.staticLevel)
    ? Number(powdetConfig.staticLevel)
    : parseInteger(powdetConfig.staticLevel, NaN);
  if (!Number.isFinite(powdetStaticLevel)) {
    powdetStaticLevel = NaN;
  }
  let powdetDynamic = null;
  if (powdetConfig.dynamic && typeof powdetConfig.dynamic === 'object') {
    powdetDynamic = {
      windowSeconds: parseDurationToSeconds(powdetConfig.dynamic.windowSeconds, 60),
      resetSeconds: parseDurationToSeconds(powdetConfig.dynamic.resetSeconds, 300),
      blockSeconds: parseDurationToSeconds(powdetConfig.dynamic.blockSeconds, 300),
      baseLevelMin: parseInteger(powdetConfig.dynamic.baseLevelMin, 12),
      baseLevelMax: parseInteger(powdetConfig.dynamic.baseLevelMax, 20),
      levelStep: Math.max(1, parseInteger(powdetConfig.dynamic.levelStep, 1)),
      maxLevel: Math.max(0, parseInteger(powdetConfig.dynamic.maxLevel, 4)),
    };
  }
  if (powdetEnabled && (!powdetBaseUrl || !powdetApiToken)) {
    throw new Error('controller bootstrap.landing.powdet.baseUrl and token are required when powdet.enabled is true');
  }

  // Parse prefix lists (comma-separated)
  const parsePrefixList = (value) => {
    if (!value || typeof value !== 'string') return [];
    return value.split(',').map(p => p.trim()).filter(p => p.length > 0);
  };

  const cryptPrefix = normalizeString(env.CRYPT_PREFIX);
  const cryptIncludes = parsePrefixList(env.CRYPT_INCLUDES);
  const webDownloaderEnabled = parseBoolean(env.WEB_DOWNLOADER_ENABLED, false);
  const clientDecryptEnabled = parseBoolean(env.CLIENT_DECRYPT_ENABLED, false);
  let webDownloaderMaxConnections = parseInteger(
    env.WEB_DOWNLOADER_MAX_CONNECTIONS,
    DEFAULT_WEB_DOWNLOADER_MAX_CONNECTIONS
  );
  if (!Number.isFinite(webDownloaderMaxConnections) || webDownloaderMaxConnections <= 0) {
    webDownloaderMaxConnections = DEFAULT_WEB_DOWNLOADER_MAX_CONNECTIONS;
  }
  webDownloaderMaxConnections = Math.max(
    MIN_WEB_DOWNLOADER_MAX_CONNECTIONS,
    Math.min(MAX_WEB_DOWNLOADER_MAX_CONNECTIONS, Math.floor(webDownloaderMaxConnections))
  );
  const cryptEncryptionMode = normalizeString(env.CRYPT_ENCRYPTION_MODE, 'crypt') || 'crypt';
  let cryptFileHeaderSize = parseInteger(
    env.CRYPT_FILE_HEADER_SIZE,
    DEFAULT_CRYPT_FILE_HEADER_SIZE
  );
  if (!Number.isFinite(cryptFileHeaderSize) || cryptFileHeaderSize <= 0) {
    cryptFileHeaderSize = DEFAULT_CRYPT_FILE_HEADER_SIZE;
  }
  let cryptBlockHeaderSize = parseInteger(
    env.CRYPT_BLOCK_HEADER_SIZE,
    DEFAULT_CRYPT_BLOCK_HEADER_SIZE
  );
  if (!Number.isFinite(cryptBlockHeaderSize) || cryptBlockHeaderSize <= 0) {
    cryptBlockHeaderSize = DEFAULT_CRYPT_BLOCK_HEADER_SIZE;
  }
  let cryptBlockDataSize = parseInteger(
    env.CRYPT_BLOCK_DATA_SIZE,
    DEFAULT_CRYPT_BLOCK_DATA_SIZE
  );
  if (!Number.isFinite(cryptBlockDataSize) || cryptBlockDataSize <= 0) {
    cryptBlockDataSize = DEFAULT_CRYPT_BLOCK_DATA_SIZE;
  }
  const rawCryptDataKey = normalizeString(env.CRYPT_DATA_KEY);
  let cryptDataKeyBase64 = '';
  if (rawCryptDataKey) {
    const dataKeyBytes = hexToUint8Array(rawCryptDataKey);
    if (!dataKeyBytes || dataKeyBytes.length !== CRYPT_DATA_KEY_LENGTH) {
      throw new Error(`CRYPT_DATA_KEY must be a ${CRYPT_DATA_KEY_LENGTH * 2}-character hex string`);
    }
    cryptDataKeyBase64 = uint8ToBase64(dataKeyBytes);
  } else if (webDownloaderEnabled || clientDecryptEnabled) {
    throw new Error('CRYPT_DATA_KEY is required when WEB_DOWNLOADER_ENABLED or CLIENT_DECRYPT_ENABLED is true');
  }

  // Parse database mode for rate limiting
  const dbModeRaw = env.DB_MODE && typeof env.DB_MODE === 'string' ? env.DB_MODE.trim() : '';
  const normalizedDbMode = dbModeRaw ? dbModeRaw.toLowerCase() : '';
  const dbMode = normalizedDbMode === 'custom-pg-rest' ? 'custom-pg-rest' : '';
  const hasDbMode = dbMode === 'custom-pg-rest';
  if (normalizedDbMode && !hasDbMode) {
    throw new Error(`Invalid DB_MODE: "${dbModeRaw}". Only "" or "custom-pg-rest" are supported.`);
  }
  const enableCfRatelimiter = normalizeString(env.ENABLE_CF_RATELIMITER, 'false').toLowerCase() === 'true';
  const cfRatelimiterBinding = normalizeString(env.CF_RATELIMITER_BINDING, 'CF_RATE_LIMITER');
  let postgrestUrl = '';

  if (!hasDbMode) {
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
  const rawFileWindowTime = env.FILE_WINDOW_TIME && typeof env.FILE_WINDOW_TIME === 'string'
    ? env.FILE_WINDOW_TIME.trim()
    : '60s';
  let fileWindowTimeSeconds = parseWindowTime(rawFileWindowTime || '60s');
  if (fileWindowTimeSeconds <= 0) {
    fileWindowTimeSeconds = parseWindowTime('60s');
  }
  const fileWindowTime = rawFileWindowTime && rawFileWindowTime.length > 0 ? rawFileWindowTime : '60s';
  const fileLimit = parseInteger(env.IPSUBNET_FILE_WINDOWTIME_LIMIT, 4);
  const rawFileBlockTime = env.FILE_BLOCK_TIME && typeof env.FILE_BLOCK_TIME === 'string'
    ? env.FILE_BLOCK_TIME.trim()
    : '4m';
  let fileBlockTimeSeconds = parseWindowTime(rawFileBlockTime || '4m');
  if (fileBlockTimeSeconds < 0) {
    fileBlockTimeSeconds = parseWindowTime('4m');
  }

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
  const ipRateLimitActive = Boolean(hasDbMode && windowTimeSeconds > 0 && ipSubnetLimit > 0);
  const fileRateLimitActive = Boolean(hasDbMode && fileWindowTimeSeconds > 0 && fileLimit > 0);

  if (hasDbMode && ipSubnetLimit === 0 && !ipRateLimitDisabledLogged) {
    console.log('IP rate limiting disabled (limit=0)');
    ipRateLimitDisabledLogged = true;
  }

  if (hasDbMode) {
    // Custom PostgreSQL REST API (PostgREST) configuration
    postgrestUrl = env.POSTGREST_URL && typeof env.POSTGREST_URL === 'string' ? env.POSTGREST_URL.trim() : '';
    const postgrestTableName = env.POSTGREST_TABLE_NAME && typeof env.POSTGREST_TABLE_NAME === 'string' ? env.POSTGREST_TABLE_NAME.trim() : '';

    if (!postgrestUrl || verifyHeaders.length === 0 || verifySecrets.length === 0) {
      throw new Error('DB_MODE is set to "custom-pg-rest" but POSTGREST_URL, VERIFY_HEADER, or VERIFY_SECRET is missing');
    }
    if (ipSubnetLimit > 0 && windowTimeSeconds <= 0) {
      throw new Error('WINDOW_TIME must be greater than zero when IPSUBNET_WINDOWTIME_LIMIT > 0');
    }
    if (fileLimit > 0 && fileWindowTimeSeconds <= 0) {
      throw new Error('FILE_WINDOW_TIME must be greater than zero when IPSUBNET_FILE_WINDOWTIME_LIMIT > 0');
    }

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
      fileLimit,
      fileWindowTimeSeconds,
      fileBlockTimeSeconds,
      fileTableName: 'IP_FILE_LIMIT_TABLE',
      ipRateLimitEnabled: ipRateLimitActive,
      fileRateLimitEnabled: fileRateLimitActive,
    };

    rateLimitEnabled = Boolean(ipRateLimitActive || fileRateLimitActive);

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
    } else {
      console.warn('[CONFIG] Cache DISABLED: sizeTTLSeconds =', sizeTTLSeconds);
    }
  }

  const idleTimeoutRaw = normalizeString(env.IDLE_TIMEOUT, '0');
  let idleTimeoutSeconds = hasDbMode ? parseWindowTime(idleTimeoutRaw) : 0;
  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds < 0) {
    idleTimeoutSeconds = 0;
  }

  const idleTableName = normalizeString(env.IDLE_TABLE_NAME, 'DOWNLOAD_LAST_ACTIVE_TABLE');

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
  const rawMaxDurationLabel =
    typeof env.MAX_DURATION_TIME === 'string' ? env.MAX_DURATION_TIME.trim() : '';
  let maxDurationMilliseconds = null;
  let maxDurationSeconds = 0;
  if (rawMaxDurationLabel) {
    const parsedMaxDurationSeconds = parseWindowTime(rawMaxDurationLabel);
    if (parsedMaxDurationSeconds > 0) {
      maxDurationMilliseconds = parsedMaxDurationSeconds * 1000;
      maxDurationSeconds = parsedMaxDurationSeconds;
    }
  }

  if (appendAdditional && !normalizedAlistAddress) {
    throw new Error('ALIST_ADDRESS (or ADDRESS) is required when IF_APPEND_ADDITIONAL is true');
  }

  if (enableCfRatelimiter) {
    const ratelimiter = env[cfRatelimiterBinding];
    if (!ratelimiter || typeof ratelimiter.limit !== 'function') {
      throw new Error(
        `ENABLE_CF_RATELIMITER is true but binding "${cfRatelimiterBinding}" not found or invalid. Please configure [[rate_limit]] binding in wrangler.toml with name="${cfRatelimiterBinding}".`
      );
    }
  }

  const safeAltchaWindowSeconds = Math.max(1, altchaDifficultyWindowSeconds);
  const safeAltchaResetSeconds = Math.max(safeAltchaWindowSeconds, altchaDifficultyResetSeconds);
  const safeAltchaBlockSeconds = Math.max(0, altchaDifficultyBlockSeconds);
  const altchaStatefulAvailable = Boolean(altchaTableName);
  const altchaDynamicEnabled = Boolean(altchaEnabled && hasDbMode && altchaStatefulAvailable);
  const altchaDynamic = altchaDynamicEnabled
    ? {
        baseMin: altchaDifficultyRange.baseMin,
        baseMax: altchaDifficultyRange.baseMax,
        maxExponent: Math.max(1, altchaMaxExponent),
        blockSeconds: safeAltchaBlockSeconds,
        windowSeconds: safeAltchaWindowSeconds,
        resetSeconds: safeAltchaResetSeconds,
        minUpgradeExponent: altchaMinUpgradeExponent,
      }
    : null;

  return {
    token: env.TOKEN,
    workerAddresses: env.WORKER_ADDRESS_DOWNLOAD,
    verifyHeader: verifyHeaders,
    verifySecret: verifySecrets,
    ipv4Only: parseBoolean(env.IPV4_ONLY, false),
    signSecret: env.SIGN_SECRET && env.SIGN_SECRET.trim() !== '' ? env.SIGN_SECRET : env.TOKEN,
    underAttack,
    altchaEnabled,
    altchaDifficulty: altchaDifficultyStatic,
    altchaDifficultyStatic,
    altchaDifficultyRange,
    altchaMinUpgradeExponent,
    altchaDynamicEnabled,
    altchaDynamic,
    altchaTokenExpire,
    altchaTableName,
    powdetEnabled,
    powdetBaseUrl,
    powdetStaticBaseUrl,
    powdetApiToken,
    powdetTableName,
    powdetExpireSeconds,
    powdetClockSkewSeconds,
    powdetMaxWindowSeconds,
    powdetStaticLevel,
    powdetDynamic,
    powdetDifficultyTableName,
    pageSecret,
    turnstileSiteKey,
    turnstileSecretKey,
    turnstileTokenBindingEnabled,
    turnstileTokenTTL,
    turnstileTokenTTLSeconds,
    turnstileTokenTableName,
    turnstileCookieExpireSeconds,
    turnstileExpectedAction,
    turnstileEnforceAction,
    turnstileEnforceHostname,
    turnstileAllowedHostnames: normalizedAllowedHostnames,
    turnstileAllowedHostnamesSet: new Set(normalizedAllowedHostnames),
    cleanupPercentage,
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
    fileWindowTime,
    fileWindowTimeSeconds,
    fileLimit,
    fileBlockTimeSeconds,
    enableCfRatelimiter,
    cfRatelimiterBinding,
    ipv4Suffix,
    ipv6Suffix,
    ipRateLimitActive,
    fileRateLimitActive,
    appendAdditional,
    alistAddress: normalizedAlistAddress,
    minBandwidthBytesPerSecond: bandwidthBytesPerSecond,
    minDurationSeconds,
    maxDurationTime: maxDurationMilliseconds,
    maxDurationSeconds,
    idleTimeoutRaw,
    idleTimeoutSeconds,
    idleTableName,
    crypt: {
      prefix: cryptPrefix || '',
      includes: cryptIncludes,
      encryptionMode: cryptEncryptionMode,
      fileHeaderSize: cryptFileHeaderSize,
      blockHeaderSize: cryptBlockHeaderSize,
      blockDataSize: cryptBlockDataSize,
      dataKeyBase64: cryptDataKeyBase64,
    },
    webDownloaderEnabled,
    webDownloaderMaxConnections,
    clientDecryptEnabled,
    env,
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
  const action = typeof result?.action === 'string' ? result.action : '';
  const hostname = typeof result?.hostname === 'string' ? result.hostname : '';
  const cdata = typeof result?.cdata === 'string' ? result.cdata : '';
  const challengeTs = typeof result?.challenge_ts === 'string' ? result.challenge_ts : '';
  const errorCodes = Array.isArray(result?.['error-codes']) ? result['error-codes'] : [];
  if (!result.success) {
    const reason = errorCodes.length > 0 ? String(errorCodes[0]) : 'turnstile verification failed';
    return {
      ok: false,
      message: reason,
      errorCodes,
      action,
      hostname,
      cdata,
      challengeTs,
      raw: result,
    };
  }
  return {
    ok: true,
    action,
    hostname,
    cdata,
    challengeTs,
    raw: result,
  };
};

const fetchPowdetChallenge = async (config, difficultyLevel) => {
  const base = String(config.powdetBaseUrl || '').trim();
  const token = String(config.powdetApiToken || '').trim();
  if (!base || !token) {
    throw new Error('powdet baseUrl and token are required when POWDET is enabled');
  }
  const url = new URL('/GetChallenges', base);
  url.searchParams.set('difficultyLevel', String(Number.isFinite(difficultyLevel) ? difficultyLevel : 1));

  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`powdet GetChallenges failed: ${resp.status} ${text}`);
  }
  const arr = await resp.json().catch(() => null);
  if (!Array.isArray(arr) || arr.length === 0 || typeof arr[0] !== 'string') {
    throw new Error('powdet GetChallenges returned invalid payload');
  }
  return arr[0];
};

const verifyPowdet = async (config, challenge, nonce) => {
  const base = String(config.powdetBaseUrl || '').trim();
  const token = String(config.powdetApiToken || '').trim();
  if (!base || !token) {
    throw new Error('powdet baseUrl and token are required when POWDET is enabled');
  }
  const url = new URL('/Verify', base);
  url.searchParams.set('challenge', String(challenge || ''));
  url.searchParams.set('nonce', String(nonce || ''));

  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return {
      ok: false,
      status: resp.status,
      message: text || 'powdet verify failed',
    };
  }
  return { ok: true, status: resp.status };
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

const generateNonce = (byteLength = 16) => {
  try {
    const length = Number.isInteger(byteLength) && byteLength > 0 ? byteLength : 16;
    const nonceBytes = new Uint8Array(length);
    crypto.getRandomValues(nonceBytes);
    return encodeUrlSafeBase64(nonceBytes).replace(/=+$/u, '');
  } catch (error) {
    console.error('[Binding] Failed to generate nonce:', error instanceof Error ? error.message : String(error));
    return '';
  }
};

const computeClientIpHash = async (clientIP) => {
  if (!clientIP || typeof clientIP !== 'string' || clientIP.trim().length === 0) {
    return '';
  }
  try {
    return await sha256Hash(clientIP.trim());
  } catch (error) {
    console.error('[Binding] Failed to compute client IP hash:', error instanceof Error ? error.message : String(error));
    return '';
  }
};

const buildBindingPayload = async (
  secret,
  pathHash,
  ipHash,
  expiresAtSeconds,
  context = 'Binding',
  additionalData = null,
) => {
  const normalizedPathHash = typeof pathHash === 'string' ? pathHash : '';
  const normalizedIpHash = typeof ipHash === 'string' ? ipHash : '';
  const normalizedExpires =
    Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0 ? Math.floor(expiresAtSeconds) : 0;
  const payloadObject = {
    pathHash: normalizedPathHash,
    ipHash: normalizedIpHash,
    expiresAt: normalizedExpires,
  };
  if (additionalData && typeof additionalData === 'object') {
    for (const [key, value] of Object.entries(additionalData)) {
      payloadObject[key] = value;
    }
  }
  const payload = JSON.stringify(payloadObject);
  try {
    const macBytes = await computeHmac(secret, payload);
    const mac = encodeUrlSafeBase64(macBytes);
    return {
      pathHash: normalizedPathHash,
      ipHash: normalizedIpHash,
      bindingMac: mac,
      expiresAt: normalizedExpires,
    };
  } catch (error) {
    console.error(`[${context}] Failed to compute binding MAC:`, error instanceof Error ? error.message : String(error));
    return {
      pathHash: normalizedPathHash,
      ipHash: normalizedIpHash,
      bindingMac: '',
      expiresAt: normalizedExpires,
    };
  }
};

const buildAltchaBinding = async (secret, pathHash, ipHash, expiresAtSeconds, salt) => {
  const normalizedSalt = typeof salt === 'string' ? salt : '';
  const additionalData = normalizedSalt ? { salt: normalizedSalt } : null;
  return buildBindingPayload(secret, pathHash, ipHash, expiresAtSeconds, 'ALTCHA', additionalData);
};

const normalizeAltchaStateRow = (row) => {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const levelRaw = row.level ?? row.LEVEL;
  const lastRaw = row.last_success_at ?? row.LAST_SUCCESS_AT;
  const blockRaw = row.block_until ?? row.BLOCK_UNTIL;
  const level = Number(levelRaw);
  const lastSuccessAt = Number(lastRaw);
  const blockUntil = Number(blockRaw);
  return {
    level: Number.isFinite(level) ? level : 0,
    lastSuccessAt: Number.isFinite(lastSuccessAt) ? lastSuccessAt : 0,
    blockUntil: Number.isFinite(blockUntil) ? blockUntil : null,
  };
};

const buildTurnstileCData = async (secret, bindingMac, nonce) => {
  if (!secret || typeof secret !== 'string' || secret.length === 0) {
    return '';
  }
  if (!bindingMac || typeof bindingMac !== 'string' || bindingMac.length === 0) {
    return '';
  }
  if (!nonce || typeof nonce !== 'string' || nonce.length === 0) {
    return '';
  }
  try {
    const macBytes = await computeHmac(secret, `${bindingMac}:${nonce}`);
    return encodeUrlSafeBase64(macBytes).replace(/=+$/u, '');
  } catch (error) {
    console.error('[Turnstile Binding] Failed to compute cData:', error instanceof Error ? error.message : String(error));
    return '';
  }
};

const fetchAltchaDifficultyState = async (config, env, ipHash) => {
  if (!config?.altchaDynamic || !ipHash) {
    return null;
  }
  const dbMode = getNormalizedDbMode(config);
  if (dbMode !== 'custom-pg-rest') {
    return null;
  }
  try {
    const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
    if (!postgrestUrl) {
      return null;
    }
    const rpcUrl = `${postgrestUrl}/rpc/landing_get_altcha_difficulty`;
    const headers = { 'Content-Type': 'application/json' };
    applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_ip_hash: ipHash,
        p_table_name: ALTCHA_DIFFICULTY_TABLE,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('[ALTCHA Dynamic] PostgREST fetch failed:', response.status, text);
      return null;
    }
    const payload = await response.json().catch(() => null);
    if (Array.isArray(payload) && payload.length > 0) {
      return normalizeAltchaStateRow(payload[0]);
    }
    return null;
  } catch (error) {
    console.error('[ALTCHA Dynamic] Failed to fetch state:', error instanceof Error ? error.message : String(error));
  }
  return null;
};

const updateAltchaDifficultyState = async (config, env, scope, nowSeconds) => {
  if (!config?.altchaDynamic || !scope?.ipHash || !scope?.ipRange) {
    return;
  }
  const dbMode = getNormalizedDbMode(config);
  if (!dbMode) {
    return;
  }
  try {
    if (dbMode === 'custom-pg-rest') {
      const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        return;
      }
      const rpcUrl = `${postgrestUrl}/rpc/landing_update_altcha_difficulty`;
      const headers = { 'Content-Type': 'application/json' };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      const body = {
        p_ip_hash: scope.ipHash,
        p_ip_range: scope.ipRange,
        p_now: nowSeconds,
        p_window_seconds: config.altchaDynamic.windowSeconds,
        p_reset_seconds: config.altchaDynamic.resetSeconds,
        p_max_exponent: config.altchaDynamic.maxExponent,
        p_block_seconds: config.altchaDynamic.blockSeconds,
        p_table_name: ALTCHA_DIFFICULTY_TABLE,
      };
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error('[ALTCHA Dynamic] PostgREST update failed:', response.status, text);
      }
      return;
    }
  } catch (error) {
    console.error('[ALTCHA Dynamic] Failed to update state:', error instanceof Error ? error.message : String(error));
  }
};

const normalizePowdetStateRow = normalizeAltchaStateRow;

const fetchPowdetDifficultyState = async (config, env, ipHash) => {
  if (!config?.powdetDynamic || !ipHash) {
    return null;
  }
  const dbMode = getNormalizedDbMode(config);
  if (dbMode !== 'custom-pg-rest') {
    return null;
  }
  const tableName = config.powdetDifficultyTableName || POWDET_DIFFICULTY_TABLE;
  try {
    const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
    if (!postgrestUrl) {
      return null;
    }
    const rpcUrl = `${postgrestUrl}/rpc/landing_get_altcha_difficulty`;
    const headers = { 'Content-Type': 'application/json' };
    applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_ip_hash: ipHash,
        p_table_name: tableName,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('[Powdet Dynamic] PostgREST fetch failed:', response.status, text);
      return null;
    }
    const payload = await response.json().catch(() => null);
    if (Array.isArray(payload) && payload.length > 0) {
      return normalizePowdetStateRow(payload[0]);
    }
    return null;
  } catch (error) {
    console.error('[Powdet Dynamic] Failed to fetch state:', error instanceof Error ? error.message : String(error));
  }
  return null;
};

const updatePowdetDifficultyState = async (config, env, scope, nowSeconds) => {
  if (!config?.powdetDynamic || !scope?.ipHash || !scope?.ipRange) {
    return;
  }
  const dbMode = getNormalizedDbMode(config);
  if (!dbMode) {
    return;
  }
  const tableName = config.powdetDifficultyTableName || POWDET_DIFFICULTY_TABLE;
  try {
    if (dbMode === 'custom-pg-rest') {
      const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        return;
      }
      const rpcUrl = `${postgrestUrl}/rpc/landing_update_altcha_difficulty`;
      const headers = { 'Content-Type': 'application/json' };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      const body = {
        p_ip_hash: scope.ipHash,
        p_ip_range: scope.ipRange,
        p_now: nowSeconds,
        p_window_seconds: config.powdetDynamic.windowSeconds,
        p_reset_seconds: config.powdetDynamic.resetSeconds,
        p_max_exponent: config.powdetDynamic.maxLevel,
        p_block_seconds: config.powdetDynamic.blockSeconds,
        p_table_name: tableName,
      };
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error('[Powdet Dynamic] PostgREST update failed:', response.status, text);
      }
      return;
    }
  } catch (error) {
    console.error('[Powdet Dynamic] Failed to update state:', error instanceof Error ? error.message : String(error));
  }
};

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

const respondAltchaBlocked = (origin, retryAfterSeconds = 0) => {
  const headers = safeHeaders(origin);
  headers.set('content-type', 'text/plain;charset=UTF-8');
  headers.set('cache-control', 'no-store');
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    headers.set('Retry-After', String(Math.max(1, Math.floor(retryAfterSeconds))));
  }
  return new Response('429 ALTCHA dynamic difficulty blocked', {
    status: 429,
    headers,
  });
};

const respondRateLimitExceeded = (origin, subject, limit, windowTime, retryAfter) => {
  const headers = safeHeaders(origin);
  headers.set('content-type', 'application/json;charset=UTF-8');
  headers.set('cache-control', 'no-store');
  const retryAfterSeconds = Math.ceil(retryAfter);
  headers.set('Retry-After', String(retryAfterSeconds));
  const message = `${subject} exceeds the limit of ${limit} requests in ${windowTime}`;
  return new Response(JSON.stringify({
    code: 429,
    message,
    'retry-after': retryAfterSeconds
  }), { status: 429, headers });
};

const maybeRespondRateLimit = (origin, clientIP, decodedPath, config, rateLimitState) => {
  if (!rateLimitState) {
    return null;
  }

  const ipFailed = rateLimitState.ipAllowed === false;
  const fileFailed = rateLimitState.fileAllowed === false;

  if (!ipFailed && !fileFailed) {
    return null;
  }

  const ipSubnet = rateLimitState.ipSubnet || clientIP || 'client';
  const safePath = decodedPath || '/';
  const ipRetry = ipFailed ? Number(rateLimitState.ipRetryAfter) : Number.POSITIVE_INFINITY;
  const fileRetry = fileFailed ? Number(rateLimitState.fileRetryAfter) : Number.POSITIVE_INFINITY;
  let retryAfter = Math.min(ipRetry, fileRetry);

  if (!Number.isFinite(retryAfter) || retryAfter <= 0) {
    retryAfter = Math.max(
      1,
      Number.isFinite(ipRetry) && ipRetry > 0 ? ipRetry : (Number.isFinite(fileRetry) && fileRetry > 0 ? fileRetry : 60)
    );
  }

  const preferFile = fileFailed && (fileRetry <= ipRetry);
  const limitValue = preferFile ? (config.fileLimit || 0) : (config.ipSubnetLimit || 0);
  const windowLabel = preferFile ? (config.fileWindowTime || config.windowTime) : config.windowTime;
  const subject = preferFile ? `${ipSubnet} + ${safePath}` : ipSubnet;

  return respondRateLimitExceeded(origin, subject, limitValue, windowLabel, retryAfter);
};

/**
 * Check Cloudflare Rate Limiter
 * @param {Object} env - Worker环境对象
 * @param {string} clientIP - 客户端IP
 * @param {string} ipv4Suffix - IPv4子网掩码
 * @param {string} ipv6Suffix - IPv6子网前缀
 * @param {string} bindingName - Rate Limiter绑定名称
 * @returns {Promise<{allowed: boolean, ipSubnet: string}>}
 */
async function checkCfRatelimit(env, clientIP, ipv4Suffix, ipv6Suffix, bindingName) {
  const ipSubnet = calculateIPSubnet(clientIP, ipv4Suffix, ipv6Suffix);

  if (!ipSubnet) {
    return { allowed: true, ipSubnet };
  }

  const ipHash = await sha256Hash(ipSubnet);
  const ratelimiter = env[bindingName];
  const { success } = await ratelimiter.limit({ key: ipHash });

  return { allowed: success, ipSubnet };
}

const extractClientIP = (request) => getClientIp(request) || '';

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

const calculateExpireTimestamp = (
  sizeBytes,
  minDurationSeconds,
  bandwidthBytesPerSecond,
  maxDurationSeconds = 0
) => {
  const safeMinDuration = minDurationSeconds > 0 ? minDurationSeconds : 3600;
  const safeBandwidth = bandwidthBytesPerSecond > 0 ? bandwidthBytesPerSecond : (10 * 1_000_000) / 8;
  const estimatedDuration = sizeBytes > 0 ? Math.ceil(sizeBytes / safeBandwidth) : 0;
  let totalDuration = Math.max(safeMinDuration, estimatedDuration);
  if (Number.isFinite(maxDurationSeconds) && maxDurationSeconds > 0) {
    const safeMaxDuration = Math.floor(maxDurationSeconds);
    totalDuration = Math.min(totalDuration, safeMaxDuration);
    if (totalDuration < 0) {
      totalDuration = 0;
    }
  }
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

// Query FILESIZE_CACHE_TABLE via the configured backend; returns 0 when no record is found.
const fetchFilesizeFromCache = async (config, pathHash) => {
  const normalizedDbMode = typeof config.dbMode === 'string' ? config.dbMode.trim().toLowerCase() : '';
  if (!normalizedDbMode) {
    return 0;
  }

  const rawTableName = typeof config.cacheConfig?.tableName === 'string' && config.cacheConfig.tableName.trim().length > 0
    ? config.cacheConfig.tableName
    : (typeof config.filesizeCacheTableName === 'string' && config.filesizeCacheTableName.trim().length > 0
      ? config.filesizeCacheTableName
      : 'FILESIZE_CACHE_TABLE');
  const tableName = rawTableName.trim() || 'FILESIZE_CACHE_TABLE';

  try {
    if (normalizedDbMode === 'custom-pg-rest') {
      const postgrestUrl = config.cacheConfig?.postgrestUrl || config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        return 0;
      }
      const endpoint = new URL(`${postgrestUrl}/${tableName}`);
      endpoint.searchParams.set('PATH_HASH', `eq.${pathHash}`);
      endpoint.searchParams.set('limit', '1');

      const headers = {
        Accept: 'application/json',
        Prefer: 'return=representation',
      };
      const verifyHeader = config.cacheConfig?.verifyHeader || config.verifyHeader;
      const verifySecret = config.cacheConfig?.verifySecret || config.verifySecret;
      applyVerifyHeaders(headers, verifyHeader, verifySecret);

      const response = await fetch(endpoint.toString(), {
        method: 'GET',
        headers,
      });
      if (!response.ok) {
        return 0;
      }
      const results = await response.json().catch(() => []);
      if (Array.isArray(results) && results.length > 0) {
        const row = results[0];
        const value = row?.FILE_SIZE ?? row?.file_size ?? row?.size ?? row?.SIZE;
        return parseFileSize(value);
      }
      return 0;
    }

  } catch (error) {
    console.warn('[Landing] Filesize cache lookup failed:', error instanceof Error ? error.message : String(error));
  }

  return 0;
};

const createAdditionalParams = async (config, request, decodedPath, clientIP, signExpire, idleTimeoutSeconds, options = {}) => {
  if (!config.appendAdditional) return null;
  if (!request) {
    throw new Error('request missing for additional info');
  }
  let { sizeBytes, expireTime, fileInfo, isCrypted } = options;
  const safeIdleTimeoutSeconds =
    Number.isFinite(idleTimeoutSeconds) && idleTimeoutSeconds >= 0
      ? Math.floor(idleTimeoutSeconds)
      : 0;

  const pathHash = await sha256Hash(decodedPath);

  let resolvedSize = parseFileSize(sizeBytes);
  if (resolvedSize <= 0 && fileInfo) {
    resolvedSize = parseFileSize(fileInfo.size);
  }

  if (resolvedSize <= 0) {
    // Check the shared filesize cache before falling back to AList API.
    const cachedSize = await fetchFilesizeFromCache(config, pathHash);
    if (cachedSize > 0) {
      resolvedSize = cachedSize;
    }
  }

  if (resolvedSize <= 0) {
    if (!fileInfo) {
      fileInfo = await fetchAlistFileInfo(config, decodedPath, clientIP);
    }
    resolvedSize = parseFileSize(fileInfo?.size);
  }

  if (!Number.isFinite(resolvedSize) || resolvedSize < 0) {
    resolvedSize = 0;
  }
  sizeBytes = resolvedSize;

  if (!Number.isFinite(expireTime) || expireTime <= 0) {
    expireTime = calculateExpireTimestamp(
      sizeBytes,
      config.minDurationSeconds,
      config.minBandwidthBytesPerSecond,
      config.maxDurationSeconds
    );
  } else if (Number.isFinite(config.maxDurationSeconds) && config.maxDurationSeconds > 0) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const maxAllowedExpire = nowSeconds + Math.floor(config.maxDurationSeconds);
    expireTime = Math.min(expireTime, maxAllowedExpire);
  }

  const clientIpForOrigin = getClientIp(request);
  if (!clientIpForOrigin) {
    throw new Error('client ip missing for origin binding');
  }
  const snapshot = buildOriginSnapshot(request.cf, clientIpForOrigin);
  if (!snapshot) {
    throw new Error('origin snapshot unavailable');
  }
  const encrypt = await encryptOriginSnapshot(snapshot, config.token);

  const payload = JSON.stringify({
    pathHash,
    filesize: sizeBytes,
    expireTime,
    idle_timeout: safeIdleTimeoutSeconds,
    encrypt,
    isCrypted: isCrypted === true,
  });
  const rawAdditionalInfo = encodeTextToBase64(payload);
  const additionalInfo = rawAdditionalInfo.replace(/=+$/, '');
  const additionalInfoSign = await hmacSha256Sign(config.signSecret, additionalInfo, signExpire);
  return { additionalInfo, additionalInfoSign };
};

const createDownloadURL = async (
  config,
  request,
  { encodedPath, decodedPath, sign, clientIP, sizeBytes, expireTime, fileInfo, isCrypt = false },
  ctx = null
) => {
  const workerBaseURL = selectRandomWorker(config.workerAddresses);
  const normalizedFilePath = decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`;
  const normalizedSizeBytes = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;
  const normalizedDbMode = typeof config.dbMode === 'string' ? config.dbMode.trim() : '';
  const idleTimeoutSeconds =
    Number.isFinite(config.idleTimeoutSeconds) && config.idleTimeoutSeconds >= 0
      ? Math.floor(config.idleTimeoutSeconds)
      : 0;

  let resolvedExpireTime =
    Number.isFinite(expireTime) && expireTime > 0
      ? expireTime
      : calculateExpireTimestamp(
          normalizedSizeBytes,
          config.minDurationSeconds,
          config.minBandwidthBytesPerSecond,
          config.maxDurationSeconds
        );
  if (Number.isFinite(config.maxDurationSeconds) && config.maxDurationSeconds > 0) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const maxAllowedExpire = nowSeconds + Math.floor(config.maxDurationSeconds);
    resolvedExpireTime = Math.min(resolvedExpireTime, maxAllowedExpire);
  }

  const expire = extractExpireFromSign(sign);

  const pathBytes = new TextEncoder().encode(decodedPath);
  const base64Path = uint8ToBase64(pathBytes);
  const hashSign = await hmacSha256Sign(config.signSecret, base64Path, expire);

  const workerSignData = JSON.stringify({ path: decodedPath, worker_addr: workerBaseURL });
  const workerSign = await hmacSha256Sign(config.signSecret, workerSignData, expire);

  const downloadURLObj = new URL(encodedPath, workerBaseURL);
  downloadURLObj.searchParams.set('sign', sign);
  downloadURLObj.searchParams.set('hashSign', hashSign);
  downloadURLObj.searchParams.set('workerSign', workerSign);

  if (config.appendAdditional) {
    const additionalParams = await createAdditionalParams(config, request, decodedPath, clientIP, expire, idleTimeoutSeconds, {
      sizeBytes,
      expireTime,
      fileInfo,
      isCrypted: Boolean(isCrypt),
    });
    if (additionalParams) {
      downloadURLObj.searchParams.set('additionalInfo', additionalParams.additionalInfo);
      downloadURLObj.searchParams.set('additionalInfoSign', additionalParams.additionalInfoSign);
    }
  }

  if (idleTimeoutSeconds > 0 && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(
      writeIdleInitialRecord(ctx, {
        clientIP,
        path: decodedPath,
        dbMode: config.dbMode,
        rateLimitConfig: config.rateLimitConfig,
        cacheConfig: config.cacheConfig,
        verifyHeader: config.verifyHeader,
        verifySecret: config.verifySecret,
        idleTableName: config.idleTableName,
        ipv4Suffix: config.ipv4Suffix,
        ipv6Suffix: config.ipv6Suffix,
      })
    );
  }

  return downloadURLObj.toString();
};

/**
 * Write initial IDLE record when download link is generated.
 * @param {ExecutionContext|null} ctx
 * @param {object} config
 */
async function writeIdleInitialRecord(ctx, config) {
  const {
    clientIP,
    path,
    dbMode,
    rateLimitConfig,
    cacheConfig,
    verifyHeader,
    verifySecret,
    idleTableName,
    ipv4Suffix,
    ipv6Suffix,
  } = config || {};

  if (!clientIP || !path || dbMode !== 'custom-pg-rest' || !idleTableName) {
    return;
  }

  try {
    const ipSubnet = calculateIPSubnet(clientIP, ipv4Suffix, ipv6Suffix);
    if (!ipSubnet) {
      console.log('[IDLE] Failed to calculate IP subnet');
      return;
    }

    const [ipHash, pathHash] = await Promise.all([
      sha256Hash(ipSubnet),
      sha256Hash(path),
    ]);

    if (!ipHash || !pathHash) {
      console.log('[IDLE] Failed to calculate hashes');
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    const idlePostgrestUrl =
      rateLimitConfig?.postgrestUrl || cacheConfig?.postgrestUrl;
    if (!idlePostgrestUrl) {
      console.log('[IDLE] PostgREST URL missing');
      return;
    }

    const headers = {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    applyVerifyHeaders(headers, verifyHeader, verifySecret);

    const response = await fetch(`${idlePostgrestUrl}/rpc/download_update_last_active`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_ip_hash: ipHash,
        p_path_hash: pathHash,
        p_last_access_time: now,
        p_table_name: idleTableName,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.log('[IDLE] PostgREST write failed:', response.status, errorText);
      return;
    }

    console.log('[IDLE] PostgREST write success');
  } catch (error) {
    console.error('[IDLE] Failed to write initial record:', error instanceof Error ? error.message : String(error));
  }
}

const isCryptPath = (decodedPath, cryptConfig) => {
  if (!decodedPath || typeof decodedPath !== 'string' || !cryptConfig) {
    return false;
  }
  const normalizedPath = decodedPath;
  if (cryptConfig.prefix && normalizedPath.startsWith(cryptConfig.prefix)) {
    return true;
  }
  if (Array.isArray(cryptConfig.includes)) {
    for (const entry of cryptConfig.includes) {
      if (entry && normalizedPath.includes(entry)) {
        return true;
      }
    }
  }
  return false;
};

const extractActionTokens = (action) => new Set(
  typeof action === 'string'
    ? action
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
    : []
);

const parseClientBehavior = (action) => {
  const tokens = extractActionTokens(action);
  return {
    forceWebDownloader: tokens.has('verify-web-download') || tokens.has('pass-web-download'),
    forceClientDecrypt: tokens.has('verify-decrypt') || tokens.has('pass-decrypt'),
  };
};

const normalizeLandingCaptchaCombo = (landingDecision) => {
  const rawCombo = landingDecision && Array.isArray(landingDecision.captchaCombo) ? landingDecision.captchaCombo : [];
  const normalized = [];
  const seen = new Set();
  for (const entry of rawCombo) {
    const token = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!token) {
      continue;
    }
    if (!VALID_ACTIONS_SET.has(token)) {
      console.warn(`[controller] unsupported captchaCombo token '${entry}' ignored`);
      continue;
    }
    if (!seen.has(token)) {
      normalized.push(token);
      seen.add(token);
    }
  }
  if (normalized.length === 0) {
    normalized.push('verify-altcha');
  }
  return normalized;
};

const buildLandingDecisionContext = (landingDecision, config) => {
  if (!landingDecision) {
    return null;
  }

  const normalizedActions = normalizeLandingCaptchaCombo(landingDecision);
  const actionString = normalizedActions.join(',');
  const actionTokens = extractActionTokens(actionString);
  const parsedNeeds = parseVerificationNeeds(actionString, config);
  const behavior = parseClientBehavior(actionString);

  const forceWeb = actionTokens.has('pass-web');
  const forceRedirect = actionTokens.has('pass-server');
  const fastRedirect = typeof landingDecision.fastRedirect === 'boolean'
    ? landingDecision.fastRedirect
    : false;
  const autoRedirect = typeof landingDecision.autoRedirect === 'boolean'
    ? landingDecision.autoRedirect
    : false;
  const blockReason = landingDecision.blockReason
    ? String(landingDecision.blockReason)
    : (actionTokens.has('block') ? 'access denied' : null);

  return {
    actionString,
    actionTokens,
    parsedNeeds,
    forceWebDownloader: behavior.forceWebDownloader,
    forceClientDecrypt: behavior.forceClientDecrypt,
    forceWeb,
    forceRedirect,
    fastRedirect,
    autoRedirect,
    blockReason,
  };
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

  if (config.enableCfRatelimiter) {
    try {
      const cfResult = await checkCfRatelimit(
        env,
        clientIP,
        config.ipv4Suffix,
        config.ipv6Suffix,
        config.cfRatelimiterBinding
      );

      if (!cfResult.allowed) {
        console.error(`[CF Rate Limiter] Blocked IP subnet: ${cfResult.ipSubnet}`);
        const response = respondJson(origin, { code: 429, message: 'rate limited' }, 429);
        response.headers.set('Retry-After', '60');
        return response;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[CF Rate Limiter] Error during check (info):', message);
      // fail-open
    }
  }

  const rawTurnstileToken =
    request.headers.get(TURNSTILE_HEADER) ||
    request.headers.get('x-turnstile-token') ||
    url.searchParams.get(TURNSTILE_HEADER) ||
    url.searchParams.get('turnstile_token') ||
    '';
  const rawTurnstileBinding =
    request.headers.get(TURNSTILE_BINDING_HEADER) ||
    url.searchParams.get(TURNSTILE_BINDING_QUERY) ||
    '';
  let turnstileBindingPayload = null;
  if (rawTurnstileBinding) {
    try {
      const decodedBinding = base64urlDecode(rawTurnstileBinding);
      turnstileBindingPayload = JSON.parse(decodedBinding);
    } catch (error) {
      console.error('[Turnstile Binding] Failed to decode binding payload:', error instanceof Error ? error.message : String(error));
      return respondJson(origin, { code: 400, message: 'invalid turnstile binding format' }, 400);
    }
  }
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
  const powdetSolutionParam = url.searchParams.get('powdetSolution') || '';
  let powdetSolution = null;
  if (powdetSolutionParam) {
    try {
      const decoded = base64urlDecode(powdetSolutionParam);
      powdetSolution = JSON.parse(decoded);
    } catch (error) {
      console.error('[Powdet] Failed to decode powdetSolution:', error instanceof Error ? error.message : String(error));
      return respondJson(origin, { code: 400, message: 'invalid powdetSolution format' }, 400);
    }
  }

  // Check blacklist/whitelist
  const landingDecision = ctx?.controllerState?.decision?.landing;
  const landingCtx = buildLandingDecisionContext(landingDecision, config);
  if (!landingCtx) {
    return respondJson(origin, { code: 503, message: 'controller decision unavailable' }, 503);
  }
  if (landingCtx.blockReason) {
    return respondJson(origin, { code: 403, message: landingCtx.blockReason }, 403);
  }

  const actionTokens = landingCtx.actionTokens;
  const parsedNeeds = landingCtx.parsedNeeds;

  const forceWebDownloader = landingCtx.forceWebDownloader;
  const forceClientDecrypt = landingCtx.forceClientDecrypt;
  const forceWeb = landingCtx.forceWeb;
  const forceRedirect = landingCtx.forceRedirect;
  const isCrypt = isCryptPath(decodedPath, config.crypt);
  let derivedFileName = '';
  if (decodedPath && decodedPath !== '/') {
    const segments = decodedPath.split('/').filter((entry) => entry.length > 0);
    if (segments.length > 0) {
      derivedFileName = segments[segments.length - 1];
    }
  }

  let needAltcha = parsedNeeds.needAltcha;
  let needTurnstile = parsedNeeds.needTurnstile;
  let needPowdet = parsedNeeds.needPowdet;

  let altchaScope = clientIP
    ? await computeAltchaIpScope(clientIP, config.ipv4Suffix, config.ipv6Suffix)
    : null;
  if (needAltcha && config.altchaDynamicEnabled && altchaScope?.ipHash) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const state = await fetchAltchaDifficultyState(config, env, altchaScope.ipHash);
    const difficultyResult = getAltchaDifficultyForClient(state, nowSeconds, config.altchaDynamic);
    if (difficultyResult.blocked) {
      return respondAltchaBlocked(origin, difficultyResult.retryAfterSeconds);
    }
  }

  let powdetScope = null;
  if (needPowdet && clientIP) {
    powdetScope = altchaScope || (await computeAltchaIpScope(clientIP, config.ipv4Suffix, config.ipv6Suffix));
  }
  if (needPowdet && config.powdetDynamic && powdetScope?.ipHash) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const powState = await fetchPowdetDifficultyState(config, env, powdetScope.ipHash);
    const powDifficulty = getPowdetDifficultyForClient(powState, nowSeconds, config.powdetDynamic);
    if (powDifficulty.blocked) {
      return respondJson(origin, { code: 429, message: 'powdet blocked', retryAfter: powDifficulty.retryAfterSeconds }, 429);
    }
  }

  const hasDbMode = config.dbMode === 'custom-pg-rest';
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

  let shouldBindToken = Boolean(
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
  let expectedTurnstileCData = '';
  let payloadTurnstileNonce = '';
  let powdetChallengeHash = null;
  let powdetExpireAt = null;
  if (needTurnstile && config.turnstileCookieExpireSeconds > 0) {
    if (!turnstileBindingPayload) {
      return respondJson(origin, { code: 463, message: 'turnstile binding required' }, 403);
    }
    const payloadPathHash = typeof turnstileBindingPayload.pathHash === 'string' ? turnstileBindingPayload.pathHash : '';
    const payloadIpHash = typeof turnstileBindingPayload.ipHash === 'string' ? turnstileBindingPayload.ipHash : '';
    const payloadBindingMac = typeof turnstileBindingPayload.binding === 'string'
      ? turnstileBindingPayload.binding
      : typeof turnstileBindingPayload.bindingMac === 'string'
        ? turnstileBindingPayload.bindingMac
        : '';
    const rawBindingExpires = turnstileBindingPayload.bindingExpiresAt ?? turnstileBindingPayload.expiresAt;
    const payloadBindingExpiresAt = Number.isFinite(rawBindingExpires)
      ? Math.floor(rawBindingExpires)
      : Number.parseInt(rawBindingExpires, 10);
    payloadTurnstileNonce = typeof turnstileBindingPayload.nonce === 'string'
      ? turnstileBindingPayload.nonce.replace(/=+$/u, '')
      : '';
    const payloadBindingCDataRaw = typeof turnstileBindingPayload.cdata === 'string'
      ? turnstileBindingPayload.cdata
      : '';
    const payloadBindingCData = payloadBindingCDataRaw.replace(/=+$/u, '');
    if (!payloadPathHash || !payloadBindingMac || !Number.isFinite(payloadBindingExpiresAt) || payloadBindingExpiresAt <= 0) {
      return respondJson(origin, { code: 463, message: 'turnstile binding missing' }, 403);
    }
    if (!payloadTurnstileNonce) {
      return respondJson(origin, { code: 463, message: 'turnstile binding missing nonce' }, 403);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(payloadTurnstileNonce)) {
      return respondJson(origin, { code: 463, message: 'turnstile binding nonce invalid' }, 403);
    }
    const expectedPathHash = typeof filepathHash === 'string' ? filepathHash : '';
    const expectedIpHash = await computeClientIpHash(clientIP);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payloadBindingExpiresAt < nowSeconds) {
      return respondJson(origin, { code: 463, message: 'turnstile binding expired' }, 403);
    }
    const expectedBinding = await buildBindingPayload(
      config.pageSecret,
      expectedPathHash,
      expectedIpHash,
      payloadBindingExpiresAt,
      'Turnstile'
    );
    const mismatch =
      payloadPathHash !== expectedBinding.pathHash ||
      payloadIpHash !== expectedBinding.ipHash ||
      payloadBindingMac !== expectedBinding.bindingMac ||
      payloadBindingExpiresAt !== expectedBinding.expiresAt;
    if (mismatch) {
      return respondJson(origin, { code: 463, message: 'turnstile binding mismatch' }, 403);
    }
    expectedTurnstileCData = await buildTurnstileCData(
      config.pageSecret,
      expectedBinding.bindingMac,
      payloadTurnstileNonce
    );
    if (!expectedTurnstileCData) {
      return respondJson(origin, { code: 500, message: 'turnstile binding cdata unavailable' }, 500);
    }
    if (!payloadBindingCData) {
      return respondJson(origin, { code: 463, message: 'turnstile binding missing cdata' }, 403);
    }
    if (payloadBindingCData !== expectedTurnstileCData) {
      return respondJson(origin, { code: 463, message: 'turnstile binding mismatch' }, 403);
    }
  }

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

      const payloadPathHash = typeof altchaPayload.pathHash === 'string' ? altchaPayload.pathHash : '';
      const payloadIpHash = typeof altchaPayload.ipHash === 'string' ? altchaPayload.ipHash : '';
      const payloadBindingMac = typeof altchaPayload.binding === 'string' ? altchaPayload.binding : '';
      const payloadBindingExpireRaw = altchaPayload.bindingExpiresAt;
      const payloadBindingExpiresAt = Number.isFinite(payloadBindingExpireRaw)
        ? Math.floor(payloadBindingExpireRaw)
        : Number.parseInt(payloadBindingExpireRaw, 10);
      const payloadSalt = typeof altchaPayload.salt === 'string' ? altchaPayload.salt : '';
      if (!payloadSalt) {
        return respondJson(origin, { code: 403, message: 'ALTCHA binding missing salt' }, 403);
      }
      if (!payloadPathHash || !payloadBindingMac || !Number.isFinite(payloadBindingExpiresAt) || payloadBindingExpiresAt <= 0) {
        return respondJson(origin, { code: 403, message: 'ALTCHA binding missing' }, 403);
      }

      const pathHashDetails = parseAltchaPathBindingValue(payloadPathHash);
      if (!pathHashDetails) {
        return respondJson(origin, { code: 463, message: 'ALTCHA binding path invalid' }, 403);
      }
      if (pathHashDetails.canonicalValue !== payloadPathHash) {
        return respondJson(origin, { code: 463, message: 'ALTCHA binding path tampered' }, 403);
      }
      const expectedPathHash = typeof filepathHash === 'string' ? filepathHash : '';
      const expectedIpHash = await computeClientIpHash(clientIP);
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (payloadBindingExpiresAt < nowSeconds) {
        return respondJson(origin, { code: 463, message: 'ALTCHA binding expired' }, 403);
      }
      if (!expectedPathHash || pathHashDetails.pathHash !== expectedPathHash) {
        return respondJson(origin, { code: 463, message: 'ALTCHA binding path mismatch' }, 403);
      }
      const expectedScopeHash = altchaScope?.ipHash || '';
      if (pathHashDetails.scopeHash !== expectedScopeHash) {
        return respondJson(origin, { code: 463, message: 'ALTCHA binding scope mismatch' }, 403);
      }
      const canonicalPathHash = pathHashDetails.canonicalValue;
      const expectedBinding = await buildAltchaBinding(
        config.pageSecret,
        canonicalPathHash,
        expectedIpHash,
        payloadBindingExpiresAt,
        payloadSalt
      );
      const bindingMismatch =
        canonicalPathHash !== expectedBinding.pathHash ||
        payloadIpHash !== expectedBinding.ipHash ||
        payloadBindingMac !== expectedBinding.bindingMac ||
        payloadBindingExpiresAt !== expectedBinding.expiresAt;
      if (bindingMismatch) {
        return respondJson(origin, { code: 463, message: 'ALTCHA binding mismatch' }, 403);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return respondJson(origin, { code: 403, message: `ALTCHA error: ${message}` }, 403);
    }
  }

  if (needPowdet) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const clockSkew = Number.isFinite(config.powdetClockSkewSeconds) ? config.powdetClockSkewSeconds : 60;
    const maxWindow = Number.isFinite(config.powdetMaxWindowSeconds) ? config.powdetMaxWindowSeconds : 600;

    const payloadChallenge = typeof powdetSolution?.challenge === 'string' ? powdetSolution.challenge : '';
    const payloadNonce = typeof powdetSolution?.nonce === 'string' ? powdetSolution.nonce : '';
    const payloadRandom = typeof powdetSolution?.randomStr === 'string' ? powdetSolution.randomStr : '';
    const payloadHmac = typeof powdetSolution?.hmac === 'string' ? powdetSolution.hmac : '';
    const rawExpire = powdetSolution?.expireAt ?? powdetSolution?.expiresAt;
    const payloadExpireAt = Number.isFinite(rawExpire) ? Math.floor(rawExpire) : Number.parseInt(rawExpire, 10);

    if (!payloadChallenge || !payloadNonce || !payloadRandom || !payloadHmac || !Number.isFinite(payloadExpireAt)) {
      return respondJson(origin, { code: 403, message: 'powdet payload missing' }, 403);
    }
    if (payloadExpireAt + clockSkew < nowSeconds) {
      return respondJson(origin, { code: 463, message: 'powdet challenge expired' }, 403);
    }
    if (payloadExpireAt - nowSeconds > maxWindow) {
      return respondJson(origin, { code: 463, message: 'powdet expire window invalid' }, 403);
    }

    const expectedPathHash = typeof filepathHash === 'string' ? filepathHash : '';
    const expectedIpRangeHash = powdetScope?.ipRange ? await sha256Hash(powdetScope.ipRange) : '';
    if (!expectedPathHash || !expectedIpRangeHash) {
      return respondJson(origin, { code: 403, message: 'powdet binding context missing' }, 403);
    }

    let expectedHmac = '';
    try {
      const bindingPayload = {
        ipRangeHash: expectedIpRangeHash,
        pathHash: expectedPathHash,
        expireAt: payloadExpireAt,
        randomStr: payloadRandom,
        challenge: payloadChallenge,
      };
      expectedHmac = await computePowdetHmac(config, bindingPayload);
    } catch (error) {
      console.error('[Powdet] Failed to compute HMAC:', error instanceof Error ? error.message : String(error));
      return respondJson(origin, { code: 500, message: 'powdet verification unavailable' }, 500);
    }

    if (!timingSafeEqualHex(payloadHmac, expectedHmac)) {
      return respondJson(origin, { code: 463, message: 'powdet binding mismatch' }, 403);
    }

    const powVerify = await verifyPowdet(config, payloadChallenge, payloadNonce);
    if (!powVerify.ok) {
      const message = powVerify.message || 'powdet verification failed';
      return respondJson(origin, { code: 463, message }, 403);
    }

    powdetExpireAt = payloadExpireAt;
    try {
      powdetChallengeHash = await sha256Hash(payloadChallenge);
    } catch (error) {
      console.error('[Powdet] Failed to hash challenge:', error instanceof Error ? error.message : String(error));
      if (hasDbMode) {
        return respondJson(origin, { code: 500, message: 'powdet hashing failed' }, 500);
      }
    }
  }

  if (needAltcha && altchaPayload) {
    try {
      const challengeFingerprint = `${altchaPayload.algorithm}:${altchaPayload.challenge}:${altchaPayload.salt}`;
      altchaTokenHash = await sha256Hash(challengeFingerprint);
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
    if (expectedTurnstileCData) {
      const responseCData = typeof verification.cdata === 'string'
        ? verification.cdata.replace(/=+$/u, '')
        : '';
      if (!responseCData || responseCData !== expectedTurnstileCData) {
        return respondJson(origin, { code: 463, message: 'turnstile cdata mismatch' }, 403);
      }
    }
    if (config.turnstileEnforceAction) {
      const action = typeof verification.action === 'string' ? verification.action : '';
      if (action !== config.turnstileExpectedAction) {
        return respondJson(origin, { code: 463, message: 'turnstile action mismatch' }, 403);
      }
    }
    if (config.turnstileEnforceHostname) {
      const hostname = typeof verification.hostname === 'string' ? verification.hostname.toLowerCase().trim() : '';
      if (!hostname || !config.turnstileAllowedHostnamesSet.has(hostname)) {
        return respondJson(origin, { code: 463, message: 'turnstile hostname mismatch' }, 403);
      }
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

  const hasCacheSupport = Boolean(cacheManager && config.cacheEnabled);
  const requiresAltchaStateful = Boolean(needAltcha && altchaTokenHash && hasDbMode);
  const requiresPowdetStateful = Boolean(needPowdet && powdetChallengeHash && hasDbMode);
  const unifiedEligible = Boolean(
    (config.rateLimitEnabled && hasDbMode) ||
    shouldBindToken ||
    requiresAltchaStateful ||
    requiresPowdetStateful
  );
  const canUseUnified = Boolean(unifiedEligible && hasDbMode && clientIP);

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
  if (requiresPowdetStateful && !canUseUnified) {
    console.error('[Powdet] Challenge validation enabled but unified check is unavailable');
    return respondJson(origin, { code: 500, message: 'powdet validation unavailable' }, 500);
  }

  let unifiedResult = null;
  let cacheHit = false;
  let sizeBytes = 0;
  let fileInfo = null;

  if (canUseUnified) {
    try {
      const limitValue = config.rateLimitConfig?.limit ?? config.ipSubnetLimit;
      const powTableName = config.powdetTableName || POWDET_DEFAULT_TABLE;

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
          fileLimit: config.fileLimit,
          fileWindowTimeSeconds: config.fileWindowTimeSeconds,
          fileBlockTimeSeconds: config.fileBlockTimeSeconds,
          fileRateLimitTableName: config.rateLimitConfig.fileTableName || 'IP_FILE_LIMIT_TABLE',
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
          powdetChallengeHash,
          powdetTableName: powTableName,
          powdetExpireAt,
        };
        unifiedResult = await unifiedCheck(decodedPath, clientIP, config.altchaTableName, unifiedConfig);
      } else {
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
              3: 'ALTCHA challenge already solved',
              4: 'ALTCHA token filepath mismatch',
            };
            const message = altchaErrorMessages[altchaResult.errorCode] || 'ALTCHA token validation failed';
            console.warn('[ALTCHA] Token rejected:', message);
            return respondJson(origin, { code: 463, message }, 403);
          }
        }

        const rateLimitResponse = maybeRespondRateLimit(
          origin,
          clientIP,
          decodedPath,
          config,
          unifiedResult.rateLimit
        );
        if (rateLimitResponse) {
          return rateLimitResponse;
        }

        if (unifiedResult.cache.hit && Number.isFinite(unifiedResult.cache.size)) {
          sizeBytes = Number(unifiedResult.cache.size);
          cacheHit = true;
        }

        if (needPowdet) {
          const powResult = unifiedResult.powdet;
          if (!powResult || powResult.consumed === false) {
            return respondJson(origin, { code: 463, message: 'powdet challenge reused' }, 403);
          }
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
        console.warn('[Unified Check] Token binding DB unavailable, falling back to stateless protection');
        tokenBindingAllowed = true;
        shouldBindToken = false;
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
    const verification = await verifyTurnstileToken(
      config.turnstileSecretKey,
      rawTurnstileToken,
      clientIP
    );
    if (!verification.ok) {
      console.error('[Turnstile] Stateless verification failed:', verification.message);
      return respondJson(origin, {
        code: 462,
        message: verification.message || 'turnstile verification failed'
      }, 403);
    }
    if (expectedTurnstileCData) {
      const responseCData = typeof verification.cdata === 'string'
        ? verification.cdata.replace(/=+$/u, '')
        : '';
      if (!responseCData || responseCData !== expectedTurnstileCData) {
        console.error('[Turnstile] Stateless verification cdata mismatch');
        return respondJson(origin, { code: 463, message: 'turnstile cdata mismatch' }, 403);
      }
    }
    if (config.turnstileEnforceAction) {
      const action = typeof verification.action === 'string' ? verification.action : '';
      if (action !== config.turnstileExpectedAction) {
        console.error('[Turnstile] Stateless verification action mismatch:', action);
        return respondJson(origin, { code: 463, message: 'turnstile action mismatch' }, 403);
      }
    }
    if (config.turnstileEnforceHostname) {
      const hostname = typeof verification.hostname === 'string' ? verification.hostname.toLowerCase().trim() : '';
      if (!hostname || !config.turnstileAllowedHostnamesSet.has(hostname)) {
        console.error('[Turnstile] Stateless verification hostname mismatch:', hostname);
        return respondJson(origin, { code: 463, message: 'turnstile hostname mismatch' }, 403);
      }
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
      const rateLimitResult = await rateLimiter.checkRateLimit(clientIP, decodedPath, { ...config.rateLimitConfig, ctx });

      if (rateLimitResult.error) {
        return respondJson(origin, { code: 500, message: rateLimitResult.error }, 500);
      }

      const rateLimitResponse = maybeRespondRateLimit(origin, clientIP, decodedPath, config, rateLimitResult);
      if (rateLimitResponse) {
        return rateLimitResponse;
      }
    }

    if (!cacheHit && cacheManager && cacheConfigWithCtx) {
      try {
        const cached = await cacheManager.checkCache(decodedPath, cacheConfigWithCtx);
        if (cached && Number.isFinite(cached.size)) {
          sizeBytes = Number(cached.size);
          cacheHit = true;
        }
      } catch (error) {
        console.error('[Filesize Cache] Standalone cache check failed:', error instanceof Error ? error.message : String(error));
      }
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
      ctx.waitUntil(
        cacheManager
          .saveCache(decodedPath, sizeBytes, cacheConfigWithCtx)
          .catch((error) => {
            console.error('[Filesize Cache] Save failed:', error instanceof Error ? error.message : String(error));
          })
      );
    }
  }

  const expireTime = calculateExpireTimestamp(
    sizeBytes,
    config.minDurationSeconds,
    config.minBandwidthBytesPerSecond,
    config.maxDurationSeconds
  );
  let downloadURL = await createDownloadURL(config, request, {
    encodedPath,
    decodedPath,
    sign,
    clientIP,
    sizeBytes,
    expireTime,
    fileInfo,
    isCrypt,
  }, ctx);

  const needWebDownloader =
    config.webDownloaderEnabled && (isCrypt || forceWebDownloader);
  const clientDecryptEligible = config.clientDecryptEnabled && isCrypt;
  const needClientDecrypt =
    clientDecryptEligible && (isCrypt || forceClientDecrypt);

  const responsePayload = {
    code: 200,
    data: {
      download: {
        url: downloadURL,
      },
      meta: {
        path: decodedPath,
        fileName: derivedFileName,
        size: Number.isFinite(sizeBytes) ? sizeBytes : null,
      },
      settings: {
        underAttack: needTurnstile,
      },
    },
  };
  if (needWebDownloader || needClientDecrypt) {
    const encryptionMode = isCrypt ? (config.crypt?.encryptionMode || 'crypt') : 'plain';
    const fileHeaderSize = isCrypt ? config.crypt?.fileHeaderSize || 0 : 0;
    const blockHeaderSize = isCrypt ? config.crypt?.blockHeaderSize || 0 : 0;
    const blockDataSize = isCrypt ? config.crypt?.blockDataSize || 0 : 0;
    const dataKeyBase64 = isCrypt ? config.crypt?.dataKeyBase64 || '' : '';
    const length = Number.isFinite(sizeBytes) ? sizeBytes : null;
    let urlBase64 = '';
    try {
      urlBase64 = btoa(downloadURL);
    } catch (error) {
      urlBase64 = '';
    }
    responsePayload.data.download.remote = {
      url: downloadURL,
      method: 'GET',
      headers: {},
      length,
      ...(needWebDownloader
        ? { concurrency: config.webDownloaderMaxConnections }
        : {}),
    };
    responsePayload.data.download.urlBase64 = urlBase64;
    responsePayload.data.download.meta = {
      encryption: encryptionMode,
      fileHeaderSize,
      blockHeaderSize,
      blockDataSize,
      dataKey: dataKeyBase64,
    };
    responsePayload.data.meta.isCrypt = isCrypt;
  }
  if (needWebDownloader) {
    responsePayload.data.download.settings = {
      webDownloader: true,
      maxConnections: config.webDownloaderMaxConnections,
    };
    responsePayload.data.settings.webDownloader = true;
  }
  if (needClientDecrypt) {
    const downloadMeta = responsePayload.data.download.meta || {};
    responsePayload.data.decrypt = {
      enabled: true,
      encryption: downloadMeta.encryption || 'plain',
      fileHeaderSize: downloadMeta.fileHeaderSize || 0,
      blockHeaderSize: downloadMeta.blockHeaderSize || 0,
      blockDataSize: downloadMeta.blockDataSize || 0,
      dataKey: downloadMeta.dataKey || '',
      length: Number.isFinite(sizeBytes) ? sizeBytes : null,
      path: decodedPath,
      fileName: derivedFileName,
    };
    responsePayload.data.settings.clientDecrypt = true;
  }
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

  } catch (error) {
    console.error('[ALTCHA Cleanup] Failed:', error instanceof Error ? error.message : String(error));
  }
}

async function cleanupAltchaDifficultyState(config, env) {
  if (!config?.altchaDynamicEnabled) {
    return;
  }
  const dbMode = getNormalizedDbMode(config);
  if (!dbMode) {
    return;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoffTime = nowSeconds - ALTCHA_DIFFICULTY_CLEANUP_MAX_AGE;
  try {
    if (dbMode === 'custom-pg-rest') {
      const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        return;
      }
      const rpcUrl = `${postgrestUrl}/rpc/landing_cleanup_altcha_difficulty_state`;
      const headers = { 'Content-Type': 'application/json' };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_before: cutoffTime,
          p_table_name: ALTCHA_DIFFICULTY_TABLE,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error('[ALTCHA Dynamic] Cleanup RPC failed:', response.status, text);
      }
      return;
    }
  } catch (error) {
    console.error('[ALTCHA Dynamic] Cleanup failed:', error instanceof Error ? error.message : String(error));
  }
}

async function cleanupExpiredPowdetTickets(config, env) {
  if (!config?.powdetEnabled) {
    return;
  }
  const dbMode = getNormalizedDbMode(config);
  if (!dbMode) {
    return;
  }
  const tableName = config.powdetTableName || POWDET_DEFAULT_TABLE;
  const nowSeconds = Math.floor(Date.now() / 1000);
  try {
    if (dbMode === 'custom-pg-rest') {
      const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        return;
      }
      const rpcUrl = `${postgrestUrl}/rpc/landing_cleanup_expired_pow_challenges`;
      const headers = { 'Content-Type': 'application/json' };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      await fetch(rpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_now: nowSeconds,
          p_table_name: tableName,
        }),
      }).catch((error) => {
        console.error('[Powdet Cleanup] PostgREST RPC failed:', error instanceof Error ? error.message : String(error));
      });
      return;
    }
  } catch (error) {
    console.error('[Powdet Cleanup] Failed:', error instanceof Error ? error.message : String(error));
  }
}

async function cleanupPowdetDifficultyState(config, env) {
  if (!config?.powdetDynamic) {
    return;
  }
  const dbMode = getNormalizedDbMode(config);
  if (!dbMode) {
    return;
  }
  const tableName = config.powdetDifficultyTableName || POWDET_DIFFICULTY_TABLE;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoffTime = nowSeconds - ALTCHA_DIFFICULTY_CLEANUP_MAX_AGE;
  try {
    if (dbMode === 'custom-pg-rest') {
      const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        return;
      }
      const rpcUrl = `${postgrestUrl}/rpc/landing_cleanup_altcha_difficulty_state`;
      const headers = { 'Content-Type': 'application/json' };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_before: cutoffTime,
          p_table_name: tableName,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error('[Powdet Dynamic] Cleanup RPC failed:', response.status, text);
      }
      return;
    }
  } catch (error) {
    console.error('[Powdet Dynamic] Cleanup failed:', error instanceof Error ? error.message : String(error));
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
    const tables = [];
    const ipWindowTimeSeconds = config.rateLimitConfig?.windowTimeSeconds || 0;
    const ipTableName = config.rateLimitConfig?.tableName || 'IP_LIMIT_TABLE';
    if (ipWindowTimeSeconds > 0) {
      tables.push({ tableName: ipTableName, windowTimeSeconds: ipWindowTimeSeconds });
    }

    const fileWindowTimeSeconds = config.rateLimitConfig?.fileWindowTimeSeconds || 0;
    const fileTableName = config.rateLimitConfig?.fileTableName || 'IP_FILE_LIMIT_TABLE';
    if (fileWindowTimeSeconds > 0) {
      tables.push({ tableName: fileTableName, windowTimeSeconds: fileWindowTimeSeconds });
    }

    if (tables.length === 0) {
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    await Promise.all(
      tables.map(({ tableName, windowTimeSeconds }) =>
        cleanupSingleRateLimitTable(config, env, tableName, windowTimeSeconds, nowSeconds)
      )
    );
  } catch (error) {
    console.error('[Rate Limit Cleanup] Failed:', error instanceof Error ? error.message : String(error));
  }
}

async function cleanupSingleRateLimitTable(config, env, tableName, windowTimeSeconds, nowSeconds) {
  if (!windowTimeSeconds || windowTimeSeconds <= 0) {
    return;
  }

  const cutoffTime = nowSeconds - (windowTimeSeconds * 2);

  if (config.dbMode === 'custom-pg-rest') {
    const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
    if (!postgrestUrl) {
      console.error('[Rate Limit Cleanup] PostgREST URL missing');
      return;
    }

    let rpcFunctionName;
    if (tableName === 'IP_LIMIT_TABLE' || tableName.includes('IP_LIMIT')) {
      rpcFunctionName = 'landing_cleanup_expired_rate_limits';
    } else if (tableName === 'IP_FILE_LIMIT_TABLE' || tableName.includes('FILE_LIMIT')) {
      rpcFunctionName = 'landing_cleanup_expired_file_rate_limits';
    } else {
      rpcFunctionName = 'landing_cleanup_expired_rate_limits';
    }

    const rpcUrl = `${postgrestUrl}/rpc/${rpcFunctionName}`;
    const headers = { 'Content-Type': 'application/json' };
    applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_window_seconds: windowTimeSeconds,
        p_table_name: tableName,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('[Rate Limit Cleanup] PostgREST RPC failed:', response.status, text);
    } else {
      const result = await response.json().catch(() => null);
      if (result !== null && typeof result === 'number') {
        console.log('[Rate Limit Cleanup] Deleted', result, 'rows from table:', tableName);
      }
    }
    return;
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
  const hasDbMode = getNormalizedDbMode(config) === 'custom-pg-rest';
  if (!hasDbMode || config.cleanupPercentage <= 0) {
    return; // Skip if no DB configured or cleanup disabled
  }

  // Probabilistic trigger
  const shouldCleanup = Math.random() * 100 < config.cleanupPercentage;
  if (!shouldCleanup) {
    return;
  }

  // Run all cleanups in parallel (Promise.allSettled ensures one failure doesn't block others)
  const cleanupTasks = [];

  cleanupTasks.push(
    { name: 'Rate Limit', fn: () => cleanupExpiredRateLimits(config, env) },
    { name: 'Filesize Cache', fn: () => cleanupExpiredCache(config, env) },
    { name: 'ALTCHA Token', fn: () => cleanupExpiredAltchaTokens(config, env) },
    { name: 'ALTCHA Difficulty', fn: () => cleanupAltchaDifficultyState(config, env) },
    { name: 'Powdet Token', fn: () => cleanupExpiredPowdetTickets(config, env) },
    { name: 'Powdet Difficulty', fn: () => cleanupPowdetDifficultyState(config, env) },
    { name: 'Turnstile Token', fn: () => cleanupExpiredTurnstileTokens(config, env) },
  );

  if (cleanupTasks.length === 0) {
    return;
  }

  const cleanupPromise = Promise.allSettled(
    cleanupTasks.map(task =>
      task.fn().catch(error => {
        console.error(`[Cleanup Scheduler] ${task.name} failed:`, error instanceof Error ? error.message : String(error));
      })
    )
  );

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(cleanupPromise);
  } else {
    await cleanupPromise;
  }
}

const handleFileRequest = async (request, env, config, rateLimiter, ctx) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return respondJson(request.headers.get('origin') || '*', { code: 405, message: 'method not allowed' }, 405);
  }

  const origin = request.headers.get('origin') || '*';
  const clientIP = extractClientIP(request);

  const maybeEnforceCfRateLimiter = async () => {
    if (!config.enableCfRatelimiter) {
      return null;
    }
    try {
      const cfResult = await checkCfRatelimit(
        env,
        clientIP,
        config.ipv4Suffix,
        config.ipv6Suffix,
        config.cfRatelimiterBinding
      );
      if (!cfResult.allowed) {
        console.error(`[CF Rate Limiter] Blocked IP subnet: ${cfResult.ipSubnet}`);
        const headers = safeHeaders(origin);
        headers.set('content-type', 'text/plain');
        headers.set('Retry-After', '60');
        return new Response('429 Too Many Requests - Rate limit exceeded', {
          status: 429,
          headers,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[CF Rate Limiter] Error during check:', message);
      // fail-open
    }
    return null;
  };

  // Unified cleanup scheduler (handles all tables)
  await scheduleAllCleanups(config, env, ctx);

  if (request.method === 'HEAD') {
    const cfResponse = await maybeEnforceCfRateLimiter();
    if (cfResponse) {
      return cfResponse;
    }
    return new Response(null, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=UTF-8',
        'cache-control': 'no-store',
      },
    });
  }

  const url = new URL(request.url);
  const encodedPath = url.pathname;
  const sign = url.searchParams.get('sign') || '';

  // Check blacklist/whitelist
  const landingDecision = ctx?.controllerState?.decision?.landing;
  const landingCtx = buildLandingDecisionContext(landingDecision, config);
  if (!landingCtx) {
    return respondJson(request.headers.get('origin') || '*', { code: 503, message: 'controller decision unavailable' }, 503);
  }
  if (landingCtx.blockReason) {
    return respondJson(request.headers.get('origin') || '*', { code: 403, message: landingCtx.blockReason }, 403);
  }

  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch (error) {
    return respondJson(origin, { code: 400, message: 'invalid path encoding' }, 400);
  }

  const actionTokens = landingCtx.actionTokens;
  const parsedNeeds = landingCtx.parsedNeeds;
  const { forceWebDownloader, forceClientDecrypt } = landingCtx;
  const isCrypt = isCryptPath(decodedPath, config.crypt);

  // Determine behavior based on action
  const forceWeb = landingCtx.forceWeb;
  const forceRedirect = landingCtx.forceRedirect;

  let needAltcha = parsedNeeds.needAltcha;
  let needTurnstile = parsedNeeds.needTurnstile;
  let needPowdet = parsedNeeds.needPowdet;

  const needsVerification = needAltcha || needTurnstile || needPowdet;
  const needWebDownloader =
    config.webDownloaderEnabled && (isCrypt || forceWebDownloader);
  const needClientDecrypt =
    config.clientDecryptEnabled && (isCrypt || forceClientDecrypt);

  const fastRedirectCandidate =
    !needWebDownloader && !needClientDecrypt &&
    (forceRedirect || (landingCtx.fastRedirect && !forceWeb && !needsVerification));
  const shouldRedirect = fastRedirectCandidate;

  const verifyResult = await verifySignature(config.signSecret, decodedPath, sign);
  if (verifyResult) {
    return respondJson(origin, { code: 401, message: verifyResult }, 401);
  }

  const cfRateLimitResponse = await maybeEnforceCfRateLimiter();
  if (cfRateLimitResponse) {
    return cfRateLimitResponse;
  }

  // Fast redirect logic
  if (shouldRedirect) {
    const cacheManager = config.cacheEnabled ? createCacheManager(config.dbMode) : null;
    const cacheConfigWithCtx = cacheManager && config.cacheEnabled
      ? { ...config.cacheConfig, ctx }
      : null;

    const canUseUnified = Boolean(
      cacheManager &&
      config.cacheEnabled &&
      config.rateLimitEnabled &&
      config.dbMode &&
      clientIP
    );

    let unifiedResult = null;
    let cacheHit = false;
    let sizeBytes = 0;
    let fileInfo = null;

    if (canUseUnified) {
      try {
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
            fileLimit: config.fileLimit,
            fileWindowTimeSeconds: config.fileWindowTimeSeconds,
            fileBlockTimeSeconds: config.fileBlockTimeSeconds,
            fileRateLimitTableName: config.rateLimitConfig.fileTableName || 'IP_FILE_LIMIT_TABLE',
            ipv4Suffix: config.rateLimitConfig.ipv4Suffix,
            ipv6Suffix: config.rateLimitConfig.ipv6Suffix,
          };
          unifiedResult = await unifiedCheck(decodedPath, clientIP, config.altchaTableName, unifiedConfig);
        } else {
          unifiedResult = null;
        }

        if (unifiedResult) {
          const rateLimitResponse = maybeRespondRateLimit(
            origin,
            clientIP,
            decodedPath,
            config,
            unifiedResult.rateLimit
          );
          if (rateLimitResponse) {
            return rateLimitResponse;
          }

          if (unifiedResult.cache.hit && Number.isFinite(unifiedResult.cache.size)) {
            sizeBytes = Number(unifiedResult.cache.size);
            cacheHit = true;
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
        const rateLimitResult = await rateLimiter.checkRateLimit(clientIP, decodedPath, { ...config.rateLimitConfig, ctx });

        if (rateLimitResult.error) {
          return respondJson(origin, { code: 500, message: rateLimitResult.error }, 500);
        }

        const rateLimitResponse = maybeRespondRateLimit(origin, clientIP, decodedPath, config, rateLimitResult);
        if (rateLimitResponse) {
          return rateLimitResponse;
        }
      }

      if (!cacheHit && cacheManager && cacheConfigWithCtx) {
        try {
          const cached = await cacheManager.checkCache(decodedPath, cacheConfigWithCtx);
          if (cached && Number.isFinite(cached.size)) {
            sizeBytes = Number(cached.size);
            cacheHit = true;
          }
        } catch (error) {
          console.error('[Fast Redirect][Filesize Cache] Standalone cache check failed:', error instanceof Error ? error.message : String(error));
        }
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
        ctx.waitUntil(
          cacheManager
            .saveCache(decodedPath, sizeBytes, cacheConfigWithCtx)
            .catch((error) => {
              console.error('[Fast Redirect][Filesize Cache] Save failed:', error instanceof Error ? error.message : String(error));
            })
        );
      }
    }

    const expireTime = calculateExpireTimestamp(
      sizeBytes,
      config.minDurationSeconds,
      config.minBandwidthBytesPerSecond,
      config.maxDurationSeconds
    );

    const downloadURL = await createDownloadURL(config, request, {
      encodedPath,
      decodedPath,
      sign,
      clientIP,
      sizeBytes,
      expireTime,
      fileInfo,
      isCrypt,
    }, ctx);

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
  let turnstileBindingPayload = null;
  let powdetChallengePayload = null;
  let powdetStaticBase = '/powdet/static';
  const needsAltchaChallenge = needAltcha;
  const needsTurnstileBinding = needTurnstile && config.turnstileCookieExpireSeconds > 0;
  const needsPowdetChallenge = needPowdet;
  const shouldGenerateBindings = !shouldRedirect && (needsAltchaChallenge || needsTurnstileBinding || needsPowdetChallenge);
  let decodedChallengePath = '';
  if (shouldGenerateBindings) {
    decodedChallengePath = decodedPath;
  }

  let altchaScopeForChallenge = null;
  if (!shouldRedirect && needsAltchaChallenge && clientIP) {
    altchaScopeForChallenge = await computeAltchaIpScope(clientIP, config.ipv4Suffix, config.ipv6Suffix);
  }
  let powdetScopeForChallenge = null;
  if (!shouldRedirect && needsPowdetChallenge && clientIP) {
    powdetScopeForChallenge =
      altchaScopeForChallenge || (await computeAltchaIpScope(clientIP, config.ipv4Suffix, config.ipv6Suffix));
  }

  let altchaChallengeDifficulty = pickAltchaBaseDifficulty(config.altchaDifficultyRange);
  let altchaEffectiveExponent = 0;
  if (!shouldRedirect && needsAltchaChallenge) {
    if (config.altchaDynamicEnabled && config.dbMode && altchaScopeForChallenge?.ipHash) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const state = await fetchAltchaDifficultyState(config, env, altchaScopeForChallenge.ipHash);
      const difficultyResult = getAltchaDifficultyForClient(state, nowSeconds, config.altchaDynamic);
      if (difficultyResult.blocked) {
        return respondAltchaBlocked(origin, difficultyResult.retryAfterSeconds);
      }
      altchaChallengeDifficulty = difficultyResult.difficulty;
      altchaEffectiveExponent = difficultyResult.effectiveExponent ?? 0;

      if (altchaScopeForChallenge.ipRange) {
        try {
          await updateAltchaDifficultyState(config, env, altchaScopeForChallenge, nowSeconds);
        } catch (error) {
          console.error(
            '[ALTCHA Dynamic] Difficulty update failed in handleFileRequest:',
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    } else {
      altchaChallengeDifficulty = pickAltchaBaseDifficulty(config.altchaDifficultyRange);
      altchaEffectiveExponent = 0;
    }
  }
  let altchaChallengeAlgorithm = ALTCHA_DEFAULT_ALGORITHM;
  if (!shouldRedirect && needsAltchaChallenge) {
    altchaChallengeAlgorithm = pickAltchaAlgorithm(altchaEffectiveExponent, config.altchaDynamic);
  }

  let powdetDifficultyLevel = Number.isFinite(config.powdetStaticLevel) ? config.powdetStaticLevel : 12;
  if (!shouldRedirect && needsPowdetChallenge) {
    if (config.powdetDynamic && config.dbMode && powdetScopeForChallenge?.ipHash) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const powState = await fetchPowdetDifficultyState(config, env, powdetScopeForChallenge.ipHash);
      const powDifficulty = getPowdetDifficultyForClient(powState, nowSeconds, config.powdetDynamic);
      if (powDifficulty.blocked) {
        return respondJson(origin, { code: 429, message: 'powdet blocked', retryAfter: powDifficulty.retryAfterSeconds }, 429);
      }
      powdetDifficultyLevel = powDifficulty.difficultyLevel;
      if (powdetScopeForChallenge.ipRange) {
        try {
          await updatePowdetDifficultyState(config, env, powdetScopeForChallenge, nowSeconds);
        } catch (error) {
          console.error('[Powdet Dynamic] Difficulty update failed in handleFileRequest:', error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  if (!shouldRedirect && needsTurnstileBinding) {
    try {
      const bindingPathHash = decodedChallengePath ? await sha256Hash(decodedChallengePath) : '';
      const bindingIpHash = await computeClientIpHash(clientIP);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const ttlSeconds = Number.isFinite(config.turnstileCookieExpireSeconds)
        ? Math.floor(config.turnstileCookieExpireSeconds)
        : 0;
      if (ttlSeconds > 0) {
        const expiresAt = nowSeconds + ttlSeconds;
        const binding = await buildBindingPayload(
          config.pageSecret,
          bindingPathHash,
          bindingIpHash,
          expiresAt,
          'Turnstile'
        );
        if (binding?.bindingMac) {
          const nonce = generateNonce();
          const cdata = await buildTurnstileCData(config.pageSecret, binding.bindingMac, nonce);
          if (nonce && cdata) {
            turnstileBindingPayload = {
              pathHash: binding.pathHash,
              ipHash: binding.ipHash,
              binding: binding.bindingMac,
              bindingExpiresAt: binding.expiresAt,
              nonce,
              cdata,
            };
          } else {
            console.error('[Turnstile Binding] Failed to generate nonce or cData for binding');
          }
        } else {
          console.error('[Turnstile Binding] Missing binding MAC; cannot emit binding payload');
        }
      }
    } catch (error) {
      console.error('[Turnstile Binding] Failed to generate challenge binding:', error instanceof Error ? error.message : String(error));
    }
  }

  if (!shouldRedirect && needsAltchaChallenge) {
    try {
      const baseChallengePathHash = decodedChallengePath ? await sha256Hash(decodedChallengePath) : '';
      const scopeHashForBinding = altchaScopeForChallenge?.ipHash || '';
      const challengePathHash = buildAltchaPathBindingValue(
        baseChallengePathHash,
        scopeHashForBinding,
        altchaEffectiveExponent
      );
      const challengeIpHash = await computeClientIpHash(clientIP);
      const baseNowSeconds = Math.floor(Date.now() / 1000);
      const configuredTtlSeconds = Number.isFinite(config.altchaTokenExpire) && config.altchaTokenExpire > 0
        ? Math.floor(config.altchaTokenExpire)
        : 180;
      const challengeExpiresAt = baseNowSeconds + configuredTtlSeconds;
      const challenge = await createChallenge({
        hmacKey: config.pageSecret,
        maxnumber: altchaChallengeDifficulty,
        expires: new Date(challengeExpiresAt * 1000),
        algorithm: altchaChallengeAlgorithm,
      });
      const challengeBinding = await buildAltchaBinding(
        config.pageSecret,
        challengePathHash,
        challengeIpHash,
        challengeExpiresAt,
        challenge.salt
      );
      altchaChallengePayload = {
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        signature: challenge.signature,
        maxnumber: challenge.maxnumber,
        pathHash: challengeBinding.pathHash,
        ipHash: challengeBinding.ipHash,
        binding: challengeBinding.bindingMac,
        bindingExpiresAt: challengeBinding.expiresAt,
      };
    } catch (error) {
      console.error('[ALTCHA] Failed to create challenge:', error instanceof Error ? error.message : String(error));
    }
  }

  if (!shouldRedirect && needsPowdetChallenge) {
    if (config.powdetStaticBaseUrl) {
      powdetStaticBase = config.powdetStaticBaseUrl.replace(/\/+$/, '');
    } else if (config.powdetBaseUrl) {
      powdetStaticBase = `${config.powdetBaseUrl.replace(/\/+$/, '')}/powdet/static`;
    } else {
      powdetStaticBase = '/powdet/static';
    }
    try {
      const baseNowSeconds = Math.floor(Date.now() / 1000);
      const expireSeconds = Number.isFinite(config.powdetExpireSeconds) ? config.powdetExpireSeconds : 180;
      const expireAt = baseNowSeconds + expireSeconds;
      const pathHash = decodedChallengePath ? await sha256Hash(decodedChallengePath) : '';
      const ipRangeHash = powdetScopeForChallenge?.ipRange ? await sha256Hash(powdetScopeForChallenge.ipRange) : '';
      const randomStr = generateNonce(32);
      const challenge = await fetchPowdetChallenge(config, powdetDifficultyLevel);
      const bindingPayload = {
        ipRangeHash,
        pathHash,
        expireAt,
        randomStr,
        challenge,
      };
      const hmac = await computePowdetHmac(config, bindingPayload);
      powdetChallengePayload = {
        challenge,
        expireAt,
        randomStr,
        hmac,
      };
    } catch (error) {
      console.error('[Powdet] Failed to create challenge:', error instanceof Error ? error.message : String(error));
      return respondJson(origin, { code: 500, message: 'powdet challenge unavailable' }, 500);
    }
  }

  return renderLandingPage(url.pathname, {
    underAttack: needTurnstile,
    turnstileSiteKey: config.turnstileSiteKey,
    turnstileAction: config.turnstileExpectedAction,
    altchaChallenge: altchaChallengePayload,
    turnstileBinding: turnstileBindingPayload,
    powdetChallenge: powdetChallengePayload,
    powdetStaticBase,
    autoRedirect: landingCtx.autoRedirect,
    webDownloader: needWebDownloader,
    isCryptPath: isCrypt,
    webDownloaderConfig: {
      maxConnections: config.webDownloaderMaxConnections,
    },
    clientDecrypt: needClientDecrypt,
    decryptConfig: needClientDecrypt
      ? {
          encryption: isCrypt ? (config.crypt?.encryptionMode || 'crypt') : 'plain',
          fileHeaderSize: isCrypt ? config.crypt?.fileHeaderSize || 0 : 0,
          blockHeaderSize: isCrypt ? config.crypt?.blockHeaderSize || 0 : 0,
          blockDataSize: isCrypt ? config.crypt?.blockDataSize || 0 : 0,
        }
      : null,
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

export { BootstrapDO, DecisionDO, MetricsDO };

export default {
  async fetch(request, env, ctx) {
    try {
      const internalResponse = await handleInternalApiIfAny(request, env, ctx);
      if (internalResponse) {
        return internalResponse;
      }

      let controllerState = null;
      try {
        controllerState = await fetchControllerState(request, env);
      } catch (error) {
        console.error('[controller] state fetch error:', error instanceof Error ? error.message : String(error));
      }

      if (!controllerState || !controllerState.bootstrap || !controllerState.decision) {
        const origin = request.headers.get('origin') || '*';
        return respondJson(origin, { code: 503, message: 'controller state unavailable' }, 503);
      }

      const config = resolveConfig(env || {}, controllerState.bootstrap);
      // Create rate limiter instance based on DB_MODE
      const rateLimiter = config.rateLimitEnabled ? createRateLimiter(config.dbMode) : null;

      ctx.controllerState = controllerState;
      return await routeRequest(request, env, config, rateLimiter, ctx);
    } catch (error) {
      const origin = request.headers.get('origin') || '*';
      const message = error instanceof Error ? error.message : String(error);
      return respondJson(origin, { code: 500, message }, 500);
    }
  },
};
