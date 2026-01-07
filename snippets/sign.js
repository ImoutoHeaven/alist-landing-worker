// Cloudflare Snippet: sign/auth (business semantics)
// Must be placed *after* the PoW snippet in Cloudflare Snippets order.

const DEFAULTS = {
  enableInfoEndpoint: false,
  stripDownloadPrefix: false,
};

const CONFIG = [
  // Example:
  // { pattern: "alist-landing-*.example.com/**", config: { HMAC_SECRET: "replace-with-common-tokenHmacKey", stripDownloadPrefix: true } },
  // { pattern: "alist-landing-*.example.com/info", config: { HMAC_SECRET: "replace-with-common-tokenHmacKey", enableInfoEndpoint: true } },
];

const splitPattern = (pattern) => {
  if (typeof pattern !== "string") return null;
  const trimmed = pattern.trim();
  if (!trimmed) return null;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1) return { host: trimmed, path: null };
  const host = trimmed.slice(0, slashIndex);
  if (!host) return null;
  return { host, path: trimmed.slice(slashIndex) };
};

const escapeRegex = (value) => value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

const compileHostPattern = (pattern) => {
  if (typeof pattern !== "string") return null;
  const host = pattern.trim().toLowerCase();
  if (!host) return null;
  const escaped = escapeRegex(host).replace(/\*/g, "[^.]*");
  try {
    return new RegExp(`^${escaped}$`);
  } catch {
    return null;
  }
};

const compilePathPattern = (pattern) => {
  if (typeof pattern !== "string") return null;
  const path = pattern.trim();
  if (!path.startsWith("/")) return null;
  let out = "";
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === "*") {
      if (path[i + 1] === "*") {
        const isLast = i + 2 >= path.length;
        const prevIsSlash = i > 0 && path[i - 1] === "/";
        if (isLast && prevIsSlash && out.endsWith("/") && out.length > 1) {
          out = `${out.slice(0, -1)}(?:/.*)?`;
        } else {
          out += ".*";
        }
        i++;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += /[.+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return null;
  }
};

const compileConfigEntry = (entry) => {
  const pattern = entry && entry.pattern;
  const parts = splitPattern(pattern);
  if (!parts) {
    return { pattern, hostRegex: null, pathRegex: null, config: (entry && entry.config) || {} };
  }
  const hostRegex = compileHostPattern(parts.host);
  if (!hostRegex) {
    return { pattern, hostRegex: null, pathRegex: null, config: (entry && entry.config) || {} };
  }
  const pathRegex = parts.path ? compilePathPattern(parts.path) : null;
  if (parts.path && !pathRegex) {
    return { pattern, hostRegex: null, pathRegex: null, config: (entry && entry.config) || {} };
  }
  return { pattern, hostRegex, pathRegex, config: (entry && entry.config) || {} };
};

const COMPILED_CONFIG = CONFIG.map(compileConfigEntry);

const pickConfigWithId = (hostname, path) => {
  const host = typeof hostname === "string" ? hostname.toLowerCase() : "";
  const requestPath = typeof path === "string" ? path : "";
  if (!host) return null;
  for (let i = 0; i < COMPILED_CONFIG.length; i++) {
    const rule = COMPILED_CONFIG[i];
    if (!rule || !rule.hostRegex) continue;
    if (!rule.hostRegex.test(host)) continue;
    if (rule.pathRegex && !rule.pathRegex.test(requestPath)) continue;
    return { cfgId: i, config: rule.config || null };
  }
  return null;
};

const encoder = new TextEncoder();
const hmacKeyCache = new Map();

const getHmacKey = (secret) => {
  const key = typeof secret === "string" ? secret : "";
  if (!key) {
    return Promise.reject(new Error("HMAC secret missing"));
  }
  if (!hmacKeyCache.has(key)) {
    hmacKeyCache.set(
      key,
      crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
      ])
    );
  }
  return hmacKeyCache.get(key);
};

const base64UrlEncode = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");

const hmacSha256 = async (secret, data) => {
  const key = await getHmacKey(secret);
  const payload = encoder.encode(data);
  const buf = await crypto.subtle.sign("HMAC", key, payload);
  return new Uint8Array(buf);
};

const hmacSha256Sign = async (secret, data, expire) => {
  const payload = `${data}:${expire}`;
  const bytes = await hmacSha256(secret, payload);
  return `${base64UrlEncode(bytes)}:${expire}`;
};

const normalizePath = (pathname) => {
  if (typeof pathname !== "string") return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.length === 0) return "/";
  return decoded.startsWith("/") ? decoded : `/${decoded}`;
};

const normalizeDecodedPath = (pathname) => {
  if (typeof pathname !== "string") return null;
  if (pathname.length === 0) return "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
};

const stripDownloadPrefix = (pathname) => {
  if (typeof pathname !== "string") return pathname;
  if (pathname === "/d" || pathname === "/p") return "/";
  if (pathname.startsWith("/d/") || pathname.startsWith("/p/")) {
    const stripped = pathname.slice(2);
    return stripped || "/";
  }
  return pathname;
};

const decodePathParam = (value) => {
  if (typeof value !== "string") return null;
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  return decoded;
};

const parseSignature = (sig) => {
  if (!sig || typeof sig !== "string") return null;
  const idx = sig.lastIndexOf(":");
  if (idx <= 0 || idx === sig.length - 1) return null;
  const expire = Number.parseInt(sig.slice(idx + 1), 10);
  if (Number.isNaN(expire)) return null;
  return { expire };
};

const isExpired = (expire, nowSeconds) => expire > 0 && expire < nowSeconds;

const safeHeaders = (origin) => {
  const headers = new Headers();
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.append("Vary", "Origin");
  } else {
    headers.set("Access-Control-Allow-Origin", "*");
  }
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS,POST");
  return headers;
};

const respondText = (origin, msg, status = 200) => {
  const headers = safeHeaders(origin);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(msg, { status, headers });
};

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const hostname = url.hostname;

    const nowSeconds = Math.floor(Date.now() / 1000);

    const requestPath = normalizePath(url.pathname);
    if (!requestPath) return respondText(origin, "invalid path", 400);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: safeHeaders(origin) });
    }

    const isInfoPath = requestPath === "/info";
    let authPath = requestPath;
    let matchPath = requestPath;

    let selected = pickConfigWithId(hostname, matchPath);
    let config = selected ? { ...DEFAULTS, ...selected.config } : null;
    if (!config) return respondText(origin, "misconfigured", 500);

    if (isInfoPath && config.enableInfoEndpoint === true) {
      const rawPath = url.searchParams.get("path");
      if (!rawPath) return respondText(origin, "path is required", 400);
      const decoded = decodePathParam(rawPath);
      if (!decoded) return respondText(origin, "invalid path encoding", 400);
      const canonical = normalizeDecodedPath(decoded);
      if (!canonical) return respondText(origin, "invalid path", 400);

      authPath = canonical;
      matchPath = canonical;

      selected = pickConfigWithId(hostname, matchPath);
      config = selected ? { ...DEFAULTS, ...selected.config } : null;
      if (!config) return respondText(origin, "misconfigured", 500);
    }

    if (!isInfoPath && config.stripDownloadPrefix === true) {
      authPath = stripDownloadPrefix(authPath);
    }

    const signSecret = typeof config.HMAC_SECRET === "string" ? config.HMAC_SECRET : "";
    if (signSecret) {
      const sign = url.searchParams.get("sign") || "";
      const signMeta = parseSignature(sign);
      if (!signMeta) return respondText(origin, "sign invalid", 401);
      if (isExpired(signMeta.expire, nowSeconds)) return respondText(origin, "sign expired", 401);

      const expected = await hmacSha256Sign(signSecret, authPath, signMeta.expire);
      if (expected !== sign) return respondText(origin, "sign mismatch", 401);
    }

    return fetch(request);
  },
};
