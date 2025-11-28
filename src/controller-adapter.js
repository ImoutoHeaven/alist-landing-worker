import { getBootstrapConfig, getDecisionForRequest } from './controller-client.js';
import { getClientIp } from './origin-binding.js';

const hasControllerBase = (env) =>
  !!(env?.CONTROLLER_URL && env?.CONTROLLER_API_TOKEN && env?.ENV && env?.ROLE && env?.INSTANCE_ID);

const canUseBootstrap = (env) => {
  const mode = env?.BOOTSTRAP_CACHE_MODE || 'do+kv';
  if (mode === 'direct') return true;
  if (mode === 'd1') return !!env?.CACHE_D1;
  return !!env?.BOOTSTRAP_DO;
};

const normalizePath = (pathname) => {
  if (typeof pathname !== 'string') {
    return '/';
  }
  try {
    const decoded = decodeURIComponent(pathname);
    if (!decoded) return '/';
    return decoded.startsWith('/') ? decoded : `/${decoded}`;
  } catch {
    return pathname.startsWith('/') ? pathname : `/${pathname}`;
  }
};

const globToRegex = (pattern) => {
  const escaped = pattern
    .replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
    .replace(/\*\*/g, '::GLOBSTAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::GLOBSTAR::/g, '.*');
  return new RegExp(`^${escaped}$`);
};

const matchPattern = (pattern, filepath) => {
  if (!pattern || typeof pattern !== 'string') return false;
  const regex = globToRegex(pattern);
  return regex.test(filepath);
};

const pathHasPrefix = (path, prefixes) => {
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    return true;
  }
  return prefixes.some((prefix) => typeof prefix === 'string' && path.startsWith(prefix));
};

const pathContainsAnyDir = (path, includes) => {
  if (!Array.isArray(includes) || includes.length === 0) {
    return true;
  }
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return false;
  const parts = trimmed.split('/');
  if (parts.length <= 1) return false;
  const dirs = parts.slice(0, -1);
  return dirs.some((dir) => includes.some((inc) => typeof inc === 'string' && dir.includes(inc)));
};

const pathContainsAnyName = (path, includes) => {
  if (!Array.isArray(includes) || includes.length === 0) {
    return true;
  }
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return false;
  const parts = trimmed.split('/');
  const name = parts[parts.length - 1];
  return includes.some((inc) => typeof inc === 'string' && name.includes(inc));
};

const pathContainsAny = (path, includes) => {
  if (!Array.isArray(includes) || includes.length === 0) {
    return true;
  }
  return includes.some((inc) => typeof inc === 'string' && path.includes(inc));
};

const ruleMatches = (rule, filepath) => {
  if (!rule) return false;
  const hasLegacyFields =
    (Array.isArray(rule.prefix) && rule.prefix.length > 0)
    || (Array.isArray(rule.dirIncludes) && rule.dirIncludes.length > 0)
    || (Array.isArray(rule.nameIncludes) && rule.nameIncludes.length > 0)
    || (Array.isArray(rule.pathIncludes) && rule.pathIncludes.length > 0);

  if (hasLegacyFields) {
    // Controller-overhaul no longer emits legacy prefix/includes; keep parsing only
    // to tolerate stale bootstrap payloads.
    return (
      pathHasPrefix(filepath, rule.prefix)
      && pathContainsAnyDir(filepath, rule.dirIncludes)
      && pathContainsAnyName(filepath, rule.nameIncludes)
      && pathContainsAny(filepath, rule.pathIncludes)
    );
  }

  if (typeof rule.pattern === 'string' && rule.pattern.length > 0) {
    return matchPattern(rule.pattern, filepath);
  }

  return false;
};

const matchPathRule = (pathRules, filepath) => {
  if (!Array.isArray(pathRules) || pathRules.length === 0) {
    return null;
  }
  let best = null;
  for (const rule of pathRules) {
    if (!rule || typeof rule.profileId !== 'string') {
      continue;
    }
    if (!ruleMatches(rule, filepath)) {
      continue;
    }
    if (!best) {
      best = rule;
      continue;
    }
    const currentPriority = Number.isFinite(rule.priority) ? rule.priority : 0;
    const bestPriority = Number.isFinite(best.priority) ? best.priority : 0;
    if (currentPriority > bestPriority) {
      best = rule;
    }
  }
  return best;
};

const buildDecisionContext = (request) => {
  const url = new URL(request.url);
  const cf = request.cf || {};

  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    ip: getClientIp(request) || '',
    asn: Number.parseInt(cf.asn, 10) || 0,
    country: cf.country || '',
    continent: cf.continent || '',
    userAgent: request.headers.get('user-agent') || '',
    method: request.method || 'GET',
    host: url.host || '',
    path: url.pathname || '/',
    query: url.search ? url.search.slice(1) : '',
    referer: request.headers.get('referer'),
    headers,
  };
};

const findProfileById = (profiles, profileId) => {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return null;
  }
  const target = (profileId || '').trim();
  if (!target) {
    return profiles[0] || null;
  }
  for (const profile of profiles) {
    if (profile && typeof profile.id === 'string' && profile.id === target) {
      return profile;
    }
  }
  return profiles[0] || null;
};

const normalizeStringArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
  }
  return [];
};

const pickString = (value, fallback = '') => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return fallback;
};

const buildStaticLandingDecision = (profile, bootstrap) => {
  const actions = profile?.actions || {};
  const landingBootstrap = bootstrap?.landing || {};
  const defaultCombo = Array.isArray(landingBootstrap?.captcha?.defaultCombo)
    ? landingBootstrap.captcha.defaultCombo
    : ['verify-altcha'];

  const captchaCombo = normalizeStringArray(actions.captchaCombo);
  const fastRedirect = typeof actions.fastRedirect === 'boolean'
    ? actions.fastRedirect
    : Boolean(landingBootstrap.fastRedirect);
  const autoRedirect = typeof actions.autoRedirect === 'boolean'
    ? actions.autoRedirect
    : Boolean(landingBootstrap.autoRedirect);
  const blockReason = pickString(actions.blockReason, '');

  return {
    captchaCombo: captchaCombo.length > 0 ? captchaCombo : defaultCombo,
    fastRedirect,
    autoRedirect,
    blockReason: blockReason || undefined,
  };
};

const mergeLandingDecision = (base, dynamic) => {
  if (!dynamic || typeof dynamic !== 'object') {
    return base;
  }
  const merged = { ...base };
  if (Array.isArray(dynamic.captchaCombo) && dynamic.captchaCombo.length > 0) {
    merged.captchaCombo = dynamic.captchaCombo;
  }
  if (typeof dynamic.fastRedirect === 'boolean') {
    merged.fastRedirect = dynamic.fastRedirect;
  }
  if (typeof dynamic.autoRedirect === 'boolean') {
    merged.autoRedirect = dynamic.autoRedirect;
  }
  if (dynamic.blockReason) {
    merged.blockReason = dynamic.blockReason;
  }
  return merged;
};

/**
 * Fetch bootstrap and decision for the given request.
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{ filepathOverride?: string }} [options]
 */
export async function fetchControllerState(request, env, options = {}) {
  if (!hasControllerBase(env) || !canUseBootstrap(env)) {
    return null;
  }

  try {
    const bootstrap = await getBootstrapConfig(env);
    const ctx = buildDecisionContext(request);
    const effectivePath = options.filepathOverride ? normalizePath(options.filepathOverride) : normalizePath(ctx.path || '/');
    ctx.path = effectivePath;
    const filepath = effectivePath;
    const rule = matchPathRule(bootstrap?.pathRules || [], filepath);
    const defaultProfileId = pickString(bootstrap?.global?.defaultProfileId, 'default');
    const profileId = pickString(rule?.profileId, defaultProfileId);
    const profile = findProfileById(bootstrap?.pathProfiles || [], profileId);
    if (!profile) {
      return null;
    }

    let decisionPayload = null;
    if (profile.dynamic) {
      decisionPayload = await getDecisionForRequest(env, {
        role: env.ROLE,
        env: env.ENV,
        instance_id: env.INSTANCE_ID,
        profileId: profile.id,
        filepath,
        request: ctx,
        bootstrapVersion: bootstrap?.configVersion,
      });
    }

    const staticDecision = buildStaticLandingDecision(profile, bootstrap);
    const effectiveDecision = mergeLandingDecision(staticDecision, decisionPayload?.landing);

    return {
      bootstrap,
      decision: { landing: effectiveDecision },
      ctx,
      profileId: profile.id,
      pathRule: rule,
    };
  } catch (error) {
    console.error('[controller] fetch failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}
