// Cloudflare Snippet: pre-auth for landing
// Set HMAC_SECRET in CONFIG to common.tokenHmacKey (and keep common.signSecret aligned).
// Leave HMAC_SECRET empty to skip sign validation; set POW_TOKEN for pow when HMAC_SECRET is empty.

const DEFAULTS = {
  powcheck: false,
  stripDownloadPrefix: false,
  POW_VERSION: 1,
  POW_DIFFICULTY_BASE: 18,
  POW_DIFFICULTY_COEFF: 1.0,
  POW_CHAL_TTL_SEC: 120,
  POW_SOL_TTL_SEC: 600,
  POW_BIND_PATH: true,
  POW_BIND_IPRANGE: true,
  POW_BIND_COUNTRY: false,
  POW_BIND_ASN: false,
  IPV4_PREFIX: 32,
  IPV6_PREFIX: 64,
  POW_SOL_COOKIE: "__Host-pow_sol",
  POW_ESM_URL:
    "https://cdn.jsdelivr.net/gh/ImoutoHeaven/alist-landing-worker@controller-overhaul/snippets/esm/esm.js",
};

const CONFIG = [
  // Example:
  // { pattern: "alist-landing-*.example.com/*", config: { HMAC_SECRET: "replace-with-common-tokenHmacKey", POW_TOKEN: "replace-with-powToken", powcheck: true, stripDownloadPrefix: true, POW_DIFFICULTY_BASE: 20, POW_DIFFICULTY_COEFF: 1.2, POW_CHAL_TTL_SEC: 180, POW_SOL_TTL_SEC: 600, POW_BIND_PATH: true, POW_BIND_IPRANGE: true, POW_BIND_COUNTRY: false, POW_BIND_ASN: false, IPV4_PREFIX: 32, IPV6_PREFIX: 64 } },
  // { pattern: "alist-landing-*.example.com/**", config: { HMAC_SECRET: "replace-with-common-tokenHmacKey", POW_TOKEN: "replace-with-powToken", powcheck: true, stripDownloadPrefix: true, POW_DIFFICULTY_BASE: 20, POW_DIFFICULTY_COEFF: 1.2, POW_CHAL_TTL_SEC: 180, POW_SOL_TTL_SEC: 600, POW_BIND_PATH: true, POW_BIND_IPRANGE: true, POW_BIND_COUNTRY: false, POW_BIND_ASN: false, IPV4_PREFIX: 32, IPV6_PREFIX: 64 } },
  // { pattern: "alist-landing-*.example.com", config: { HMAC_SECRET: "replace-with-common-tokenHmacKey", POW_TOKEN: "replace-with-powToken", powcheck: true, stripDownloadPrefix: true, POW_DIFFICULTY_BASE: 20, POW_DIFFICULTY_COEFF: 1.2, POW_CHAL_TTL_SEC: 180, POW_SOL_TTL_SEC: 600, POW_BIND_PATH: true, POW_BIND_IPRANGE: true, POW_BIND_COUNTRY: false, POW_BIND_ASN: false, IPV4_PREFIX: 32, IPV6_PREFIX: 64 } },
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

const pickConfig = (hostname, path) => {
  const host = typeof hostname === "string" ? hostname.toLowerCase() : "";
  const requestPath = typeof path === "string" ? path : "";
  if (!host) return null;
  for (const rule of COMPILED_CONFIG) {
    if (!rule || !rule.hostRegex) continue;
    if (!rule.hostRegex.test(host)) continue;
    if (rule.pathRegex && !rule.pathRegex.test(requestPath)) continue;
    return rule.config || null;
  }
  return null;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hmacKeyCache = new Map();

const getHmacKey = (secret) => {
  const key = typeof secret === "string" ? secret : "";
  if (!key) {
    return Promise.reject(new Error("HMAC secret missing"));
  }
  if (!hmacKeyCache.has(key)) {
    hmacKeyCache.set(
      key,
      crypto.subtle.importKey(
        "raw",
        encoder.encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
    );
  }
  return hmacKeyCache.get(key);
};

const base64UrlEncode = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");

const base64UrlEncodeNoPad = (bytes) =>
  base64UrlEncode(bytes).replace(/=+$/g, "");

const base64UrlDecodeToBytes = (b64u) => {
  if (!b64u || typeof b64u !== "string") return null;
  let b64 = b64u.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
};

const utf8ToBytes = (value) => encoder.encode(String(value ?? ""));
const bytesToUtf8 = (bytes) => decoder.decode(bytes);
const normalizeNumber = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
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

const hmacSha256Base64UrlNoPad = async (secret, data) => {
  const bytes = await hmacSha256(secret, data);
  return base64UrlEncodeNoPad(bytes);
};

const sha256Bytes = async (data) => {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(buf);
};

const timingSafeEqual = (a, b) => {
  const aNorm = typeof a === "string" ? a : "";
  const bNorm = typeof b === "string" ? b : "";
  if (aNorm.length !== bNorm.length) return false;
  let diff = 0;
  for (let i = 0; i < aNorm.length; i++) {
    diff |= aNorm.charCodeAt(i) ^ bNorm.charCodeAt(i);
  }
  return diff === 0;
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
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  return headers;
};

const respondText = (origin, msg, status = 200) => {
  const headers = safeHeaders(origin);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(msg, { status, headers });
};

const respondJson = (origin, payload, status = 200) => {
  const headers = safeHeaders(origin);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status, headers });
};

const deny = (origin, msg) => respondText(origin, msg, 403);

const isNavigationRequest = (request) => {
  const mode = request.headers.get("Sec-Fetch-Mode") || "";
  if (mode === "navigate") return true;
  const accept = request.headers.get("Accept") || "";
  return accept.includes("text/html");
};

const parseCookieHeader = (cookieHeader) => {
  const out = new Map();
  if (!cookieHeader) return out;
  const parts = cookieHeader.split(";");
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      value = decodeURIComponent(value);
    } catch {
      // ignore decoding errors
    }
    out.set(key, value);
  }
  return out;
};

const getClientIP = (request) =>
  request.headers.get("CF-Connecting-IP") ||
  request.headers.get("cf-connecting-ip") ||
  "0.0.0.0";

const isIpv4 = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
const isIpv6 = (ip) => ip.includes(":");

const parseIpv4 = (ip) => {
  if (!isIpv4(ip)) return null;
  const parts = ip.split(".").map((v) => Number.parseInt(v, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
};

const formatIpv4 = (bytes) => bytes.join(".");

const ipv4Cidr = (ip, prefix) => {
  const bytes = parseIpv4(ip);
  if (!bytes) return null;
  const p = Math.min(32, Math.max(0, Number(prefix)));
  const ipInt =
    (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  const mask = p === 0 ? 0 : (~0 << (32 - p)) >>> 0;
  const net = ipInt & mask;
  const netBytes = [
    (net >>> 24) & 0xff,
    (net >>> 16) & 0xff,
    (net >>> 8) & 0xff,
    net & 0xff,
  ];
  return `${formatIpv4(netBytes)}/${p}`;
};

const parseIpv6Hextets = (part) => {
  if (!part) return [];
  const tokens = part.split(":");
  const out = [];
  for (const token of tokens) {
    if (!token) continue;
    if (token.includes(".")) {
      const v4 = parseIpv4(token);
      if (!v4) return null;
      const hi = (v4[0] << 8) | v4[1];
      const lo = (v4[2] << 8) | v4[3];
      out.push(hi, lo);
      continue;
    }
    const value = Number.parseInt(token, 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) return null;
    out.push(value);
  }
  return out;
};

const parseIpv6 = (ip) => {
  if (!ip || typeof ip !== "string") return null;
  const raw = ip.split("%")[0];
  if (!raw) return null;
  if (raw === "::") return new Uint8Array(16);
  const parts = raw.split("::");
  if (parts.length > 2) return null;
  const head = parseIpv6Hextets(parts[0]);
  if (head === null) return null;
  const tail = parts.length === 2 ? parseIpv6Hextets(parts[1]) : [];
  if (tail === null) return null;
  const total = head.length + tail.length;
  if (total > 8) return null;
  const zeros = parts.length === 2 ? 8 - total : 0;
  if (parts.length === 1 && total !== 8) return null;
  const full = head.concat(Array(zeros).fill(0)).concat(tail);
  if (full.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (full[i] >>> 8) & 0xff;
    bytes[i * 2 + 1] = full[i] & 0xff;
  }
  return bytes;
};

const formatIpv6 = (bytes) => {
  const parts = [];
  for (let i = 0; i < 16; i += 2) {
    const value = (bytes[i] << 8) | bytes[i + 1];
    parts.push(value.toString(16).padStart(4, "0"));
  }
  return parts.join(":");
};

const ipv6Cidr = (ip, prefix) => {
  const bytes = parseIpv6(ip);
  if (!bytes) return null;
  const p = Math.min(128, Math.max(0, Number(prefix)));
  const fullBytes = Math.floor(p / 8);
  const rem = p % 8;
  const out = new Uint8Array(bytes);
  for (let i = 0; i < 16; i++) {
    if (i < fullBytes) continue;
    if (i === fullBytes && rem > 0) {
      const mask = 0xff << (8 - rem);
      out[i] = out[i] & mask;
    } else {
      out[i] = 0;
    }
  }
  return `${formatIpv6(out)}/${p}`;
};

const computeIpScope = (ip, config) => {
  const v4Prefix = normalizeNumber(config.IPV4_PREFIX, DEFAULTS.IPV4_PREFIX);
  const v6Prefix = normalizeNumber(config.IPV6_PREFIX, DEFAULTS.IPV6_PREFIX);
  if (isIpv4(ip)) {
    return ipv4Cidr(ip, v4Prefix) || "unknown";
  }
  if (isIpv6(ip)) {
    return ipv6Cidr(ip, v6Prefix) || "unknown";
  }
  return "unknown";
};

const getRequestCf = (request) => {
  const cf = request && request.cf;
  return cf && typeof cf === "object" ? cf : null;
};

const normalizeCfValue = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return String(value);
};

const normalizeCountry = (value) => {
  const raw = normalizeCfValue(value);
  return raw ? raw.toUpperCase() : "unknown";
};

const normalizeAsn = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? String(Math.trunc(num)) : "unknown";
};

const getPowDifficulty = (config) => {
  const base = normalizeNumber(config.POW_DIFFICULTY_BASE, DEFAULTS.POW_DIFFICULTY_BASE);
  const coeff = normalizeNumber(config.POW_DIFFICULTY_COEFF, DEFAULTS.POW_DIFFICULTY_COEFF);
  if (!Number.isFinite(base) || base <= 0) return 1;
  if (!Number.isFinite(coeff) || coeff <= 0) return Math.max(1, Math.round(base));
  return Math.max(1, Math.round(base * coeff));
};

const getPowSolMaxAge = (config) => {
  const solTtl = normalizeNumber(config.POW_SOL_TTL_SEC, DEFAULTS.POW_SOL_TTL_SEC);
  const chalTtl = normalizeNumber(config.POW_CHAL_TTL_SEC, DEFAULTS.POW_CHAL_TTL_SEC);
  return Math.max(1, Math.min(solTtl || 0, chalTtl || 0));
};

const randomBase64Url = (byteLength) => {
  const len = Number.isInteger(byteLength) && byteLength > 0 ? byteLength : 16;
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeNoPad(bytes);
};

const makePowBindingString = (
  ticket,
  hostname,
  pathHash,
  ipScope,
  country,
  asn
) => {
  const host = typeof hostname === "string" ? hostname.toLowerCase() : "";
  return (
    "v=" +
    ticket.v +
    "&e=" +
    ticket.e +
    "&d=" +
    ticket.d +
    "&r=" +
    ticket.r +
    "&h=" +
    host +
    "&ph=" +
    pathHash +
    "&s=" +
    ipScope +
    "&cc=" +
    country +
    "&asn=" +
    asn
  );
};

const buildPowSeed = (bindingString) => `pow|${bindingString}`;

const leadingZeroBits = (bytes) => {
  let count = 0;
  for (const b of bytes) {
    if (b === 0) {
      count += 8;
      continue;
    }
    for (let i = 7; i >= 0; i--) {
      if (b & (1 << i)) {
        return count + (7 - i);
      }
    }
  }
  return count;
};

const checkPow = async (seed, nonce, difficulty) => {
  if (!nonce || typeof nonce !== "string") return false;
  const payload = `${seed}|${nonce}`;
  const digest = await sha256Bytes(payload);
  return leadingZeroBits(digest) >= difficulty;
};

const encodePowTicket = (ticket) => {
  const raw = `${ticket.v}.${ticket.e}.${ticket.d}.${ticket.r}.${ticket.mac}`;
  return base64UrlEncodeNoPad(utf8ToBytes(raw));
};

const parsePowTicket = (ticketB64) => {
  const bytes = base64UrlDecodeToBytes(ticketB64);
  if (!bytes) return null;
  const raw = bytesToUtf8(bytes);
  const parts = raw.split(".");
  if (parts.length !== 5) return null;
  const v = Number.parseInt(parts[0], 10);
  const e = Number.parseInt(parts[1], 10);
  const d = Number.parseInt(parts[2], 10);
  const r = parts[3] || "";
  const mac = parts[4] || "";
  if (!Number.isFinite(v) || !Number.isFinite(e) || !Number.isFinite(d)) return null;
  if (!r) return null;
  return { v, e, d, r, mac };
};

const parsePowSolCookie = (value) => {
  if (!value || typeof value !== "string") return null;
  const idx = value.indexOf(".");
  if (idx <= 0 || idx === value.length - 1) return null;
  const ticketB64 = value.slice(0, idx);
  const nonceB64 = value.slice(idx + 1);
  const ticket = parsePowTicket(ticketB64);
  if (!ticket) return null;
  const nonceBytes = base64UrlDecodeToBytes(nonceB64);
  if (!nonceBytes) return null;
  const nonce = bytesToUtf8(nonceBytes);
  if (!nonce) return null;
  return { ticket, nonce, ticketB64 };
};

const getPowBindingValues = async (request, canonicalPath, config) => {
  const bindPath = config.POW_BIND_PATH !== false;
  const bindIp = config.POW_BIND_IPRANGE !== false;
  const bindCountry = config.POW_BIND_COUNTRY === true;
  const bindAsn = config.POW_BIND_ASN === true;
  const pathHash = bindPath ? base64UrlEncodeNoPad(await sha256Bytes(canonicalPath)) : "any";
  const ipScope = bindIp ? computeIpScope(getClientIP(request), config) : "any";
  const cf = getRequestCf(request);
  const country = bindCountry ? normalizeCountry(cf && cf.country) : "any";
  const asn = bindAsn ? normalizeAsn(cf && cf.asn) : "any";
  return { pathHash, ipScope, country, asn };
};

const verifyPowSol = async (request, url, canonicalPath, nowSeconds, config, powSecret) => {
  const cookies = parseCookieHeader(request.headers.get("Cookie"));
  const solRaw = cookies.get(config.POW_SOL_COOKIE) || "";
  const sol = parsePowSolCookie(solRaw);
  if (!sol) return false;
  const ticket = sol.ticket;
  const powVersion = normalizeNumber(config.POW_VERSION, DEFAULTS.POW_VERSION);
  if (ticket.v !== powVersion) return false;
  if (!Number.isFinite(ticket.e) || ticket.e <= 0 || ticket.e < nowSeconds) return false;
  if (!powSecret) return false;
  const { pathHash, ipScope, country, asn } = await getPowBindingValues(request, canonicalPath, config);
  const bindingString = makePowBindingString(
    ticket,
    url.hostname,
    pathHash,
    ipScope,
    country,
    asn
  );
  const expectedMac = await hmacSha256Base64UrlNoPad(powSecret, bindingString);
  if (!timingSafeEqual(expectedMac, ticket.mac)) return false;
  const seed = buildPowSeed(bindingString);
  return checkPow(seed, sol.nonce, ticket.d);
};

const buildPowChallengeHtml = ({
  bindingStringB64,
  difficulty,
  ticketB64,
  reloadUrlB64,
  solCookieName,
  solMaxAge,
  esmUrlB64,
}) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>VerifyRequest</title>
<style>
  :root {
    --win-bg: #c0c0c0;
    --win-border-light: #dfdfdf;
    --win-border-dark: #808080;
    --win-border-black: #000000;
    --win-title-l: #000080;
    --win-title-r: #1084d0;
    --term-bg: #0c0c0c;
    --term-fg: #cccccc;
    --term-font: "Consolas", "Lucida Console", "Monaco", "Courier New", monospace;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0; padding: 0;
    height: 100vh;
    width: 100vw;
    background-color: #000;
    /* Cyberpunkish dark radial gradient desktop */
    background-image: radial-gradient(circle at center, #2b2b2b 0%, #1a1a1a 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--term-font);
    overflow: hidden;
  }

  /* Scanlines overlay */
  .scanlines {
    position: fixed;
    top: 0; left: 0; width: 100%; height: 100%;
    background: linear-gradient(
      to bottom,
      rgba(255,255,255,0),
      rgba(255,255,255,0) 50%,
      rgba(0,0,0,0.1) 50%,
      rgba(0,0,0,0.1)
    );
    background-size: 100% 4px;
    pointer-events: none;
    z-index: 999;
  }

  /* --- Window Container --- */
  .window {
    width: 800px;
    height: 500px;
    
    /* Responsive sizing: keep it floating even on mobile */
    max-width: 94vw; 
    max-height: 85vh;
    
    background-color: var(--win-bg);
    /* Classic 3D borders */
    border-top: 2px solid var(--win-border-light);
    border-left: 2px solid var(--win-border-light);
    border-right: 2px solid var(--win-border-black);
    border-bottom: 2px solid var(--win-border-black);
    
    /* Shadow for depth */
    box-shadow: 1px 1px 0 0 var(--win-border-dark) inset, 0 10px 30px rgba(0,0,0,0.7);
    
    display: flex;
    flex-direction: column;
    padding: 3px;
    position: relative;
    z-index: 10;
    
    /* Smooth transitions for min/max operations */
    transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
    transform-origin: bottom left;
  }

  /* Maximized State */
  .window.maximized {
    width: 100vw; height: 100vh;
    max-width: 100%; max-height: 100%;
    border: none; padding: 0;
  }
  .window.maximized .terminal-content {
    border: none;
    border-top: 2px solid var(--win-border-dark);
  }

  /* Minimized State */
  .window.minimized {
    transform: scale(0);
    opacity: 0;
    pointer-events: none;
  }

  /* --- Taskbar Entry (Bottom Left) --- */
  .taskbar-entry {
    position: fixed;
    bottom: 10px; left: 10px;
    width: 140px; height: 28px;
    background-color: var(--win-bg);
    border-top: 2px solid var(--win-border-light);
    border-left: 2px solid var(--win-border-light);
    border-right: 2px solid var(--win-border-black);
    border-bottom: 2px solid var(--win-border-black);
    box-shadow: 1px 1px 0 var(--win-border-dark);
    
    display: flex; align-items: center;
    padding: 0 6px; gap: 6px;
    cursor: pointer;
    z-index: 5;
    
    visibility: hidden; pointer-events: none;
  }

  .taskbar-entry.visible {
    visibility: visible; pointer-events: auto;
  }
  
  .taskbar-entry:active {
    border-top: 2px solid var(--win-border-black);
    border-left: 2px solid var(--win-border-black);
    border-right: 2px solid var(--win-border-light);
    border-bottom: 2px solid var(--win-border-light);
  }

  .taskbar-text {
    font-family: Tahoma, sans-serif; font-size: 11px;
    font-weight: bold; color: black;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    user-select: none;
  }

  /* --- Title Bar --- */
  .title-bar {
    height: 22px;
    background: linear-gradient(90deg, var(--win-title-l), var(--win-title-r));
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 4px; margin-bottom: 3px;
    user-select: none; flex-shrink: 0;
  }

  .title-text {
    color: white; font-weight: bold; font-size: 12px;
    font-family: Tahoma, sans-serif;
    display: flex; align-items: center; gap: 6px;
    text-shadow: 1px 1px #000;
    
    /* Ensure title truncates properly on small phones */
    flex: 1; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-right: 8px;
  }

  .icon-prompt {
    width: 12px; height: 12px;
    background: white; border: 1px solid gray;
    position: relative; flex-shrink: 0;
    box-shadow: 1px 1px 0 #000;
  }
  .icon-prompt::after {
    content: "C:"; color: black; font-size: 9px;
    position: absolute; top: -2px; left: 0px;
    font-family: Arial, sans-serif; font-weight: bold; transform: scale(0.8);
  }

  /* --- Buttons --- */
  .controls { display: flex; gap: 2px; flex-shrink: 0; }
  .btn {
    width: 16px; height: 14px;
    background-color: var(--win-bg);
    border: 1px solid;
    border-color: var(--win-border-light) var(--win-border-black) var(--win-border-black) var(--win-border-light);
    display: flex; align-items: center; justify-content: center;
    font-size: 9px; font-family: Tahoma, sans-serif; color: black;
    box-shadow: 1px 1px 0 var(--win-border-dark);
    cursor: pointer;
  }
  .btn:active {
    border-color: var(--win-border-black) var(--win-border-light) var(--win-border-light) var(--win-border-black);
    transform: translate(1px, 1px); box-shadow: none;
  }
  .btn-close { margin-left: 2px; }

  /* --- Terminal Area --- */
  .terminal-content {
    flex: 1;
    background-color: var(--term-bg);
    color: var(--term-fg);
    border: 2px solid;
    border-color: var(--win-border-dark) var(--win-border-light) var(--win-border-light) var(--win-border-dark);
    padding: 4px;
    font-size: 14px;
    line-height: 1.3;
    overflow-y: auto; overflow-x: hidden;
    position: relative;
    text-shadow: 0 0 1px rgba(255,255,255,0.2);
  }

  .terminal-content::-webkit-scrollbar { width: 12px; background: #000; }
  .terminal-content::-webkit-scrollbar-thumb { background: #444; border: 1px solid #000; }
  
  .line { word-break: break-all; margin-bottom: 2px; }
  
  .cursor {
    display: inline-block; width: 0.6em; height: 1.1em;
    background-color: var(--term-fg); vertical-align: text-bottom;
    animation: blink 1s step-end infinite;
  }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

  .dim { color: #888; }
  .green { color: #0f0; }
  .cyan { color: #0ff; }
  .yellow { color: #ff0; }
  .red { color: #f55; }
  .white { color: #fff; font-weight: bold; }
</style>
</head>
<body>
  <div class="scanlines"></div>

  <!-- Taskbar Entry (Hidden unless minimized) -->
  <div class="taskbar-entry" id="taskbarBtn">
    <div class="icon-prompt"></div>
    <div class="taskbar-text">Administrator: C...</div>
  </div>

  <div class="window" id="winMain">
    <div class="title-bar">
      <div class="title-text">
        <div class="icon-prompt"></div>
        Administrator: C:\\Windows\\System32\\cmd.exe
      </div>
      <div class="controls">
        <div class="btn" id="btnMin" title="Minimize">_</div>
        <div class="btn" id="btnMax" title="Maximize">□</div>
        <div class="btn btn-close" id="btnClose" title="Close">X</div>
      </div>
    </div>
    <div class="terminal-content" id="console"></div>
  </div>

<script type="module">
  const CFG = {
    bindingB64: "${bindingStringB64}",
    difficulty: ${difficulty},
    reloadUrlB64: "${reloadUrlB64}",
    solCookieName: "${solCookieName}",
    solMaxAge: ${solMaxAge},
    ticketB64: "${ticketB64}",
    esmUrlB64: "${esmUrlB64}",
    bootDelay: 200,
    charsPerSecond: 600,
  };

  const $ = (id) => document.getElementById(id);
  
  // --- Window Management ---
  const winMain = $("winMain");
  const taskbarBtn = $("taskbarBtn");
  let isRunning = true;

  // Min
  $("btnMin").addEventListener("click", () => {
    winMain.classList.add("minimized");
    taskbarBtn.classList.add("visible");
  });
  
  // Restore
  taskbarBtn.addEventListener("click", () => {
    winMain.classList.remove("minimized");
    taskbarBtn.classList.remove("visible");
  });

  // Max
  $("btnMax").addEventListener("click", () => {
    winMain.classList.toggle("maximized");
  });

  // Close
  $("btnClose").addEventListener("click", () => {
    try { window.close(); } catch(e){}
    isRunning = false;
    document.body.innerHTML = \`
      <div style="color:#555; font-family:monospace; height:100vh; display:flex; align-items:center; justify-content:center; flex-direction:column;">
        <div>CONNECTION TERMINATED</div>
        <div style="font-size:12px; margin-top:10px;">NO SIGNAL</div>
      </div>
    \`;
    document.body.style.background = "#000";
  });

  // --- Logic ---
  const decodeB64Url = (str) => {
    try {
      let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64.length % 4;
      if (pad) b64 += "=".repeat(4 - pad);
      return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    } catch(e) { return null; }
  };
  
  const encodeB64Url = (str) => {
    const bytes = new TextEncoder().encode(str);
    return btoa(String.fromCharCode(...bytes)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
  };

  class Terminal {
    constructor(el) {
      this.el = el;
      this.promptStr = "C:\\\\Windows\\\\System32>"; 
      this.queue = []; 
      this.isTyping = false;
      this.cursor = document.createElement("span");
      this.cursor.className = "cursor";
      this.newLine();
    }

    newLine() {
      this.currentLine = document.createElement("div");
      this.currentLine.className = "line";
      this.el.appendChild(this.currentLine);
      this.currentLine.appendChild(this.cursor);
      this.el.scrollTop = this.el.scrollHeight;
    }

    async type(text, style = "") {
      return new Promise(resolve => {
        this.queue.push({ text, style, resolve });
        if (!this.isTyping) this.startLoop();
      });
    }

    async println(text, style = "") {
      this.writeDirect(text, style);
      this.newLine();
      await new Promise(r => setTimeout(r, 20));
    }

    writeDirect(text, style="") {
      if (!isRunning) return;
      const span = document.createElement("span");
      if(style) span.className = style;
      span.textContent = text;
      this.currentLine.insertBefore(span, this.cursor);
      this.el.scrollTop = this.el.scrollHeight;
    }

    startLoop() {
      this.isTyping = true;
      let lastTime = performance.now();
      
      const tick = (now) => {
        if (!isRunning) return;

        if (this.queue.length === 0) {
          this.isTyping = false;
          return; 
        }

        const task = this.queue[0];
        const dt = now - lastTime;
        lastTime = now;

        const charCount = Math.max(1, Math.round((CFG.charsPerSecond / 1000) * dt));
        const chunk = task.text.substring(0, charCount);
        task.text = task.text.substring(charCount);

        if (chunk) {
          let lastSpan = this.currentLine.lastElementChild?.previousElementSibling;
          if (lastSpan && lastSpan.className === task.style) {
            lastSpan.textContent += chunk;
          } else {
            const span = document.createElement("span");
            if (task.style) span.className = task.style;
            span.textContent = chunk;
            this.currentLine.insertBefore(span, this.cursor);
          }
          this.el.scrollTop = this.el.scrollHeight;
        }

        if (task.text.length === 0) {
          this.queue.shift();
          if (task.resolve) task.resolve();
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }

  async function boot() {
    if (!isRunning) return;
    const term = new Terminal($("console"));

    await new Promise(r => setTimeout(r, CFG.bootDelay));

    try {
      term.writeDirect("Microsoft Windows [Version 10.0.19045.2486]");
      term.newLine();
      term.writeDirect("(c) Microsoft Corporation. All rights reserved.");
      term.newLine();
      term.newLine();
      
      term.writeDirect(term.promptStr + " ");
      await term.type("alist-guard.exe --verify --pow", "");
      
      await new Promise(r => setTimeout(r, 300));
      term.newLine();
      
      await term.println("ALIST GUARDIAN v" + "${DEFAULTS.POW_VERSION}.0", "white");
      
      await term.type("Detecting Hardware Environment... ", "dim");
      const cores = navigator.hardwareConcurrency || 1;
      await term.println("OK", "green");
      await term.println(\`  > vCPU: \${cores} Cores\`, "dim");
      await term.println(\`  > Difficulty: \${CFG.difficulty}\`, "dim");
      
      await term.type("Loading Solver... ", "dim");
      const loadStart = performance.now();
      const esmUrl = decodeB64Url(CFG.esmUrlB64);
      
      let solvePow;
      try {
        const module = await import(esmUrl);
        solvePow = module.solvePow;
      } catch(e) {
        throw new Error("Module Load Failed");
      }
      await term.println(\`DONE (\${(performance.now() - loadStart).toFixed(0)}ms)\`, "green");

      await term.type("Calculating Proof-of-Work... ", "cyan");
      
      const spinSpan = document.createElement("span");
      spinSpan.className = "white";
      term.currentLine.insertBefore(spinSpan, term.cursor);
      let spinFrame = 0;
      const spinner = setInterval(() => { spinSpan.textContent = "|/-\\\\"[spinFrame++ % 4]; }, 80);

      await new Promise(r => setTimeout(r, 50));

      const binding = decodeB64Url(CFG.bindingB64);
      const startT = performance.now();
      const nonce = await solvePow(binding, CFG.difficulty);
      const timeT = performance.now() - startT;

      clearInterval(spinner);
      spinSpan.remove();

      await term.println("MATCH", "green");
      await term.println(\`  > Nonce: \${nonce}\`, "dim");
      await term.println(\`  > Time:  \${timeT.toFixed(0)}ms\`, "dim");

      await term.type("Verifying Ticket... ", "dim");
      const nonceB64 = encodeB64Url(String(nonce));
      const cookieVal = \`\${CFG.ticketB64}.\${nonceB64}\`;
      document.cookie = \`\${CFG.solCookieName}=\${cookieVal}; Max-Age=\${CFG.solMaxAge}; Path=/; Secure; SameSite=None\`;
      
      await new Promise(r => setTimeout(r, 400));
      await term.println("ACCESS GRANTED", "green");
      document.title = "SubmitThisForm";
      
      term.newLine();
      await term.println("Redirecting...", "yellow");
      
      const target = decodeB64Url(CFG.reloadUrlB64);
      setTimeout(() => {
        if (isRunning) window.location.replace(target);
      }, 500);

    } catch (e) {
      if (!isRunning) return;
      term.newLine();
      await term.println("FATAL ERROR", "red");
      await term.println(e.message, "red");
      term.newLine();
      term.writeDirect(term.promptStr + " ");
    }
  }

  boot();
</script>
</body>
</html>`;

const respondPowChallengeHtml = async (request, url, canonicalPath, nowSeconds, config, powSecret) => {
  const ttl = normalizeNumber(config.POW_CHAL_TTL_SEC, DEFAULTS.POW_CHAL_TTL_SEC) || 0;
  const exp = nowSeconds + Math.max(1, ttl);
  const difficulty = getPowDifficulty(config);
  const { pathHash, ipScope, country, asn } = await getPowBindingValues(request, canonicalPath, config);
  const powVersion = normalizeNumber(config.POW_VERSION, DEFAULTS.POW_VERSION);
  const ticket = {
    v: powVersion,
    e: exp,
    d: difficulty,
    r: randomBase64Url(16),
    mac: "",
  };
  const bindingString = makePowBindingString(
    ticket,
    url.hostname,
    pathHash,
    ipScope,
    country,
    asn
  );
  ticket.mac = await hmacSha256Base64UrlNoPad(powSecret, bindingString);
  const ticketB64 = encodePowTicket(ticket);
  const bindingStringB64 = base64UrlEncodeNoPad(utf8ToBytes(bindingString));
  const reloadUrlB64 = base64UrlEncodeNoPad(utf8ToBytes(url.toString()));
  const esmUrlB64 = base64UrlEncodeNoPad(utf8ToBytes(String(config.POW_ESM_URL)));
  const solMaxAge = getPowSolMaxAge(config);
  const html = buildPowChallengeHtml({
    bindingStringB64,
    difficulty,
    ticketB64,
    reloadUrlB64,
    solCookieName: config.POW_SOL_COOKIE,
    solMaxAge,
    esmUrlB64,
  });
  const headers = safeHeaders(request.headers.get("Origin") || "");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(html, { status: 200, headers });
};

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const hostname = url.hostname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: safeHeaders(origin) });
    }

    const nowSeconds = Math.floor(Date.now() / 1000);

    const requestPath = normalizePath(url.pathname);
    if (!requestPath) return respondText(origin, "invalid path", 400);
    const isInfoPath = requestPath === "/info";
    let authPath = requestPath;
    let matchPath = requestPath;
    if (isInfoPath) {
      const rawPath = url.searchParams.get("path");
      if (!rawPath) return respondText(origin, "path is required", 400);
      const decoded = decodePathParam(rawPath);
      if (!decoded) return respondText(origin, "invalid path encoding", 400);
      const canonical = normalizeDecodedPath(decoded);
      if (!canonical) return respondText(origin, "invalid path", 400);
      authPath = canonical;
      matchPath = canonical;
    } else {
      authPath = stripDownloadPrefix(authPath);
    }

    const selected = pickConfig(hostname, matchPath);
    const config = selected ? { ...DEFAULTS, ...selected } : null;
    if (!config) return respondText(origin, "misconfigured", 500);
    const signSecret = typeof config.HMAC_SECRET === "string" ? config.HMAC_SECRET : "";
    const powToken = typeof config.POW_TOKEN === "string" ? config.POW_TOKEN : "";
    const powSecret = powToken || signSecret;
    const hasSignSecret = signSecret.length > 0;
    const hasPowSecret = powSecret.length > 0;
    if (!isInfoPath && config.stripDownloadPrefix === true) {
      authPath = stripDownloadPrefix(authPath);
    }

    if (hasSignSecret) {
      const sign = url.searchParams.get("sign") || "";
      const signMeta = parseSignature(sign);
      if (!signMeta) return deny(origin, "sign invalid");
      if (isExpired(signMeta.expire, nowSeconds)) return deny(origin, "sign expired");

      const expected = await hmacSha256Sign(signSecret, authPath, signMeta.expire);
      if (expected !== sign) return deny(origin, "sign mismatch");
    }

    if (config.powcheck !== true) {
      return fetch(request);
    }

    if (!hasPowSecret) {
      return respondText(origin, "misconfigured", 500);
    }

    if (!config.POW_ESM_URL) {
      return respondText(origin, "misconfigured", 500);
    }

    const powOk = await verifyPowSol(request, url, authPath, nowSeconds, config, powSecret);
    if (powOk) {
      return fetch(request);
    }

    if (!isNavigationRequest(request)) {
      return respondJson(origin, { code: "pow_required" }, 403);
    }

    return respondPowChallengeHtml(request, url, authPath, nowSeconds, config, powSecret);
  },
};
