// Cloudflare Snippet: sign/auth (business semantics)
// Must be placed *after* the PoW snippet in Cloudflare Snippets order.

const DEFAULTS = {
  enableInfoEndpoint: false,
  stripDownloadPrefix: false,
  captchaPrecheck: false,
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
const decoder = new TextDecoder();
const hmacKeyCache = new Map();
const VALID_ORIGIN_MODES = new Set([
  "ip",
  "iprange",
  "continent",
  "country",
  "region",
  "city",
  "asn",
  "tls",
  "path",
]);

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

const base64UrlEncodeNoPad = (bytes) => base64UrlEncode(bytes).replace(/=+$/u, "");

const base64UrlDecodeToBytes = (value) => {
  if (typeof value !== "string" || !value) return null;
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const mod = normalized.length % 4;
  if (mod === 1) return null;
  if (mod > 0) normalized = normalized.padEnd(normalized.length + (4 - mod), "=");
  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
};

const base64UrlDecodeToString = (value) => {
  const bytes = base64UrlDecodeToBytes(value);
  if (!bytes) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
};

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

const hmacSha256Hex = async (secret, data) => {
  const bytes = await hmacSha256(secret, data);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
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

const normalizeHeaderValue = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value && value.trim() ? value.trim() : null;
  }
  return null;
};

const getClientIp = (request) => {
  if (!request || typeof request !== "object") return "";
  const ip = normalizeHeaderValue(request.headers, "CF-Connecting-IP");
  return ip || "";
};

const parseCheckOriginEnv = (rawValue) => {
  if (typeof rawValue !== "string") return [];
  const trimmed = rawValue.trim();
  if (!trimmed) return [];
  const modes = [];
  trimmed.split(",").forEach((part) => {
    const normalized = part.trim().toLowerCase();
    if (!normalized) return;
    if (VALID_ORIGIN_MODES.has(normalized)) {
      modes.push(normalized);
    } else {
      console.warn(`[origin-binding] Unknown CHECK_ORIGIN field "${part}" ignored`);
    }
  });
  return modes;
};

const normalizeRegionValue = (mode, value) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const str = String(value).trim();
  if (!str) return null;
  if (mode === "country" || mode === "continent") {
    return str.toUpperCase();
  }
  return str.toLowerCase();
};

const normalizeAsnValue = (value) => {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str ? str : null;
};

const normalizeBindingConfig = (bindingConfig) => {
  const cfg = bindingConfig && typeof bindingConfig === "object" ? bindingConfig : {};
  const version = Number.isFinite(cfg.version) && cfg.version > 0 ? Math.trunc(cfg.version) : 1;
  const ipv4Suffix =
    typeof cfg.ipv4Suffix === "string" && cfg.ipv4Suffix.trim() ? cfg.ipv4Suffix.trim() : "/32";
  const ipv6Suffix =
    typeof cfg.ipv6Suffix === "string" && cfg.ipv6Suffix.trim() ? cfg.ipv6Suffix.trim() : "/60";
  const bindTls = cfg.bindTls !== false;
  return { version, ipv4Suffix, ipv6Suffix, bindTls };
};

const calculateIPSubnet = (ip, ipv4Suffix, ipv6Suffix) => {
  if (!ip || typeof ip !== "string") return "";
  const trimmedIP = ip.trim();
  if (!trimmedIP) return "";

  let processingIP = trimmedIP;
  const lowerIP = trimmedIP.toLowerCase();
  if (lowerIP.startsWith("::ffff:") && lowerIP.includes(".")) {
    processingIP = trimmedIP.substring(7);
  }

  if (processingIP.includes(":") && !processingIP.includes(".")) {
    const suffix = ipv6Suffix || "/60";
    const prefixLength = Number.parseInt(suffix.replace("/", ""), 10);
    if (Number.isNaN(prefixLength) || prefixLength < 0 || prefixLength > 128) {
      return `${processingIP}${suffix}`;
    }

    try {
      const parts = processingIP.split("::");
      if (parts.length > 2) {
        return `${processingIP}${suffix}`;
      }
      const left = parts[0] ? parts[0].split(":").filter(Boolean) : [];
      const right = parts.length === 2 && parts[1] ? parts[1].split(":").filter(Boolean) : [];
      if (left.length + right.length > 8) {
        return `${processingIP}${suffix}`;
      }
      const full = [...left, ...Array(8 - (left.length + right.length)).fill("0"), ...right];
      const expanded = full.map((h) => Number.parseInt(h, 16) || 0);

      const bitsPerGroup = 16;
      const fullGroups = Math.floor(prefixLength / bitsPerGroup);
      const remainingBits = prefixLength % bitsPerGroup;

      for (let i = fullGroups; i < 8; i += 1) {
        if (i === fullGroups && remainingBits > 0) {
          const mask = (0xffff << (bitsPerGroup - remainingBits)) & 0xffff;
          expanded[i] = (expanded[i] || 0) & mask;
        } else {
          expanded[i] = 0;
        }
      }

      const hex = expanded.map((n) => (n || 0).toString(16));
      return `${hex.join(":")}${suffix}`;
    } catch {
      return `${processingIP}${suffix}`;
    }
  } else {
    const suffix = ipv4Suffix || "/32";
    const prefixLength = Number.parseInt(suffix.replace("/", ""), 10);
    if (Number.isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
      return `${processingIP}${suffix}`;
    }

    try {
      const octets = processingIP.split(".").map((o) => Number.parseInt(o, 10));
      if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
        return `${processingIP}${suffix}`;
      }

      let ipInt = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3];
      const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
      ipInt = (ipInt & mask) >>> 0;

      const subnetOctets = [
        (ipInt >>> 24) & 0xff,
        (ipInt >>> 16) & 0xff,
        (ipInt >>> 8) & 0xff,
        ipInt & 0xff,
      ];

      return `${subnetOctets.join(".")}${suffix}`;
    } catch {
      return `${processingIP}${suffix}`;
    }
  }
};

const sha256Hash = async (text) => {
  if (!text || typeof text !== "string") return "";
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
};

const buildBindingStr = async ({ modes, path, cf, clientIP, bindingConfig, token }) => {
  const modeList = Array.isArray(modes) ? modes : [];
  const modeSet = new Set(modeList);
  const cfg = normalizeBindingConfig(bindingConfig);
  const fail = (reason) => ({ ok: false, reason });

  if (typeof token !== "string" || !token) {
    return fail("binding token missing");
  }

  let pathHash = "any";
  if (modeSet.has("path")) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      return fail("binding path missing");
    }
    pathHash = await sha256Hash(normalizedPath);
    if (!pathHash) {
      return fail("binding path hash missing");
    }
  }

  const ipValue = typeof clientIP === "string" ? clientIP.trim() : "";
  let ipScope = "any";
  if (modeSet.has("ip")) {
    if (!ipValue) {
      return fail("binding ip missing");
    }
    ipScope = ipValue;
  } else if (modeSet.has("iprange")) {
    if (!ipValue) {
      return fail("binding ip missing");
    }
    const subnet = calculateIPSubnet(ipValue, cfg.ipv4Suffix, cfg.ipv6Suffix);
    if (!subnet) {
      return fail("binding iprange missing");
    }
    ipScope = subnet;
  }

  const safeCf = cf && typeof cf === "object" ? cf : {};

  let country = "any";
  if (modeSet.has("country")) {
    country = normalizeRegionValue("country", safeCf.country);
    if (!country) {
      return fail("binding country missing");
    }
  }

  let continent = "any";
  if (modeSet.has("continent")) {
    continent = normalizeRegionValue("continent", safeCf.continent);
    if (!continent) {
      return fail("binding continent missing");
    }
  }

  let region = "any";
  if (modeSet.has("region")) {
    region = normalizeRegionValue("region", safeCf.region);
    if (!region) {
      return fail("binding region missing");
    }
  }

  let city = "any";
  if (modeSet.has("city")) {
    city = normalizeRegionValue("city", safeCf.city);
    if (!city) {
      return fail("binding city missing");
    }
  }

  let asn = "any";
  if (modeSet.has("asn")) {
    asn = normalizeAsnValue(safeCf.asn);
    if (!asn) {
      return fail("binding asn missing");
    }
  }

  let tlsHash = "any";
  const wantsTls = modeSet.has("tls") && cfg.bindTls;
  if (wantsTls) {
    const tlsExtensions =
      typeof safeCf.tlsClientExtensionsSha1 === "string" ? safeCf.tlsClientExtensionsSha1.trim() : "";
    const tlsCiphers =
      typeof safeCf.tlsClientCiphersSha1 === "string" ? safeCf.tlsClientCiphersSha1.trim() : "";
    if (!tlsExtensions || !tlsCiphers) {
      return fail("binding tls missing");
    }
    tlsHash = await sha256Hash(`${tlsExtensions}|${tlsCiphers}`);
    if (!tlsHash) {
      return fail("binding tls hash missing");
    }
  }

  const canonical = [
    `v${cfg.version}`,
    pathHash || "any",
    ipScope || "any",
    country || "any",
    continent || "any",
    region || "any",
    city || "any",
    asn || "any",
    tlsHash || "any",
  ].join("|");

  try {
    const macBytes = await hmacSha256(token, canonical);
    const bindingStr = base64UrlEncodeNoPad(macBytes);
    return { ok: true, bindingStr };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "binding hmac failed");
  }
};

const normalizeLinkValue = (value) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed ? trimmed : "";
};

const parseEpochSeconds = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

const computeBindingMac = async (secret, payload) => {
  const macBytes = await hmacSha256(secret, JSON.stringify(payload));
  return base64UrlEncode(macBytes);
};

const computeTurnstileCData = async (secret, bindingMac, nonce) => {
  const macBytes = await hmacSha256(secret, `${bindingMac}:${nonce}`);
  return base64UrlEncodeNoPad(macBytes);
};

const parseJsonBase64Url = (value) => {
  const decoded = base64UrlDecodeToString(value);
  if (!decoded) return null;
  try {
    return JSON.parse(decoded);
  } catch {
    return null;
  }
};

const precheckCaptcha = async (request, url, config, bindingPathInput, nowSeconds, origin) => {
  if (!config || config.captchaPrecheck !== true) {
    return null;
  }
  const rawTurnstileBinding =
    request.headers.get("x-turnstile-binding") ||
    url.searchParams.get("x-turnstile-binding") ||
    url.searchParams.get("turnstile_binding") ||
    "";
  const altChallengeResultParam = url.searchParams.get("altChallengeResult") || "";
  const powdetSolutionsParam = url.searchParams.get("powdetSolutions") || "";

  if (!rawTurnstileBinding && !altChallengeResultParam && !powdetSolutionsParam) {
    return null;
  }

  const pageSecret = typeof config.PAGE_SECRET === "string" ? config.PAGE_SECRET : "";
  const tokenHmacKey = typeof config.TOKEN_HMAC_KEY === "string" ? config.TOKEN_HMAC_KEY : "";
  const rawCaptchaBinding =
    config.CAPTCHA_BINDING && typeof config.CAPTCHA_BINDING === "object"
      ? config.CAPTCHA_BINDING
      : config.captchaBinding && typeof config.captchaBinding === "object"
      ? config.captchaBinding
      : null;

  let turnstileLink = null;
  let altchaLink = null;
  let powdetLink = null;

  if (rawTurnstileBinding) {
    if (!pageSecret) return respondText(origin, "misconfigured", 500);
    const payload = parseJsonBase64Url(rawTurnstileBinding);
    if (!payload || typeof payload !== "object") {
      return respondText(origin, "invalid turnstile binding format", 400);
    }
    const bindingStr = typeof payload.bindingStr === "string" ? payload.bindingStr : "";
    const bindingMac = typeof payload.binding === "string" ? payload.binding : "";
    const rawExpires = payload.bindingExpiresAt ?? payload.expiresAt;
    const bindingExpiresAt = parseEpochSeconds(rawExpires);
    const nonce = typeof payload.nonce === "string" ? payload.nonce.replace(/=+$/u, "") : "";
    const cdata = typeof payload.cdata === "string" ? payload.cdata.replace(/=+$/u, "") : "";
    const link = normalizeLinkValue(payload.link);

    if (!bindingStr || !bindingMac || !bindingExpiresAt) {
      return respondText(origin, "turnstile binding missing", 403);
    }
    if (!nonce || !cdata) {
      return respondText(origin, "turnstile binding missing", 403);
    }
    if (!link) {
      return respondText(origin, "turnstile binding missing link", 403);
    }
    if (bindingExpiresAt <= nowSeconds) {
      return respondText(origin, "turnstile binding expired", 403);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(nonce)) {
      return respondText(origin, "turnstile binding nonce invalid", 403);
    }
    const expectedBindingMac = await computeBindingMac(pageSecret, {
      bindingStr,
      expiresAt: bindingExpiresAt,
      link,
    });
    if (expectedBindingMac !== bindingMac) {
      return respondText(origin, "turnstile binding mismatch", 403);
    }
    const expectedCData = await computeTurnstileCData(pageSecret, expectedBindingMac, nonce);
    if (!expectedCData || expectedCData !== cdata) {
      return respondText(origin, "turnstile binding mismatch", 403);
    }
    turnstileLink = link;
  }

  if (altChallengeResultParam) {
    if (!pageSecret) return respondText(origin, "misconfigured", 500);
    const payload = parseJsonBase64Url(altChallengeResultParam);
    if (!payload || typeof payload !== "object") {
      return respondText(origin, "invalid altChallengeResult format", 400);
    }
    const bindingStr = typeof payload.bindingStr === "string" ? payload.bindingStr : "";
    const bindingMac = typeof payload.binding === "string" ? payload.binding : "";
    const bindingExpiresAt = parseEpochSeconds(payload.bindingExpiresAt ?? payload.expiresAt);
    const salt = typeof payload.salt === "string" ? payload.salt : "";
    const link = normalizeLinkValue(payload.link);

    if (!bindingStr || !bindingMac || !bindingExpiresAt) {
      return respondText(origin, "altcha binding missing", 403);
    }
    if (!salt) {
      return respondText(origin, "altcha binding missing salt", 403);
    }
    if (!link) {
      return respondText(origin, "altcha binding missing link", 403);
    }
    if (bindingExpiresAt <= nowSeconds) {
      return respondText(origin, "altcha binding expired", 403);
    }
    const expectedBindingMac = await computeBindingMac(pageSecret, {
      bindingStr,
      expiresAt: bindingExpiresAt,
      salt,
      link,
    });
    if (expectedBindingMac !== bindingMac) {
      return respondText(origin, "altcha binding mismatch", 403);
    }
    altchaLink = link;
  }

  if (powdetSolutionsParam) {
    if (!tokenHmacKey) return respondText(origin, "misconfigured", 500);
    if (!rawCaptchaBinding) return respondText(origin, "misconfigured", 500);
    const bindingModes = parseCheckOriginEnv(rawCaptchaBinding.defaultModes || "");
    if (bindingModes.length === 0) return respondText(origin, "misconfigured", 500);
    const bindingResult = await buildBindingStr({
      modes: bindingModes,
      path: bindingPathInput,
      cf: request.cf,
      clientIP: getClientIp(request),
      bindingConfig: rawCaptchaBinding,
      token: tokenHmacKey,
    });
    if (!bindingResult.ok) {
      return respondText(origin, bindingResult.reason || "powdet binding unavailable", 403);
    }
    const bindingStr = bindingResult.bindingStr;
    const parsed = parseJsonBase64Url(powdetSolutionsParam);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return respondText(origin, "invalid powdetSolutions format", 400);
    }
    let powdetLinkValue = "";
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        return respondText(origin, "powdet solutions invalid", 403);
      }
      const alg = typeof item.alg === "string" ? item.alg.trim() : "";
      const challenge = typeof item.challenge === "string" ? item.challenge : "";
      const nonce = typeof item.nonce === "string" ? item.nonce : "";
      const randomStr = typeof item.randomStr === "string" ? item.randomStr : "";
      const hmac = typeof item.hmac === "string" ? item.hmac : "";
      const link = normalizeLinkValue(item.link);
      const expireAt = parseEpochSeconds(item.expireAt ?? item.expiresAt);
      if (!alg || !challenge || !nonce || !randomStr || !hmac || !expireAt) {
        return respondText(origin, "powdet payload missing", 403);
      }
      if (!link) {
        return respondText(origin, "powdet link missing", 403);
      }
      if (!powdetLinkValue) {
        powdetLinkValue = link;
      } else if (powdetLinkValue !== link) {
        return respondText(origin, "powdet link mismatch", 403);
      }
      const bindingPayload = {
        alg,
        bindingStr,
        expireAt,
        randomStr,
        challenge,
        link,
      };
      const expectedHmac = await hmacSha256Hex(tokenHmacKey, JSON.stringify(bindingPayload));
      if (expectedHmac !== hmac) {
        return respondText(origin, "powdet binding mismatch", 403);
      }
    }
    powdetLink = powdetLinkValue;
  }

  const linkCandidates = [];
  if (turnstileLink !== null) linkCandidates.push(turnstileLink);
  if (altchaLink !== null) linkCandidates.push(altchaLink);
  if (powdetLink !== null) linkCandidates.push(powdetLink);
  if (linkCandidates.length >= 2) {
    if (linkCandidates.some((value) => !value)) {
      return respondText(origin, "challenge link missing", 403);
    }
    const base = linkCandidates[0];
    if (linkCandidates.some((value) => value !== base)) {
      return respondText(origin, "challenge link mismatch", 403);
    }
  }

  return null;
};

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
    let bindingPathInput = url.pathname;

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
      bindingPathInput = rawPath;

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

    const captchaCheck = await precheckCaptcha(
      request,
      url,
      config,
      bindingPathInput,
      nowSeconds,
      origin
    );
    if (captchaCheck) {
      return captchaCheck;
    }

    return fetch(request);
  },
};
