import {
  rotLower,
  uint8ToBase64,
  parseInteger,
  parseNumber,
  parseWindowTime,
  sha256Hash,
  calculateIPSubnet,
  applyVerifyHeaders,
} from './utils.js';
import {
  buildBindingStr,
  encryptBindingPayload,
  getClientIp,
  parseCheckOriginEnv,
} from './origin-binding.js';
import { createChallenge, verifySolution } from 'altcha-lib';
import { renderLandingPage } from './frontend.js';
import { createRateLimiter } from './ratelimit/factory.js';
import { createCacheManager } from './cache/factory.js';
import { unifiedCheck } from './unified-check.js';
import { handleInternalApiIfAny } from './internal-api.js';
import { fetchControllerState } from './controller-adapter.js';

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
  'verify-powdet-argon2id',
  'verify-powdet-argon2d',
  'verify-powdet-randomx',
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
const POWDET_DEFAULT_ALGO = 'argon2id';
const POWDET_ALGO_ARGON2ID = 'argon2id';
const POWDET_ALGO_ARGON2D = 'argon2d';
const POWDET_ALGO_RANDOMX = 'randomx';
const normalizePowdetAlgorithm = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

// Unified slow-fail delay for fail-fast paths
const SLOW_FAIL_DELAY_MS = 5000;
const slowFailDelay = async () => {
  if (SLOW_FAIL_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, SLOW_FAIL_DELAY_MS));
  }
};

const nowMs = () => Date.now();

const normalizePositiveSeconds = (value, fallback = 0) => {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return num;
  const fb = Number(fallback);
  return Number.isFinite(fb) && fb > 0 ? fb : 0;
};

// Rate limit: ipSubnet -> untilMs, TTL cleanup on read
const RL_IP_RANGE_STATE = new Map();

function markIpRangeRateLimited(ipSubnet, retryAfterSeconds) {
  const key = typeof ipSubnet === 'string' ? ipSubnet.trim() : '';
  if (!key) return;
  const sec = normalizePositiveSeconds(retryAfterSeconds, 0);
  if (!sec) return;
  const until = nowMs() + sec * 1000;
  const prev = RL_IP_RANGE_STATE.get(key);
  if (!prev || until > prev.untilMs) {
    RL_IP_RANGE_STATE.set(key, { untilMs: until });
  }
}

function getIpRangeRateLimitRemaining(ipSubnet, now = nowMs()) {
  const key = typeof ipSubnet === 'string' ? ipSubnet.trim() : '';
  if (!key) return 0;
  const entry = RL_IP_RANGE_STATE.get(key);
  if (!entry || !entry.untilMs || entry.untilMs <= now) {
    if (entry && entry.untilMs && entry.untilMs <= now) {
      RL_IP_RANGE_STATE.delete(key);
    }
    return 0;
  }
  return Math.ceil((entry.untilMs - now) / 1000);
}

const createLruCache = (capacity) => ({
  capacity,
  entries: new Map(),
});

function lruGet(cache, key, now = nowMs()) {
  if (!cache || !key) return null;
  const { entries } = cache;
  if (!entries.has(key)) return null;
  const value = entries.get(key);
  if (!value || !value.untilMs || value.untilMs <= now) {
    entries.delete(key);
    return null;
  }
  entries.delete(key);
  entries.set(key, value);
  return value;
}

function lruPut(cache, key, value) {
  if (!cache || !key || !value) return;
  const { capacity, entries } = cache;
  if (entries.has(key)) {
    entries.delete(key);
    entries.set(key, value);
    return;
  }
  if (entries.size >= capacity) {
    const firstKey = entries.keys().next().value;
    if (firstKey !== undefined) {
      entries.delete(firstKey);
    }
  }
  entries.set(key, value);
}

const RL_IP_FILE_LRU = createLruCache(512); // `${ipSubnet}|${filepathHash}`
const ALTCHA_BLOCK_LRU = createLruCache(256); // ipRange
const POWDET_BLOCK_LRU = createLruCache(256); // `${alg}|${ipRange}`
const ALTCHA_TOKEN_REPLAY_LRU = createLruCache(512); // altchaTokenHash
const POWDET_REPLAY_LRU = createLruCache(512); // `${alg}|${challengeHash}`
const POWDET_VERIFY_FAIL_LRU = createLruCache(512); // `${alg}|${ipRange}|${challengeHash}` or `${alg}|${challengeHash}`

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
 * @returns {{blocked: boolean, needAltcha: boolean, needTurnstile: boolean, needPowdet: boolean, powdetAlgorithms: string[]}}
 */
function parseVerificationNeeds(action, config) {
  const defaults = {
    needAltcha: !!(config && config.altchaEnabled),
    needTurnstile: !!(config && config.underAttack),
    powdetAlgorithms: Array.isArray(config?.powdetEnabledAlgorithms)
      ? config.powdetEnabledAlgorithms.slice()
      : [],
  };

  if (!action) {
    return {
      blocked: false,
      needAltcha: defaults.needAltcha,
      needTurnstile: defaults.needTurnstile,
      needPowdet: defaults.powdetAlgorithms.length > 0,
      powdetAlgorithms: defaults.powdetAlgorithms,
    };
  }

  const normalized = String(action).trim().toLowerCase();
  if (!normalized) {
    return {
      blocked: false,
      needAltcha: defaults.needAltcha,
      needTurnstile: defaults.needTurnstile,
      needPowdet: defaults.powdetAlgorithms.length > 0,
      powdetAlgorithms: defaults.powdetAlgorithms,
    };
  }

  const tokens = new Set(
    normalized
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  );

  if (tokens.has('block')) {
    return {
      blocked: true,
      needAltcha: false,
      needTurnstile: false,
      needPowdet: false,
      powdetAlgorithms: [],
    };
  }

  let needAltcha = defaults.needAltcha;
  let needTurnstile = defaults.needTurnstile;
  let powdetAlgorithms = defaults.powdetAlgorithms.slice();

  const verifyTokens = [
    'verify-altcha',
    'verify-turn',
    'verify-powdet-argon2id',
    'verify-powdet-argon2d',
    'verify-powdet-randomx',
  ];
  const hasVerifyToken = verifyTokens.some((t) => tokens.has(t));

  if (hasVerifyToken) {
    needAltcha = false;
    needTurnstile = false;
    powdetAlgorithms = [];
  }

  if (tokens.has('verify-altcha')) {
    needAltcha = true;
  }
  if (tokens.has('verify-turn')) {
    needTurnstile = true;
  }
  if (tokens.has('verify-powdet-argon2id')) {
    powdetAlgorithms.push(POWDET_ALGO_ARGON2ID);
  }
  if (tokens.has('verify-powdet-argon2d')) {
    powdetAlgorithms.push(POWDET_ALGO_ARGON2D);
  }
  if (tokens.has('verify-powdet-randomx')) {
    powdetAlgorithms.push(POWDET_ALGO_RANDOMX);
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
    powdetAlgorithms = [];
  }

  const normalizedPowdetAlgorithms = Array.from(
    new Set(
      powdetAlgorithms
        .map((alg) => normalizePowdetAlgorithm(alg))
        .filter((alg) => alg)
    )
  );
  return {
    blocked: false,
    needAltcha,
    needTurnstile,
    needPowdet: normalizedPowdetAlgorithms.length > 0,
    powdetAlgorithms: normalizedPowdetAlgorithms,
  };
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
      throw new Error(
        `Invalid ${contextLabel} value: "verify". Please use verify-altcha, verify-turn, verify-powdet-argon2id, verify-powdet-argon2d, or verify-powdet-randomx.`
      );
    }
    if (token === 'verify-pow' || token === 'verify-both') {
      throw new Error(
        `Invalid ${contextLabel} value: "${token}". Please use verify-altcha, verify-turn, verify-powdet-argon2id, verify-powdet-argon2d, or verify-powdet-randomx.`
      );
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

const SIZE_UNIT_MULTIPLIERS = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

const parseSizeToBytes = (rawValue, fallbackBytes) => {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
    return Math.floor(rawValue);
  }
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return fallbackBytes;
    }
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i);
    if (!match) {
      return fallbackBytes;
    }
    const amount = Number.parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = SIZE_UNIT_MULTIPLIERS[unit] || 0;
    if (!Number.isFinite(amount) || amount <= 0 || multiplier <= 0) {
      return fallbackBytes;
    }
    const bytes = amount * multiplier;
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return fallbackBytes;
    }
    return Math.round(bytes);
  }
  return fallbackBytes;
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

const normalizeOrigin = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).origin;
  } catch {
    return '';
  }
};

const normalizeOriginList = (values) => {
  const normalized = [];
  const seen = new Set();
  if (!Array.isArray(values)) {
    return normalized;
  }
  for (const value of values) {
    const origin = normalizeOrigin(value);
    if (!origin || seen.has(origin)) {
      continue;
    }
    seen.add(origin);
    normalized.push(origin);
  }
  return normalized;
};

const normalizeHeaderMap = (value) => {
  const normalized = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return normalized;
  }
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) {
      continue;
    }
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const stringValue = typeof rawValue === 'string' ? rawValue : String(rawValue);
    if (!stringValue || stringValue.trim().length === 0) {
      continue;
    }
    normalized[name] = stringValue;
  }
  return normalized;
};

const resolveConfig = (env = {}, bootstrap = null) => {
  const normalizeString = (value, defaultValue = '') => {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value !== 'string') return defaultValue;
    const trimmed = value.trim();
    return trimmed === '' ? defaultValue : trimmed;
  };
  const commonBootstrap = bootstrap && typeof bootstrap === 'object'
    ? bootstrap.common || null
    : null;
  if (!commonBootstrap) {
    throw new Error('controller bootstrap.common is required');
  }
  const token = normalizeString(commonBootstrap.tokenHmacKey);
  if (!token) {
    throw new Error('controller common.tokenHmacKey is required');
  }
  const signSecretFromController = normalizeString(commonBootstrap.signSecret) || token;
  const alistAuthHeaders = normalizeHeaderMap(commonBootstrap.alistAuthHeaders);
  const bindingDefaults = {
    version: 1,
    defaultModes: 'path,asn,country,iprange',
    ipv4Suffix: '/32',
    ipv6Suffix: '/60',
    bindTls: true,
  };
  const normalizeBindingBootstrap = (bindingSource, fallback) => {
    const binding = bindingSource && typeof bindingSource === 'object'
      ? bindingSource
      : {};
    const defaultModesRaw = typeof binding.defaultModes === 'string'
      ? binding.defaultModes.trim()
      : '';
    const defaultModes = Object.prototype.hasOwnProperty.call(binding, 'defaultModes')
      ? defaultModesRaw
      : fallback.defaultModes;
    const versionRaw = Number(binding.version);
    const version = Number.isFinite(versionRaw) && versionRaw > 0
      ? Math.trunc(versionRaw)
      : fallback.version;
    const ipv4Suffix = normalizeString(binding.ipv4Suffix, fallback.ipv4Suffix) || fallback.ipv4Suffix;
    const ipv6Suffix = normalizeString(binding.ipv6Suffix, fallback.ipv6Suffix) || fallback.ipv6Suffix;
    const bindTls = Object.prototype.hasOwnProperty.call(binding, 'bindTls')
      ? binding.bindTls !== false
      : fallback.bindTls;
    return {
      version,
      defaultModes,
      ipv4Suffix,
      ipv6Suffix,
      bindTls,
    };
  };
  const bindingConfig = normalizeBindingBootstrap(commonBootstrap.binding, bindingDefaults);

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
  const frontendConfig = landingBootstrap.frontend && typeof landingBootstrap.frontend === 'object'
    ? landingBootstrap.frontend
    : {};
  const frontendGlueUrl = normalizeString(frontendConfig.glueUrl);
  const frontendHtmlUrl = normalizeString(frontendConfig.htmlUrl);
  const frontendCommonCssUrl = normalizeString(frontendConfig.commonCssUrl);
  const frontendThemeCssUrl = normalizeString(frontendConfig.themeCssUrl);
  if (!frontendGlueUrl) {
    throw new Error('controller bootstrap.landing.frontend.glueUrl is required');
  }
  if (!frontendHtmlUrl) {
    throw new Error('controller bootstrap.landing.frontend.htmlUrl is required');
  }
  if (!frontendCommonCssUrl) {
    throw new Error('controller bootstrap.landing.frontend.commonCssUrl is required');
  }
  if (!frontendThemeCssUrl) {
    throw new Error('controller bootstrap.landing.frontend.themeCssUrl is required');
  }
  const captchaBindingConfig = landingBootstrap.captchaBinding && typeof landingBootstrap.captchaBinding === 'object'
    ? normalizeBindingBootstrap(landingBootstrap.captchaBinding, bindingDefaults)
    : null;
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
  const powdetExpireSeconds = parseDurationToSeconds(powdetConfig.expireSeconds, 180);
  const powdetClockSkewSeconds = parseDurationToSeconds(powdetConfig.clockSkewSeconds, 60);
  const powdetMaxWindowSeconds = parseDurationToSeconds(powdetConfig.maxWindowSeconds, 600);
  const powdetDifficultyTableDefault = normalizeString(powdetConfig.difficultyTable, POWDET_DIFFICULTY_TABLE);
  const powdetAlgorithmsRaw = powdetConfig.algorithms && typeof powdetConfig.algorithms === 'object'
    ? powdetConfig.algorithms
    : {};
  const normalizePowdetAlgorithmConfig = (alg, rawConfig) => {
    const normalizedAlg = normalizePowdetAlgorithm(alg);
    const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    let staticLevel = Number.isFinite(source.staticLevel)
      ? Number(source.staticLevel)
      : parseInteger(source.staticLevel, NaN);
    if (!Number.isFinite(staticLevel)) {
      staticLevel = NaN;
    }
    let dynamic = null;
    if (source.dynamic && typeof source.dynamic === 'object') {
      dynamic = {
        windowSeconds: parseDurationToSeconds(source.dynamic.windowSeconds, 60),
        resetSeconds: parseDurationToSeconds(source.dynamic.resetSeconds, 300),
        blockSeconds: parseDurationToSeconds(source.dynamic.blockSeconds, 300),
        baseLevelMin: parseInteger(source.dynamic.baseLevelMin, 12),
        baseLevelMax: parseInteger(source.dynamic.baseLevelMax, 20),
        levelStep: Math.max(1, parseInteger(source.dynamic.levelStep, 1)),
        maxLevel: Math.max(0, parseInteger(source.dynamic.maxLevel, 4)),
      };
    }
    return {
      alg: normalizedAlg,
      enabled: source.enabled !== false,
      staticLevel,
      dynamic,
      difficultyTableName: normalizeString(source.difficultyTable, powdetDifficultyTableDefault),
      staticBaseUrl: normalizeString(source.staticBaseUrl),
    };
  };
  const powdetAlgorithms = {};
  for (const [rawAlg, rawCfg] of Object.entries(powdetAlgorithmsRaw)) {
    const alg = normalizePowdetAlgorithm(rawAlg);
    if (!alg) {
      continue;
    }
    powdetAlgorithms[alg] = normalizePowdetAlgorithmConfig(alg, rawCfg);
  }
  const powdetEnabledAlgorithms = powdetEnabled
    ? Object.values(powdetAlgorithms).filter((entry) => entry.enabled).map((entry) => entry.alg)
    : [];
  if (powdetEnabled && (!powdetBaseUrl || !powdetApiToken)) {
    throw new Error('controller bootstrap.landing.powdet.baseUrl and token are required when powdet.enabled is true');
  }
  if (powdetEnabled && powdetEnabledAlgorithms.length === 0) {
    throw new Error('controller bootstrap.landing.powdet.algorithms must enable at least one algorithm');
  }

  const ipv4Only = landingBootstrap.ipv4Only === true;
  const hrwEnabledRaw = landingBootstrap.downloadWorkerHrwEnabled ?? landingBootstrap['download-worker-hrw-enabled'];
  const downloadWorkerHrwEnabled = typeof hrwEnabledRaw === 'string'
    ? hrwEnabledRaw.trim().toLowerCase() === 'true'
    : Boolean(hrwEnabledRaw);
  const hrwMaxRaw = landingBootstrap.downloadWorkerHrwMaxSize ?? landingBootstrap['download-worker-hrw-max-size'];
  const downloadWorkerHrwMaxSizeBytes = parseSizeToBytes(hrwMaxRaw, 512 * 1024 * 1024);
  if (downloadWorkerHrwEnabled && (!Number.isFinite(downloadWorkerHrwMaxSizeBytes) || downloadWorkerHrwMaxSizeBytes <= 0)) {
    throw new Error('controller landing.downloadWorkerHrwMaxSize is required when downloadWorkerHrwEnabled is true');
  }

  const dbConfig = landingBootstrap.db && typeof landingBootstrap.db === 'object'
    ? landingBootstrap.db
    : {};
  const rateLimitSource = dbConfig.rateLimit && typeof dbConfig.rateLimit === 'object'
    ? dbConfig.rateLimit
    : {};
  const cacheSource = dbConfig.cache && typeof dbConfig.cache === 'object'
    ? dbConfig.cache
    : {};
  const parseStringArray = (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
  };

  const cryptConfig = landingBootstrap.crypt && typeof landingBootstrap.crypt === 'object'
    ? landingBootstrap.crypt
    : {};
  const cryptPrefix = normalizeString(cryptConfig.prefix);
  const cryptIncludes = parseStringArray(cryptConfig.includes);
  const webDownloaderConfig = landingBootstrap.webDownloader && typeof landingBootstrap.webDownloader === 'object'
    ? landingBootstrap.webDownloader
    : {};
  const webDownloaderEnabled = Boolean(webDownloaderConfig.enabled);
  const clientDecryptEnabled = landingBootstrap.clientDecryptEnabled === true;
  let webDownloaderMaxConnections = parseInteger(
    webDownloaderConfig.maxConnections,
    DEFAULT_WEB_DOWNLOADER_MAX_CONNECTIONS
  );
  if (!Number.isFinite(webDownloaderMaxConnections) || webDownloaderMaxConnections <= 0) {
    webDownloaderMaxConnections = DEFAULT_WEB_DOWNLOADER_MAX_CONNECTIONS;
  }
  webDownloaderMaxConnections = Math.max(
    MIN_WEB_DOWNLOADER_MAX_CONNECTIONS,
    Math.min(MAX_WEB_DOWNLOADER_MAX_CONNECTIONS, Math.floor(webDownloaderMaxConnections))
  );
  const cryptEncryptionMode = normalizeString(cryptConfig.encryptionMode, 'crypt') || 'crypt';
  let cryptFileHeaderSize = parseInteger(
    cryptConfig.fileHeaderSize,
    DEFAULT_CRYPT_FILE_HEADER_SIZE
  );
  if (!Number.isFinite(cryptFileHeaderSize) || cryptFileHeaderSize <= 0) {
    cryptFileHeaderSize = DEFAULT_CRYPT_FILE_HEADER_SIZE;
  }
  let cryptBlockHeaderSize = parseInteger(
    cryptConfig.blockHeaderSize,
    DEFAULT_CRYPT_BLOCK_HEADER_SIZE
  );
  if (!Number.isFinite(cryptBlockHeaderSize) || cryptBlockHeaderSize <= 0) {
    cryptBlockHeaderSize = DEFAULT_CRYPT_BLOCK_HEADER_SIZE;
  }
  let cryptBlockDataSize = parseInteger(
    cryptConfig.blockDataSize,
    DEFAULT_CRYPT_BLOCK_DATA_SIZE
  );
  if (!Number.isFinite(cryptBlockDataSize) || cryptBlockDataSize <= 0) {
    cryptBlockDataSize = DEFAULT_CRYPT_BLOCK_DATA_SIZE;
  }
  const rawCryptDataKey = normalizeString(cryptConfig.dataKey);
  let cryptDataKeyBase64 = '';
  if (rawCryptDataKey) {
    const dataKeyBytes = hexToUint8Array(rawCryptDataKey);
    if (!dataKeyBytes || dataKeyBytes.length !== CRYPT_DATA_KEY_LENGTH) {
      throw new Error(`controller landing.crypt.dataKey must be a ${CRYPT_DATA_KEY_LENGTH * 2}-character hex string`);
    }
    cryptDataKeyBase64 = uint8ToBase64(dataKeyBytes);
  } else if (webDownloaderEnabled || clientDecryptEnabled) {
    throw new Error('controller landing.crypt.dataKey is required when web downloader or client decrypt is enabled');
  }

  const dbModeRaw = typeof dbConfig.mode === 'string' ? dbConfig.mode.trim() : '';
  const normalizedDbMode = dbModeRaw ? dbModeRaw.toLowerCase() : '';
  const dbMode = normalizedDbMode === 'custom-pg-rest' ? 'custom-pg-rest' : '';
  const hasDbMode = dbMode === 'custom-pg-rest';
  if (dbModeRaw && !hasDbMode) {
    throw new Error(`controller landing.db.mode must be "" or "custom-pg-rest", got "${dbModeRaw}"`);
  }
  const enableCfRatelimiter = normalizeString(env.ENABLE_CF_RATELIMITER, 'false').toLowerCase() === 'true';
  const cfRatelimiterBinding = normalizeString(env.CF_RATELIMITER_BINDING, 'CF_RATE_LIMITER');

  const windowTimeSeconds = parseDurationToSeconds(
    rateLimitSource.windowSeconds ?? rateLimitSource.window ?? rateLimitSource.windowTime,
    0
  );
  const windowTime = typeof rateLimitSource.window === 'string' && rateLimitSource.window.trim()
    ? rateLimitSource.window.trim()
    : (typeof rateLimitSource.windowTime === 'string' && rateLimitSource.windowTime.trim()
      ? rateLimitSource.windowTime.trim()
      : (windowTimeSeconds > 0 ? `${windowTimeSeconds}s` : ''));
  const ipSubnetLimit = parseInteger(rateLimitSource.limit, 0);
  const ipv4Suffix = normalizeString(rateLimitSource.ipv4Suffix, '/32') || '/32';
  const ipv6Suffix = normalizeString(rateLimitSource.ipv6Suffix, '/60') || '/60';
  const pgErrorHandle = normalizeString(rateLimitSource.pgErrorHandle, 'fail-closed').toLowerCase() || 'fail-closed';
  const blockTimeSeconds = parseDurationToSeconds(
    rateLimitSource.blockSeconds ?? rateLimitSource.block ?? rateLimitSource.blockTime,
    parseWindowTime('10m')
  );
  const blockTime = typeof rateLimitSource.block === 'string' && rateLimitSource.block.trim()
    ? rateLimitSource.block.trim()
    : (typeof rateLimitSource.blockTime === 'string' && rateLimitSource.blockTime.trim()
      ? rateLimitSource.blockTime.trim()
      : '10m');
  const fileWindowTimeSeconds = parseDurationToSeconds(
    rateLimitSource.fileWindowSeconds ?? rateLimitSource.fileWindow ?? rateLimitSource.fileWindowTime,
    parseWindowTime('60s')
  );
  const fileWindowTime = typeof rateLimitSource.fileWindow === 'string' && rateLimitSource.fileWindow.trim()
    ? rateLimitSource.fileWindow.trim()
    : (typeof rateLimitSource.fileWindowTime === 'string' && rateLimitSource.fileWindowTime.trim()
      ? rateLimitSource.fileWindowTime.trim()
      : '60s');
  const fileLimit = parseInteger(rateLimitSource.fileLimit, 4);
  const rawFileBlockTime = rateLimitSource.fileBlockSeconds ?? rateLimitSource.fileBlock ?? rateLimitSource.fileBlockTime;
  let fileBlockTimeSeconds = parseDurationToSeconds(rawFileBlockTime, parseWindowTime('4m'));
  if (fileBlockTimeSeconds < 0) {
    fileBlockTimeSeconds = parseWindowTime('4m');
  }

  let cleanupPercentage = Number.parseFloat(dbConfig.cleanupPercentage);
  if (!Number.isFinite(cleanupPercentage) || cleanupPercentage < 0 || cleanupPercentage > 100) {
    cleanupPercentage = 5;
  }
  cleanupPercentage = Math.min(100, Math.max(0, cleanupPercentage));
  const cleanupProbability = cleanupPercentage / 100;

  let rateLimitCleanupPercentage = Number.parseFloat(rateLimitSource.cleanupPercentage);
  if (!Number.isFinite(rateLimitCleanupPercentage) || rateLimitCleanupPercentage < 0 || rateLimitCleanupPercentage > 100) {
    rateLimitCleanupPercentage = cleanupPercentage;
  }
  rateLimitCleanupPercentage = Math.min(100, Math.max(0, rateLimitCleanupPercentage));
  const rateLimitCleanupProbability = rateLimitCleanupPercentage / 100;

  const cacheCleanupRaw = Number.parseFloat(cacheSource.cleanupPercentage);
  const cacheCleanupPercentage = Number.isFinite(cacheCleanupRaw) && cacheCleanupRaw >= 0 && cacheCleanupRaw <= 100
    ? cacheCleanupRaw
    : cleanupPercentage;
  const cacheCleanupProbability = Math.min(100, Math.max(0, cacheCleanupPercentage)) / 100;

  let sizeTTLSeconds = parseDurationToSeconds(cacheSource.sizeTTLSeconds ?? cacheSource.sizeTTL, parseWindowTime('24h'));
  if (sizeTTLSeconds <= 0) {
    sizeTTLSeconds = parseWindowTime('24h');
  }
  const sizeTTL = typeof cacheSource.sizeTTL === 'string' && cacheSource.sizeTTL.trim()
    ? cacheSource.sizeTTL.trim()
    : `${sizeTTLSeconds}s`;
  const filesizeCacheTableName = normalizeString(cacheSource.tableName, 'FILESIZE_CACHE_TABLE') || 'FILESIZE_CACHE_TABLE';

  const verifyHeaders = parseStringArray(dbConfig.verifyHeader);
  const verifySecrets = parseStringArray(dbConfig.verifySecret);

  if (verifyHeaders.length > 0 && verifySecrets.length > 0 && verifyHeaders.length !== verifySecrets.length) {
    throw new Error('controller landing.db.verifyHeader and verifySecret must have the same length');
  }

  let postgrestUrl = normalizeString(dbConfig.postgrestUrl, '');

  if (!hasDbMode) {
    turnstileTokenBindingEnabled = false;
  }

  let rateLimitEnabled = false;
  let rateLimitConfig = {};
  let cacheEnabled = false;
  let cacheConfig = {};
  const rateLimitEnabledFlag = rateLimitSource.enabled !== false;
  const ipRateLimitActive = Boolean(hasDbMode && rateLimitEnabledFlag && windowTimeSeconds > 0 && ipSubnetLimit > 0);
  const fileRateLimitActive = Boolean(hasDbMode && rateLimitEnabledFlag && fileWindowTimeSeconds > 0 && fileLimit > 0);

  if (hasDbMode && ipSubnetLimit === 0 && !ipRateLimitDisabledLogged) {
    console.log('IP rate limiting disabled (limit=0)');
    ipRateLimitDisabledLogged = true;
  }

  if (hasDbMode) {
    if (!postgrestUrl || verifyHeaders.length === 0 || verifySecrets.length === 0) {
      throw new Error('controller landing.db requires postgrestUrl and verifyHeader/verifySecret when db.mode = "custom-pg-rest"');
    }
    if (ipSubnetLimit > 0 && windowTimeSeconds <= 0) {
      throw new Error('landing rateLimit.windowSeconds must be greater than zero when limit > 0');
    }
    if (fileLimit > 0 && fileWindowTimeSeconds <= 0) {
      throw new Error('landing rateLimit.fileWindowSeconds must be greater than zero when fileLimit > 0');
    }

    const validPgErrorHandle = pgErrorHandle === 'fail-open' ? 'fail-open' : 'fail-closed';
    const rateLimitTableName = normalizeString(rateLimitSource.tableName, 'IP_LIMIT_TABLE') || 'IP_LIMIT_TABLE';
    const rateLimitFileTable = normalizeString(rateLimitSource.fileTableName, 'IP_FILE_LIMIT_TABLE') || 'IP_FILE_LIMIT_TABLE';

    rateLimitConfig = {
      postgrestUrl,
      verifyHeader: verifyHeaders,
      verifySecret: verifySecrets,
      tableName: rateLimitTableName,
      windowTimeSeconds,
      limit: ipSubnetLimit,
      ipv4Suffix,
      ipv6Suffix,
      pgErrorHandle: validPgErrorHandle,
      cleanupProbability: rateLimitCleanupProbability,
      blockTimeSeconds,
      fileLimit,
      fileWindowTimeSeconds,
      fileBlockTimeSeconds,
      fileTableName: rateLimitFileTable,
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
        cleanupProbability: cacheCleanupProbability,
      };
    } else {
      console.warn('[CONFIG] Cache DISABLED: sizeTTLSeconds =', sizeTTLSeconds);
    }
  }

  let idleTimeoutSeconds = hasDbMode ? parseDurationToSeconds(dbConfig.idleTimeoutSeconds, 0) : 0;
  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds < 0) {
    idleTimeoutSeconds = 0;
  }

  const idleTimeoutRaw = `${idleTimeoutSeconds}s`;
  const idleTableName = normalizeString(dbConfig.idleTable, 'DOWNLOAD_LAST_ACTIVE_TABLE') || 'DOWNLOAD_LAST_ACTIVE_TABLE';

  const payloadConfig = landingBootstrap.payload && typeof landingBootstrap.payload === 'object'
    ? landingBootstrap.payload
    : {};
  const normalizedAlistAddress = normalizeString(commonBootstrap.alistBaseUrl).replace(/\/$/, '');
  const minBandwidthMbps = parseNumber(payloadConfig.minBandwidthMbps, 10);
  const bandwidthBytesPerSecond = minBandwidthMbps > 0
    ? (minBandwidthMbps * 1_000_000) / 8
    : (10 * 1_000_000) / 8;
  const minDurationSeconds = parseDurationToSeconds(payloadConfig.minDurationSeconds, 3600);
  const rawMaxDurationSeconds = parseDurationToSeconds(payloadConfig.maxDurationSeconds, 0);
  const maxDurationSeconds = Math.max(0, rawMaxDurationSeconds);
  const maxDurationMilliseconds = maxDurationSeconds > 0 ? maxDurationSeconds * 1000 : null;

  const workerAddressesList = Array.isArray(commonBootstrap.workerAddresses)
    ? commonBootstrap.workerAddresses
    : [];
  const normalizedWorkerAddresses = normalizeOriginList(workerAddressesList);
  if (normalizedWorkerAddresses.length === 0) {
    throw new Error('controller common.workerAddresses is required');
  }
  const workerAddressesValue = normalizedWorkerAddresses.join(',');

  const landingWorkerAddressesList = Array.isArray(commonBootstrap.landingWorkerAddresses)
    ? commonBootstrap.landingWorkerAddresses
    : [];
  const normalizedLandingWorkerAddresses = normalizeOriginList(landingWorkerAddressesList);
  if (normalizedLandingWorkerAddresses.length === 0) {
    throw new Error('controller common.landingWorkerAddresses is required');
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
    token,
    binding: bindingConfig,
    captchaBinding: captchaBindingConfig,
    workerAddresses: workerAddressesValue,
    landingWorkerAddresses: normalizedLandingWorkerAddresses,
    verifyHeader: verifyHeaders,
    verifySecret: verifySecrets,
    ipv4Only,
    downloadWorkerHrwEnabled,
    downloadWorkerHrwMaxSizeBytes,
    signSecret: signSecretFromController,
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
    powdetAlgorithms,
    powdetEnabledAlgorithms,
    pageSecret,
    frontendGlueUrl,
    frontendHtmlUrl,
    frontendCommonCssUrl,
    frontendThemeCssUrl,
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
    alistAddress: normalizedAlistAddress,
    alistAuthHeaders,
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

const fetchPowdetChallenge = async (config, alg, difficultyLevel) => {
  const base = String(config.powdetBaseUrl || '').trim();
  const token = String(config.powdetApiToken || '').trim();
  const algo = normalizePowdetAlgorithm(alg);
  if (!base || !token) {
    throw new Error('powdet baseUrl and token are required when POWDET is enabled');
  }
  if (!algo) {
    throw new Error('powdet algo is required');
  }
  const url = new URL('/GetChallenges', base);
  url.searchParams.set('algo', algo);
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

const verifyPowdet = async (config, alg, challenge, nonce) => {
  const base = String(config.powdetBaseUrl || '').trim();
  const token = String(config.powdetApiToken || '').trim();
  const algo = normalizePowdetAlgorithm(alg);
  if (!base || !token) {
    throw new Error('powdet baseUrl and token are required when POWDET is enabled');
  }
  if (!algo) {
    throw new Error('powdet algo is required');
  }
  const url = new URL('/Verify', base);
  url.searchParams.set('algo', algo);
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

const encodeUrlSafeBase64NoPad = (bytes) => encodeUrlSafeBase64(bytes).replace(/=+$/u, '');

const encodeJsonToBase64Url = (value) => {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  return encodeUrlSafeBase64NoPad(bytes);
};

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

const normalizeLinkValue = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : '';
};

const buildBindingPayload = async (
  secret,
  bindingStr,
  expiresAtSeconds,
  context = 'Binding',
  additionalData = null,
) => {
  const normalizedBindingStr = typeof bindingStr === 'string' ? bindingStr : '';
  const normalizedExpires =
    Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0 ? Math.floor(expiresAtSeconds) : 0;
  const payloadObject = {
    bindingStr: normalizedBindingStr,
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
      bindingStr: normalizedBindingStr,
      bindingMac: mac,
      expiresAt: normalizedExpires,
    };
  } catch (error) {
    console.error(`[${context}] Failed to compute binding MAC:`, error instanceof Error ? error.message : String(error));
    return {
      bindingStr: normalizedBindingStr,
      bindingMac: '',
      expiresAt: normalizedExpires,
    };
  }
};

const buildAltchaBinding = async (secret, bindingStr, expiresAtSeconds, salt, link) => {
  const normalizedSalt = typeof salt === 'string' ? salt : '';
  const normalizedLink = normalizeLinkValue(link);
  const additionalData = {};
  if (normalizedSalt) {
    additionalData.salt = normalizedSalt;
  }
  if (normalizedLink) {
    additionalData.link = normalizedLink;
  }
  const payloadData = Object.keys(additionalData).length > 0 ? additionalData : null;
  return buildBindingPayload(secret, bindingStr, expiresAtSeconds, 'ALTCHA', payloadData);
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

const getPowdetAlgorithmConfig = (config, alg) => {
  if (!config?.powdetAlgorithms || typeof config.powdetAlgorithms !== 'object') {
    return null;
  }
  const normalizedAlg = normalizePowdetAlgorithm(alg);
  if (!normalizedAlg) {
    return null;
  }
  return config.powdetAlgorithms[normalizedAlg] || null;
};

const fetchPowdetDifficultyState = async (config, env, ipHash, alg) => {
  const normalizedAlg = normalizePowdetAlgorithm(alg);
  const algoCfg = getPowdetAlgorithmConfig(config, normalizedAlg);
  if (!algoCfg?.dynamic || !ipHash || !normalizedAlg) {
    return null;
  }
  const dbMode = getNormalizedDbMode(config);
  if (dbMode !== 'custom-pg-rest') {
    return null;
  }
  const tableName = algoCfg.difficultyTableName || POWDET_DIFFICULTY_TABLE;
  try {
    const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
    if (!postgrestUrl) {
      return null;
    }
    const rpcUrl = `${postgrestUrl}/rpc/landing_get_powdet_difficulty`;
    const headers = { 'Content-Type': 'application/json' };
    applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_alg: normalizedAlg,
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

const updatePowdetDifficultyState = async (config, env, scope, nowSeconds, alg) => {
  const normalizedAlg = normalizePowdetAlgorithm(alg);
  const algoCfg = getPowdetAlgorithmConfig(config, normalizedAlg);
  if (!algoCfg?.dynamic || !scope?.ipHash || !scope?.ipRange || !normalizedAlg) {
    return;
  }
  const dbMode = getNormalizedDbMode(config);
  if (!dbMode) {
    return;
  }
  const tableName = algoCfg.difficultyTableName || POWDET_DIFFICULTY_TABLE;
  try {
    if (dbMode === 'custom-pg-rest') {
      const postgrestUrl = config.rateLimitConfig?.postgrestUrl;
      if (!postgrestUrl) {
        return;
      }
      const rpcUrl = `${postgrestUrl}/rpc/landing_update_powdet_difficulty`;
      const headers = { 'Content-Type': 'application/json' };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      const body = {
        p_alg: normalizedAlg,
        p_ip_hash: scope.ipHash,
        p_ip_range: scope.ipRange,
        p_now: nowSeconds,
        p_window_seconds: algoCfg.dynamic.windowSeconds,
        p_reset_seconds: algoCfg.dynamic.resetSeconds,
        p_max_exponent: algoCfg.dynamic.maxLevel,
        p_block_seconds: algoCfg.dynamic.blockSeconds,
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

const resolveBindingModes = (downloadDecision, bindingConfig) => {
  const decisionModes = parseCheckOriginEnv(downloadDecision?.checkOriginMode || '');
  if (decisionModes.length > 0) {
    return decisionModes;
  }
  return parseCheckOriginEnv(bindingConfig?.defaultModes || '');
};

const resolveCaptchaBindingConfig = (config, downloadDecision) => {
  const captchaBinding = config?.captchaBinding && typeof config.captchaBinding === 'object'
    ? config.captchaBinding
    : null;
  const bindingConfig = captchaBinding || config?.binding;
  const bindingModes = captchaBinding
    ? parseCheckOriginEnv(bindingConfig?.defaultModes || '')
    : resolveBindingModes(downloadDecision, bindingConfig);
  return { bindingConfig, bindingModes, override: Boolean(captchaBinding) };
};

const buildCaptchaBindingStr = async (config, downloadDecision, request, clientIP, path) => {
  const { bindingConfig, bindingModes } = resolveCaptchaBindingConfig(config, downloadDecision);
  return buildBindingStr({
    modes: bindingModes,
    path,
    cf: request?.cf,
    clientIP,
    bindingConfig,
    token: config?.token,
  });
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

const parseWorkerAddresses = (workerAddresses) => {
  if (!workerAddresses || typeof workerAddresses !== 'string') {
    return [];
  }
  return workerAddresses
    .split(',')
    .map((addr) => addr.trim())
    .filter((addr) => addr.length > 0)
    .map((addr) => addr.replace(/\/$/, ''));
};

const selectRandomWorker = (workerAddresses) => {
  const addresses = parseWorkerAddresses(workerAddresses);
  if (addresses.length === 0) {
    throw new Error('controller common.workerAddresses contains no valid addresses');
  }
  return addresses[Math.floor(Math.random() * addresses.length)];
};

const selectHrwWorker = async (workerAddresses, pathHash) => {
  const addresses = parseWorkerAddresses(workerAddresses);
  if (addresses.length === 0) {
    throw new Error('controller common.workerAddresses contains no valid addresses');
  }
  if (!pathHash) {
    return selectRandomWorker(workerAddresses);
  }

  let selected = addresses[0];
  let bestScore = null;

  for (const address of addresses) {
    const hash = await sha256Hash(`${pathHash}:${address}`);
    if (!hash) {
      continue;
    }
    let score;
    try {
      score = BigInt(`0x${hash}`);
    } catch {
      continue;
    }
    if (bestScore === null || score > bestScore) {
      bestScore = score;
      selected = address;
    }
  }

  return selected;
};

const selectDownloadWorker = async (config, decodedPath, sizeBytes, fileInfo) => {
  const normalizedSize = (() => {
    const sizeFromInput = parseFileSize(sizeBytes);
    if (sizeFromInput > 0) {
      return sizeFromInput;
    }
    if (fileInfo) {
      return parseFileSize(fileInfo.size);
    }
    return 0;
  })();

  if (
    config.downloadWorkerHrwEnabled &&
    normalizedSize > 0 &&
    normalizedSize <= config.downloadWorkerHrwMaxSizeBytes
  ) {
    const pathHash = await sha256Hash(decodedPath);
    return await selectHrwWorker(config.workerAddresses, pathHash);
  }

  return selectRandomWorker(config.workerAddresses);
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
  if (config.alistAuthHeaders && typeof config.alistAuthHeaders === 'object') {
    for (const [headerName, headerValue] of Object.entries(config.alistAuthHeaders)) {
      headers[headerName] = headerValue;
    }
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

const createDownloadURL = async (
  config,
  request,
  { encodedPath, decodedPath, sign, clientIP, sizeBytes, expireTime, fileInfo, isCrypt = false, downloadDecision },
  ctx = null
) => {
  const workerBaseURL = await selectDownloadWorker(config, decodedPath, sizeBytes, fileInfo);
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
  const bindingModes = resolveBindingModes(downloadDecision, config.binding);
  const bindingResult = await buildBindingStr({
    modes: bindingModes,
    path: encodedPath,
    cf: request.cf,
    clientIP,
    bindingConfig: config.binding,
    token: config.token,
  });
  if (!bindingResult.ok) {
    const error = new Error(bindingResult.reason || 'binding unavailable');
    error.status = 403;
    throw error;
  }

  const issuer = new URL(request.url).origin;
  const workerOrigin = new URL(workerBaseURL).origin;
  const encrypt = await encryptBindingPayload(
    { v: 2, issuer, workerAddress: workerOrigin },
    config.token
  );

  const payloadObject = {
    v: 1,
    expireTime: resolvedExpireTime,
    filesize: normalizedSizeBytes,
    idle_timeout: idleTimeoutSeconds,
    encrypt,
    bindingStr: bindingResult.bindingStr,
    bindingVer: config.binding?.version || 1,
    isCrypted: isCrypt === true,
  };
  const payload = encodeJsonToBase64Url(payloadObject);
  const payloadSign = await hmacSha256Sign(config.token, payload, expire);

  const downloadURLObj = new URL(encodedPath, workerBaseURL);
  downloadURLObj.searchParams.set('payload', payload);
  downloadURLObj.searchParams.set('payloadSign', payloadSign);

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
  const ipSubnet = clientIP
    ? calculateIPSubnet(clientIP, config.ipv4Suffix, config.ipv6Suffix)
    : '';
  let filepathHash = null;
  if (decodedPath) {
    try {
      filepathHash = await sha256Hash(decodedPath);
    } catch (error) {
      console.error('[Path Hash] Failed to hash filepath:', error instanceof Error ? error.message : String(error));
    }
  }

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

  if (config.rateLimitEnabled && ipSubnet) {
    const cachedIpRemaining = getIpRangeRateLimitRemaining(ipSubnet);
    if (cachedIpRemaining > 0) {
      await slowFailDelay();
      return respondRateLimitExceeded(
        origin,
        ipSubnet,
        config.ipSubnetLimit || 0,
        config.windowTime,
        cachedIpRemaining
      );
    }
    if (filepathHash) {
      const ipFileKey = `${ipSubnet}|${filepathHash}`;
      const now = nowMs();
      const cachedIpFile = lruGet(RL_IP_FILE_LRU, ipFileKey, now);
      if (cachedIpFile && cachedIpFile.untilMs && cachedIpFile.untilMs > now) {
        const remaining = Math.ceil((cachedIpFile.untilMs - now) / 1000);
        const windowLabel = config.fileWindowTime || config.windowTime;
        const limitValue = config.fileLimit || 0;
        const subject = `${ipSubnet} + ${decodedPath || '/'}`;
        await slowFailDelay();
        return respondRateLimitExceeded(origin, subject, limitValue, windowLabel, remaining);
      }
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
  const powdetSolutionsParam = url.searchParams.get('powdetSolutions') || '';
  let powdetSolutions = null;
  if (powdetSolutionsParam) {
    try {
      const decoded = base64urlDecode(powdetSolutionsParam);
      const parsed = JSON.parse(decoded);
      if (!Array.isArray(parsed)) {
        throw new Error('powdetSolutions must be an array');
      }
      powdetSolutions = parsed;
    } catch (error) {
      console.error('[Powdet] Failed to decode powdetSolutions:', error instanceof Error ? error.message : String(error));
      return respondJson(origin, { code: 400, message: 'invalid powdetSolutions format' }, 400);
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
  const powdetRequiredAlgorithms = Array.isArray(parsedNeeds.powdetAlgorithms)
    ? parsedNeeds.powdetAlgorithms
        .map((alg) => normalizePowdetAlgorithm(alg))
        .filter((alg) => alg)
    : [];
  let needPowdet = powdetRequiredAlgorithms.length > 0;
  if (needPowdet) {
    const invalidPowdet = powdetRequiredAlgorithms.filter((alg) => {
      const algoCfg = getPowdetAlgorithmConfig(config, alg);
      return !algoCfg || !algoCfg.enabled;
    });
    if (invalidPowdet.length > 0) {
      return respondJson(origin, { code: 500, message: 'powdet algorithm unavailable' }, 500);
    }
  }

  let altchaScope = clientIP
    ? await computeAltchaIpScope(clientIP, config.ipv4Suffix, config.ipv6Suffix)
    : null;
  if (needAltcha && config.altchaDynamicEnabled && altchaScope?.ipHash) {
    if (altchaScope.ipRange) {
      const now = nowMs();
      const cachedBlock = lruGet(ALTCHA_BLOCK_LRU, altchaScope.ipRange, now);
      if (cachedBlock && cachedBlock.untilMs && cachedBlock.untilMs > now) {
        const remaining = Math.ceil((cachedBlock.untilMs - now) / 1000);
        await slowFailDelay();
        return respondAltchaBlocked(origin, remaining);
      }
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const state = await fetchAltchaDifficultyState(config, env, altchaScope.ipHash);
    const difficultyResult = getAltchaDifficultyForClient(state, nowSeconds, config.altchaDynamic);
    if (difficultyResult.blocked) {
      const retry = normalizePositiveSeconds(difficultyResult.retryAfterSeconds, 0);
      if (retry > 0 && altchaScope.ipRange) {
        const now = nowMs();
        lruPut(ALTCHA_BLOCK_LRU, altchaScope.ipRange, {
          untilMs: now + retry * 1000,
        });
      }
      await slowFailDelay();
      return respondAltchaBlocked(origin, difficultyResult.retryAfterSeconds);
    }
  }

  let powdetScope = null;
  if (needPowdet && clientIP) {
    powdetScope = altchaScope || (await computeAltchaIpScope(clientIP, config.ipv4Suffix, config.ipv6Suffix));
  }
  if (needPowdet && powdetScope?.ipHash) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const alg of powdetRequiredAlgorithms) {
      const algoCfg = getPowdetAlgorithmConfig(config, alg);
      if (!algoCfg?.dynamic) {
        continue;
      }
      if (powdetScope.ipRange) {
        const now = nowMs();
        const blockKey = `${alg}|${powdetScope.ipRange}`;
        const cachedBlock = lruGet(POWDET_BLOCK_LRU, blockKey, now);
        if (cachedBlock && cachedBlock.untilMs && cachedBlock.untilMs > now) {
          const remaining = Math.ceil((cachedBlock.untilMs - now) / 1000);
          await slowFailDelay();
          return respondJson(origin, { code: 429, message: 'powdet blocked', retryAfter: remaining }, 429);
        }
      }
      const powState = await fetchPowdetDifficultyState(config, env, powdetScope.ipHash, alg);
      const powDifficulty = getPowdetDifficultyForClient(powState, nowSeconds, algoCfg.dynamic);
      if (powDifficulty.blocked) {
        const retry = normalizePositiveSeconds(powDifficulty.retryAfterSeconds, 0);
        if (retry > 0 && powdetScope.ipRange) {
          const now = nowMs();
          const blockKey = `${alg}|${powdetScope.ipRange}`;
          lruPut(POWDET_BLOCK_LRU, blockKey, {
            untilMs: now + retry * 1000,
          });
        }
        await slowFailDelay();
        return respondJson(origin, { code: 429, message: 'powdet blocked', retryAfter: powDifficulty.retryAfterSeconds }, 429);
      }
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
  let turnstileLink = '';
  let altchaLink = '';
  let powdetLink = '';

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
  const downloadDecision = ctx?.controllerState?.decision?.download;
  const needsTurnstileBinding = needTurnstile && config.turnstileCookieExpireSeconds > 0;
  const needsChallengeBinding = needsTurnstileBinding || needAltcha || needPowdet;
  let captchaBindingStr = '';
  if (needsChallengeBinding) {
    const bindingResult = await buildCaptchaBindingStr(config, downloadDecision, request, clientIP, encodedPath);
    if (!bindingResult.ok) {
      return respondJson(
        origin,
        { code: 403, message: bindingResult.reason || 'captcha binding unavailable' },
        403
      );
    }
    captchaBindingStr = bindingResult.bindingStr;
  }

  let altchaTokenHash = null;
  let expectedTurnstileCData = '';
  let payloadTurnstileNonce = '';
  const powdetChallengeStates = new Map();
  const powdetChallengesForDb = [];
  if (needsTurnstileBinding) {
    if (!turnstileBindingPayload) {
      return respondJson(origin, { code: 463, message: 'turnstile binding required' }, 403);
    }
    const payloadBindingStr = typeof turnstileBindingPayload.bindingStr === 'string'
      ? turnstileBindingPayload.bindingStr
      : '';
    const payloadBindingMac = typeof turnstileBindingPayload.binding === 'string'
      ? turnstileBindingPayload.binding
      : '';
    const payloadLink = normalizeLinkValue(turnstileBindingPayload.link);
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
    if (!payloadBindingStr || !payloadBindingMac || !Number.isFinite(payloadBindingExpiresAt) || payloadBindingExpiresAt <= 0) {
      return respondJson(origin, { code: 463, message: 'turnstile binding missing' }, 403);
    }
    if (!payloadLink) {
      return respondJson(origin, { code: 463, message: 'turnstile binding missing link' }, 403);
    }
    if (!payloadTurnstileNonce) {
      return respondJson(origin, { code: 463, message: 'turnstile binding missing nonce' }, 403);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(payloadTurnstileNonce)) {
      return respondJson(origin, { code: 463, message: 'turnstile binding nonce invalid' }, 403);
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payloadBindingExpiresAt < nowSeconds) {
      return respondJson(origin, { code: 463, message: 'turnstile binding expired' }, 403);
    }
    if (payloadBindingStr !== captchaBindingStr) {
      return respondJson(origin, { code: 463, message: 'turnstile binding mismatch' }, 403);
    }
    const turnstileBindingExtra = { link: payloadLink };
    const expectedBinding = await buildBindingPayload(
      config.pageSecret,
      captchaBindingStr,
      payloadBindingExpiresAt,
      'Turnstile',
      Object.keys(turnstileBindingExtra).length > 0 ? turnstileBindingExtra : null
    );
    const mismatch =
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
    turnstileLink = payloadLink;
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

      const payloadBindingStr = typeof altchaPayload.bindingStr === 'string' ? altchaPayload.bindingStr : '';
      const payloadBindingMac = typeof altchaPayload.binding === 'string' ? altchaPayload.binding : '';
      const payloadBindingExpireRaw = altchaPayload.bindingExpiresAt;
      const payloadBindingExpiresAt = Number.isFinite(payloadBindingExpireRaw)
        ? Math.floor(payloadBindingExpireRaw)
        : Number.parseInt(payloadBindingExpireRaw, 10);
      const payloadSalt = typeof altchaPayload.salt === 'string' ? altchaPayload.salt : '';
      const payloadLink = normalizeLinkValue(altchaPayload.link);
      if (!payloadSalt) {
        return respondJson(origin, { code: 403, message: 'ALTCHA binding missing salt' }, 403);
      }
      if (!payloadBindingStr || !payloadBindingMac || !Number.isFinite(payloadBindingExpiresAt) || payloadBindingExpiresAt <= 0) {
        return respondJson(origin, { code: 403, message: 'ALTCHA binding missing' }, 403);
      }
      if (!payloadLink) {
        return respondJson(origin, { code: 403, message: 'ALTCHA binding missing link' }, 403);
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      if (payloadBindingExpiresAt < nowSeconds) {
        return respondJson(origin, { code: 463, message: 'ALTCHA binding expired' }, 403);
      }
      if (payloadBindingStr !== captchaBindingStr) {
        return respondJson(origin, { code: 463, message: 'ALTCHA binding mismatch' }, 403);
      }
      const expectedBinding = await buildAltchaBinding(
        config.pageSecret,
        captchaBindingStr,
        payloadBindingExpiresAt,
        payloadSalt,
        payloadLink
      );
      const bindingMismatch =
        payloadBindingMac !== expectedBinding.bindingMac ||
        payloadBindingExpiresAt !== expectedBinding.expiresAt;
      if (bindingMismatch) {
        return respondJson(origin, { code: 463, message: 'ALTCHA binding mismatch' }, 403);
      }
      altchaLink = payloadLink;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return respondJson(origin, { code: 403, message: `ALTCHA error: ${message}` }, 403);
    }
  }

  if (needPowdet) {
    if (!Array.isArray(powdetSolutions)) {
      return respondJson(origin, { code: 403, message: 'powdet solutions required' }, 403);
    }
    const requiredSet = new Set(powdetRequiredAlgorithms);
    const solutionsMap = new Map();
    for (const item of powdetSolutions) {
      if (!item || typeof item !== 'object') {
        return respondJson(origin, { code: 403, message: 'powdet solutions invalid' }, 403);
      }
      const alg = normalizePowdetAlgorithm(item.alg);
      if (!alg || !requiredSet.has(alg)) {
        return respondJson(origin, { code: 403, message: 'powdet algorithm not allowed' }, 403);
      }
      if (solutionsMap.has(alg)) {
        return respondJson(origin, { code: 403, message: 'powdet algorithm duplicated' }, 403);
      }
      solutionsMap.set(alg, item);
    }
    for (const alg of requiredSet) {
      if (!solutionsMap.has(alg)) {
        return respondJson(origin, { code: 403, message: 'powdet solution missing' }, 403);
      }
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const clockSkew = Number.isFinite(config.powdetClockSkewSeconds) ? config.powdetClockSkewSeconds : 60;
    const maxWindow = Number.isFinite(config.powdetMaxWindowSeconds) ? config.powdetMaxWindowSeconds : 600;
    const expectedBindingStr = captchaBindingStr;
    if (!expectedBindingStr) {
      return respondJson(origin, { code: 403, message: 'powdet binding unavailable' }, 403);
    }

    let powdetLinkValue = null;
    for (const alg of powdetRequiredAlgorithms) {
      const solution = solutionsMap.get(alg);
      const payloadChallenge = typeof solution?.challenge === 'string' ? solution.challenge : '';
      const payloadNonce = typeof solution?.nonce === 'string' ? solution.nonce : '';
      const payloadRandom = typeof solution?.randomStr === 'string' ? solution.randomStr : '';
      const payloadHmac = typeof solution?.hmac === 'string' ? solution.hmac : '';
      const payloadLink = normalizeLinkValue(solution?.link);
      const rawExpire = solution?.expireAt ?? solution?.expiresAt;
      const payloadExpireAt = Number.isFinite(rawExpire) ? Math.floor(rawExpire) : Number.parseInt(rawExpire, 10);

      if (!payloadChallenge || !payloadNonce || !payloadRandom || !payloadHmac || !Number.isFinite(payloadExpireAt)) {
        return respondJson(origin, { code: 403, message: 'powdet payload missing' }, 403);
      }
      if (!payloadLink) {
        return respondJson(origin, { code: 403, message: 'powdet link missing' }, 403);
      }
      if (payloadExpireAt + clockSkew < nowSeconds) {
        return respondJson(origin, { code: 463, message: 'powdet challenge expired' }, 403);
      }
      if (payloadExpireAt - nowSeconds > maxWindow) {
        return respondJson(origin, { code: 463, message: 'powdet expire window invalid' }, 403);
      }

      if (powdetLinkValue === null) {
        powdetLinkValue = payloadLink;
      } else if (payloadLink !== powdetLinkValue) {
        return respondJson(origin, { code: 463, message: 'powdet link mismatch' }, 403);
      }

      let expectedHmac = '';
      try {
        const bindingPayload = {
          alg,
          bindingStr: expectedBindingStr,
          expireAt: payloadExpireAt,
          randomStr: payloadRandom,
          challenge: payloadChallenge,
          link: payloadLink,
        };
        expectedHmac = await computePowdetHmac(config, bindingPayload);
      } catch (error) {
        console.error('[Powdet] Failed to compute HMAC:', error instanceof Error ? error.message : String(error));
        return respondJson(origin, { code: 500, message: 'powdet verification unavailable' }, 500);
      }

      if (!timingSafeEqualHex(payloadHmac, expectedHmac)) {
        return respondJson(origin, { code: 463, message: 'powdet binding mismatch' }, 403);
      }

      let challengeHash = '';
      try {
        challengeHash = await sha256Hash(payloadChallenge);
      } catch (error) {
        console.error('[Powdet] Failed to hash challenge:', error instanceof Error ? error.message : String(error));
        if (hasDbMode) {
          return respondJson(origin, { code: 500, message: 'powdet hashing failed' }, 500);
        }
      }

      if (challengeHash) {
        const now = nowMs();
        const replayKey = `${alg}|${challengeHash}`;
        const cachedReplay = lruGet(POWDET_REPLAY_LRU, replayKey, now);
        if (cachedReplay && cachedReplay.untilMs && cachedReplay.untilMs > now) {
          await slowFailDelay();
          return respondJson(origin, { code: 463, message: 'powdet challenge reused' }, 403);
        }
      }

      let powdetVerifyFailKey = null;
      if (challengeHash) {
        powdetVerifyFailKey = powdetScope?.ipRange
          ? `${alg}|${powdetScope.ipRange}|${challengeHash}`
          : `${alg}|${challengeHash}`;
        const now = nowMs();
        const cachedVerifyFail = lruGet(POWDET_VERIFY_FAIL_LRU, powdetVerifyFailKey, now);
        if (cachedVerifyFail && cachedVerifyFail.untilMs && cachedVerifyFail.untilMs > now) {
          await slowFailDelay();
          return respondJson(origin, { code: 463, message: 'powdet verification failed' }, 403);
        }
      }

      const powVerify = await verifyPowdet(config, alg, payloadChallenge, payloadNonce);
      if (!powVerify.ok) {
        const message = powVerify.message || 'powdet verification failed';
        const status = Number(powVerify.status);
        const isBusinessFailure = Number.isFinite(status) && status >= 400 && status < 500;
        if (isBusinessFailure && powdetVerifyFailKey) {
          const ttlSeconds = 60;
          const now = nowMs();
          lruPut(POWDET_VERIFY_FAIL_LRU, powdetVerifyFailKey, {
            untilMs: now + ttlSeconds * 1000,
          });
        }
        if (isBusinessFailure) {
          await slowFailDelay();
        }
        return respondJson(origin, { code: 463, message }, 403);
      }

      if (challengeHash) {
        powdetChallengeStates.set(alg, {
          challengeHash,
          expireAt: payloadExpireAt,
        });
        powdetChallengesForDb.push({
          alg,
          hash: challengeHash,
          expireAt: payloadExpireAt,
        });
      }
    }
    powdetLink = powdetLinkValue || '';
  } else if (Array.isArray(powdetSolutions) && powdetSolutions.length > 0) {
    return respondJson(origin, { code: 403, message: 'powdet not required' }, 403);
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
    if (altchaTokenHash) {
      const now = nowMs();
      const cachedReplay = lruGet(ALTCHA_TOKEN_REPLAY_LRU, altchaTokenHash, now);
      if (cachedReplay && cachedReplay.untilMs && cachedReplay.untilMs > now) {
        await slowFailDelay();
        return respondJson(origin, { code: 463, message: 'ALTCHA token validation failed' }, 403);
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

  const linkCandidates = [];
  if (needTurnstile) {
    linkCandidates.push({ source: 'turnstile', value: turnstileLink });
  }
  if (needAltcha) {
    linkCandidates.push({ source: 'altcha', value: altchaLink });
  }
  if (needPowdet) {
    linkCandidates.push({ source: 'powdet', value: powdetLink });
  }
  if (linkCandidates.length >= 2) {
    const missingLink = linkCandidates.find((entry) => !entry.value);
    if (missingLink) {
      return respondJson(origin, { code: 463, message: 'challenge link missing' }, 403);
    }
    const baseLink = linkCandidates[0].value;
    if (linkCandidates.some((entry) => entry.value !== baseLink)) {
      return respondJson(origin, { code: 463, message: 'challenge link mismatch' }, 403);
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
  const requiresPowdetStateful = Boolean(needPowdet && powdetChallengesForDb.length > 0 && hasDbMode);
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
          powdetChallenges: powdetChallengesForDb,
          powdetTableName: powTableName,
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
            const expiresAt = Number.isFinite(altchaResult.expiresAt) ? altchaResult.expiresAt : null;
            const nowSeconds = Math.floor(Date.now() / 1000);
            let ttlSeconds = 0;
            if (expiresAt && expiresAt > nowSeconds) {
              ttlSeconds = expiresAt - nowSeconds;
            } else {
              ttlSeconds = normalizePositiveSeconds(config.altchaTokenExpire, 180);
            }
            if (ttlSeconds > 0) {
              const now = nowMs();
              lruPut(ALTCHA_TOKEN_REPLAY_LRU, altchaTokenHash, {
                untilMs: now + ttlSeconds * 1000,
              });
            }
            await slowFailDelay();
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
          const now = nowMs();
          const rl = unifiedResult.rateLimit || {};
          const ipSubnetForBlock = rl.ipSubnet || ipSubnet || clientIP || '';
          if (ipSubnetForBlock && rl.ipAllowed === false && rl.ipRetryAfter) {
            markIpRangeRateLimited(ipSubnetForBlock, rl.ipRetryAfter);
          }
          if (ipSubnetForBlock && filepathHash && rl.fileAllowed === false && rl.fileRetryAfter) {
            const retry = normalizePositiveSeconds(rl.fileRetryAfter, 0);
            if (retry > 0) {
              const key = `${ipSubnetForBlock}|${filepathHash}`;
              lruPut(RL_IP_FILE_LRU, key, { untilMs: now + retry * 1000 });
            }
          }
          await slowFailDelay();
          return rateLimitResponse;
        }

        if (unifiedResult.cache.hit && Number.isFinite(unifiedResult.cache.size)) {
          sizeBytes = Number(unifiedResult.cache.size);
          cacheHit = true;
        }

        if (needPowdet) {
          const powResults = unifiedResult.powdet?.results || {};
          let powdetFailed = false;
          for (const alg of powdetRequiredAlgorithms) {
            const result = powResults && typeof powResults === 'object' ? powResults[alg] : null;
            if (!result || result.consumed === false) {
              powdetFailed = true;
              break;
            }
          }
          if (powdetFailed) {
            const now = nowMs();
            const nowSeconds = Math.floor(now / 1000);
            for (const alg of powdetRequiredAlgorithms) {
              const state = powdetChallengeStates.get(alg);
              if (!state?.challengeHash) {
                continue;
              }
              let ttlSeconds = 0;
              if (Number.isFinite(state.expireAt) && state.expireAt > nowSeconds) {
                ttlSeconds = state.expireAt - nowSeconds;
              } else {
                ttlSeconds = normalizePositiveSeconds(config.powdetExpireSeconds, 180);
              }
              if (ttlSeconds > 0) {
                const replayKey = `${alg}|${state.challengeHash}`;
                lruPut(POWDET_REPLAY_LRU, replayKey, {
                  untilMs: now + ttlSeconds * 1000,
                });
              }
            }
            await slowFailDelay();
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
        const now = nowMs();
        const ipSubnetForBlock = rateLimitResult.ipSubnet || ipSubnet || clientIP || '';
        if (ipSubnetForBlock && rateLimitResult.ipAllowed === false && rateLimitResult.ipRetryAfter) {
          markIpRangeRateLimited(ipSubnetForBlock, rateLimitResult.ipRetryAfter);
        }
        if (ipSubnetForBlock && filepathHash && rateLimitResult.fileAllowed === false && rateLimitResult.fileRetryAfter) {
          const retry = normalizePositiveSeconds(rateLimitResult.fileRetryAfter, 0);
          if (retry > 0) {
            const key = `${ipSubnetForBlock}|${filepathHash}`;
            lruPut(RL_IP_FILE_LRU, key, { untilMs: now + retry * 1000 });
          }
        }
        await slowFailDelay();
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
  if (!downloadDecision) {
    return respondJson(origin, { code: 503, message: 'controller download decision unavailable' }, 503);
  }
  let downloadURL = '';
  try {
    downloadURL = await createDownloadURL(config, request, {
      encodedPath,
      decodedPath,
      sign,
      clientIP,
      sizeBytes,
      expireTime,
      fileInfo,
      isCrypt,
      downloadDecision,
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'download url generation failed';
    const status = Number.isFinite(error?.status) ? error.status : 500;
    return respondJson(origin, { code: status, message }, status);
  }

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
  const powdetAlgorithms = Array.isArray(config?.powdetEnabledAlgorithms)
    ? config.powdetEnabledAlgorithms
    : [];
  if (powdetAlgorithms.length === 0) {
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
      const rpcUrl = `${postgrestUrl}/rpc/landing_cleanup_powdet_difficulty_state`;
      const headers = { 'Content-Type': 'application/json' };
      applyVerifyHeaders(headers, config.verifyHeader, config.verifySecret);
      for (const alg of powdetAlgorithms) {
        const algoCfg = getPowdetAlgorithmConfig(config, alg);
        if (!algoCfg?.dynamic) {
          continue;
        }
        const tableName = algoCfg.difficultyTableName || POWDET_DIFFICULTY_TABLE;
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            p_alg: alg,
            p_before: cutoffTime,
            p_table_name: tableName,
          }),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          console.error('[Powdet Dynamic] Cleanup RPC failed:', response.status, text);
        }
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
  const ipSubnet = clientIP
    ? calculateIPSubnet(clientIP, config.ipv4Suffix, config.ipv6Suffix)
    : '';

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

  let filepathHash = null;
  if (decodedPath) {
    try {
      filepathHash = await sha256Hash(decodedPath);
    } catch (error) {
      console.error('[Rate Limit] Failed to hash filepath:', error instanceof Error ? error.message : String(error));
    }
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
  const powdetRequiredAlgorithms = Array.isArray(parsedNeeds.powdetAlgorithms)
    ? parsedNeeds.powdetAlgorithms
        .map((alg) => normalizePowdetAlgorithm(alg))
        .filter((alg) => alg)
    : [];
  let needPowdet = powdetRequiredAlgorithms.length > 0;
  if (needPowdet) {
    const invalidPowdet = powdetRequiredAlgorithms.filter((alg) => {
      const algoCfg = getPowdetAlgorithmConfig(config, alg);
      return !algoCfg || !algoCfg.enabled;
    });
    if (invalidPowdet.length > 0) {
      return respondJson(origin, { code: 500, message: 'powdet algorithm unavailable' }, 500);
    }
  }

  const needsVerification = needAltcha || needTurnstile || needPowdet;
  const needWebDownloader =
    config.webDownloaderEnabled && (isCrypt || forceWebDownloader);
  const needClientDecrypt =
    config.clientDecryptEnabled && (isCrypt || forceClientDecrypt);

  const fastRedirectCandidate =
    !needWebDownloader && !needClientDecrypt &&
    (forceRedirect || (landingCtx.fastRedirect && !forceWeb && !needsVerification));
  const shouldRedirect = fastRedirectCandidate;

  if (config.rateLimitEnabled && ipSubnet) {
    const cachedIpRemaining = getIpRangeRateLimitRemaining(ipSubnet);
    if (cachedIpRemaining > 0) {
      await slowFailDelay();
      return respondRateLimitExceeded(
        origin,
        ipSubnet,
        config.ipSubnetLimit || 0,
        config.windowTime,
        cachedIpRemaining
      );
    }
    if (filepathHash) {
      const ipFileKey = `${ipSubnet}|${filepathHash}`;
      const now = nowMs();
      const cachedIpFile = lruGet(RL_IP_FILE_LRU, ipFileKey, now);
      if (cachedIpFile && cachedIpFile.untilMs && cachedIpFile.untilMs > now) {
        const remaining = Math.ceil((cachedIpFile.untilMs - now) / 1000);
        const windowLabel = config.fileWindowTime || config.windowTime;
        const limitValue = config.fileLimit || 0;
        const subject = `${ipSubnet} + ${decodedPath || '/'}`;
        await slowFailDelay();
        return respondRateLimitExceeded(origin, subject, limitValue, windowLabel, remaining);
      }
    }
  }

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
            const now = nowMs();
            const rl = unifiedResult.rateLimit || {};
            const ipSubnetForBlock = rl.ipSubnet || ipSubnet || clientIP || '';
            if (ipSubnetForBlock && rl.ipAllowed === false && rl.ipRetryAfter) {
              markIpRangeRateLimited(ipSubnetForBlock, rl.ipRetryAfter);
            }
            if (ipSubnetForBlock && filepathHash && rl.fileAllowed === false && rl.fileRetryAfter) {
              const retry = normalizePositiveSeconds(rl.fileRetryAfter, 0);
              if (retry > 0) {
                const key = `${ipSubnetForBlock}|${filepathHash}`;
                lruPut(RL_IP_FILE_LRU, key, { untilMs: now + retry * 1000 });
              }
            }
            await slowFailDelay();
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
          const now = nowMs();
          const ipSubnetForBlock = rateLimitResult.ipSubnet || ipSubnet || clientIP || '';
          if (ipSubnetForBlock && rateLimitResult.ipAllowed === false && rateLimitResult.ipRetryAfter) {
            markIpRangeRateLimited(ipSubnetForBlock, rateLimitResult.ipRetryAfter);
          }
          if (ipSubnetForBlock && filepathHash && rateLimitResult.fileAllowed === false && rateLimitResult.fileRetryAfter) {
            const retry = normalizePositiveSeconds(rateLimitResult.fileRetryAfter, 0);
            if (retry > 0) {
              const key = `${ipSubnetForBlock}|${filepathHash}`;
              lruPut(RL_IP_FILE_LRU, key, { untilMs: now + retry * 1000 });
            }
          }
          await slowFailDelay();
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
    const downloadDecision = ctx?.controllerState?.decision?.download;
    if (!downloadDecision) {
      return respondJson(origin, { code: 503, message: 'controller download decision unavailable' }, 503);
    }
    let downloadURL = '';
    try {
      downloadURL = await createDownloadURL(config, request, {
        encodedPath,
        decodedPath,
        sign,
        clientIP,
        sizeBytes,
        expireTime,
        fileInfo,
        isCrypt,
        downloadDecision,
      }, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'download url generation failed';
      const status = Number.isFinite(error?.status) ? error.status : 500;
      return respondJson(origin, { code: status, message }, status);
    }

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
  let powdetChallenges = [];
  const needsAltchaChallenge = needAltcha;
  const needsTurnstileBinding = needTurnstile && config.turnstileCookieExpireSeconds > 0;
  const needsPowdetChallenge = needPowdet;
  const shouldGenerateBindings = !shouldRedirect && (needsAltchaChallenge || needsTurnstileBinding || needsPowdetChallenge);
  const challengeLink = shouldGenerateBindings ? generateNonce(16) : '';
  if (shouldGenerateBindings && !challengeLink) {
    return respondJson(origin, { code: 500, message: 'challenge link unavailable' }, 500);
  }
  let captchaBindingStr = '';
  if (shouldGenerateBindings) {
    const downloadDecision = ctx?.controllerState?.decision?.download;
    const bindingResult = await buildCaptchaBindingStr(config, downloadDecision, request, clientIP, encodedPath);
    if (!bindingResult.ok) {
      return respondJson(
        origin,
        { code: 403, message: bindingResult.reason || 'captcha binding unavailable' },
        403
      );
    }
    captchaBindingStr = bindingResult.bindingStr;
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
      if (altchaScopeForChallenge.ipRange) {
        const now = nowMs();
        const cachedBlock = lruGet(ALTCHA_BLOCK_LRU, altchaScopeForChallenge.ipRange, now);
        if (cachedBlock && cachedBlock.untilMs && cachedBlock.untilMs > now) {
          const remaining = Math.ceil((cachedBlock.untilMs - now) / 1000);
          await slowFailDelay();
          return respondAltchaBlocked(origin, remaining);
        }
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      const state = await fetchAltchaDifficultyState(config, env, altchaScopeForChallenge.ipHash);
      const difficultyResult = getAltchaDifficultyForClient(state, nowSeconds, config.altchaDynamic);
      if (difficultyResult.blocked) {
        const retry = normalizePositiveSeconds(difficultyResult.retryAfterSeconds, 0);
        if (retry > 0 && altchaScopeForChallenge.ipRange) {
          const now = nowMs();
          lruPut(ALTCHA_BLOCK_LRU, altchaScopeForChallenge.ipRange, {
            untilMs: now + retry * 1000,
          });
        }
        await slowFailDelay();
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

  if (!shouldRedirect && needsTurnstileBinding) {
    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const ttlSeconds = Number.isFinite(config.turnstileCookieExpireSeconds)
        ? Math.floor(config.turnstileCookieExpireSeconds)
        : 0;
      if (ttlSeconds > 0) {
        const expiresAt = nowSeconds + ttlSeconds;
        const turnstileBindingExtra = { link: challengeLink };
        const binding = await buildBindingPayload(
          config.pageSecret,
          captchaBindingStr,
          expiresAt,
          'Turnstile',
          Object.keys(turnstileBindingExtra).length > 0 ? turnstileBindingExtra : null
        );
        if (binding?.bindingMac) {
          const nonce = generateNonce();
          const cdata = await buildTurnstileCData(config.pageSecret, binding.bindingMac, nonce);
          if (nonce && cdata) {
            turnstileBindingPayload = {
              bindingStr: binding.bindingStr,
              binding: binding.bindingMac,
              bindingExpiresAt: binding.expiresAt,
              nonce,
              cdata,
              link: challengeLink,
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
        captchaBindingStr,
        challengeExpiresAt,
        challenge.salt,
        challengeLink
      );
      altchaChallengePayload = {
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        signature: challenge.signature,
        maxnumber: challenge.maxnumber,
        bindingStr: challengeBinding.bindingStr,
        binding: challengeBinding.bindingMac,
        bindingExpiresAt: challengeBinding.expiresAt,
        link: challengeLink,
      };
    } catch (error) {
      console.error('[ALTCHA] Failed to create challenge:', error instanceof Error ? error.message : String(error));
    }
  }

  if (!shouldRedirect && needsPowdetChallenge) {
    try {
      const baseNowSeconds = Math.floor(Date.now() / 1000);
      const expireSeconds = Number.isFinite(config.powdetExpireSeconds) ? config.powdetExpireSeconds : 180;
      const expireAt = baseNowSeconds + expireSeconds;
      const bindingStr = captchaBindingStr;
      if (!bindingStr) {
        throw new Error('powdet binding unavailable');
      }

      for (const alg of powdetRequiredAlgorithms) {
        const algoCfg = getPowdetAlgorithmConfig(config, alg);
        if (!algoCfg?.enabled) {
          throw new Error('powdet algorithm unavailable');
        }
        let difficultyLevel = Number.isFinite(algoCfg.staticLevel) ? algoCfg.staticLevel : 12;
        if (algoCfg.dynamic && config.dbMode && powdetScopeForChallenge?.ipHash) {
          if (powdetScopeForChallenge.ipRange) {
            const now = nowMs();
            const blockKey = `${alg}|${powdetScopeForChallenge.ipRange}`;
            const cachedBlock = lruGet(POWDET_BLOCK_LRU, blockKey, now);
            if (cachedBlock && cachedBlock.untilMs && cachedBlock.untilMs > now) {
              const remaining = Math.ceil((cachedBlock.untilMs - now) / 1000);
              await slowFailDelay();
              return respondJson(origin, { code: 429, message: 'powdet blocked', retryAfter: remaining }, 429);
            }
          }
          const nowSeconds = Math.floor(Date.now() / 1000);
          const powState = await fetchPowdetDifficultyState(config, env, powdetScopeForChallenge.ipHash, alg);
          const powDifficulty = getPowdetDifficultyForClient(powState, nowSeconds, algoCfg.dynamic);
          if (powDifficulty.blocked) {
            const retry = normalizePositiveSeconds(powDifficulty.retryAfterSeconds, 0);
            if (retry > 0 && powdetScopeForChallenge.ipRange) {
              const now = nowMs();
              const blockKey = `${alg}|${powdetScopeForChallenge.ipRange}`;
              lruPut(POWDET_BLOCK_LRU, blockKey, {
                untilMs: now + retry * 1000,
              });
            }
            await slowFailDelay();
            return respondJson(origin, { code: 429, message: 'powdet blocked', retryAfter: powDifficulty.retryAfterSeconds }, 429);
          }
          difficultyLevel = powDifficulty.difficultyLevel;
          if (powdetScopeForChallenge.ipRange) {
            try {
              await updatePowdetDifficultyState(config, env, powdetScopeForChallenge, nowSeconds, alg);
            } catch (error) {
              console.error('[Powdet Dynamic] Difficulty update failed in handleFileRequest:', error instanceof Error ? error.message : String(error));
            }
          }
        }

        const randomStr = generateNonce(32);
        const challenge = await fetchPowdetChallenge(config, alg, difficultyLevel);
        const bindingPayload = {
          alg,
          bindingStr,
          expireAt,
          randomStr,
          challenge,
          link: challengeLink,
        };
        const hmac = await computePowdetHmac(config, bindingPayload);
        let staticBase = algoCfg.staticBaseUrl;
        if (!staticBase) {
          if (config.powdetStaticBaseUrl) {
            staticBase = config.powdetStaticBaseUrl.replace(/\/+$/, '');
          } else if (config.powdetBaseUrl) {
            staticBase = `${config.powdetBaseUrl.replace(/\/+$/, '')}/powdet/static`;
          } else {
            staticBase = '/powdet/static';
          }
        }
        powdetChallenges.push({
          alg,
          challenge,
          expireAt,
          randomStr,
          hmac,
          link: challengeLink,
          staticBase,
        });
      }
    } catch (error) {
      console.error('[Powdet] Failed to create challenge:', error instanceof Error ? error.message : String(error));
      return respondJson(origin, { code: 500, message: 'powdet challenge unavailable' }, 500);
    }
  }

  return renderLandingPage(url.pathname, {
    glueUrl: config.frontendGlueUrl,
    htmlUrl: config.frontendHtmlUrl,
    commonCss: config.frontendCommonCssUrl,
    themeCss: { minimal: config.frontendThemeCssUrl },
    underAttack: needTurnstile,
    turnstileSiteKey: config.turnstileSiteKey,
    turnstileAction: config.turnstileExpectedAction,
    altchaChallenge: altchaChallengePayload,
    turnstileBinding: turnstileBindingPayload,
    powdetChallenges,
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
  return handleFileRequest(request, env, config, rateLimiter, ctx);
};

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname || '/';

      const isInternalPath = pathname.startsWith('/api/v0/');
      if (isInternalPath) {
        const internalResponse = await handleInternalApiIfAny(request, env, ctx);
        if (internalResponse) {
          return internalResponse;
        }
      }

      const innerAuthSecret = typeof env?.INNER_AUTH_SECRET === 'string' ? env.INNER_AUTH_SECRET.trim() : '';
      if (innerAuthSecret) {
        const headerNameRaw = typeof env?.INNER_AUTH_HEADER === 'string' ? env.INNER_AUTH_HEADER.trim() : '';
        const headerName = headerNameRaw || 'X-Inner-Auth';
        const provided = request.headers.get(headerName) || '';
        if (provided !== innerAuthSecret) {
          return new Response('Forbidden', { status: 403 });
        }
      }

      const isInfoPath = pathname === '/info';

      if (isInfoPath && request.method !== 'GET') {
        const origin = request.headers.get('origin') || '*';
        return respondJson(origin, { code: 405, message: 'method not allowed' }, 405);
      }

      let filepathOverride = null;
      if (isInfoPath) {
        const rawPath = url.searchParams.get('path');
        if (!rawPath) {
          const origin = request.headers.get('origin') || '*';
          return respondJson(origin, { code: 400, message: 'path is required' }, 400);
        }
        try {
          const decodedPath = decodeURIComponent(rawPath);
          filepathOverride = decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`;
        } catch {
          const origin = request.headers.get('origin') || '*';
          return respondJson(origin, { code: 400, message: 'invalid path encoding' }, 400);
        }
      }

      let controllerState = null;
      try {
        controllerState = await fetchControllerState(request, env, filepathOverride ? { filepathOverride } : undefined);
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

      const requestOrigin = url.origin;
      if (!config.landingWorkerAddresses.includes(requestOrigin)) {
        const origin = request.headers.get('origin') || '*';
        return respondJson(origin, { code: 403, message: 'prohibited source' }, 403);
      }

      if (isInfoPath) {
        const ipv4Error = ensureIPv4(request, config.ipv4Only);
        if (ipv4Error) return ipv4Error;
        return handleInfo(request, env, config, rateLimiter, ctx);
      }

      return await routeRequest(request, env, config, rateLimiter, ctx);
    } catch (error) {
      const origin = request.headers.get('origin') || '*';
      const message = error instanceof Error ? error.message : String(error);
      return respondJson(origin, { code: 500, message }, 500);
    }
  },
};
