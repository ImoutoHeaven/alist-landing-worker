// Cloudflare Snippet: pre-auth for landing
// Set HMAC_SECRET in CONFIG to common.tokenHmacKey (and keep common.signSecret aligned).
// Leave HMAC_SECRET empty to skip sign validation; set POW_TOKEN for pow when HMAC_SECRET is empty.

const DEFAULTS = {
  powcheck: false,
  stripDownloadPrefix: false,
  POW_VERSION: 2,
  POW_API_PREFIX: "/__pow",
  POW_DIFFICULTY_BASE: 4096,
  POW_DIFFICULTY_COEFF: 1.0,
  POW_MIN_STEPS: 512,
  POW_MAX_STEPS: 8192,
  POW_HASHCASH_BITS: 4,
  POW_SEGMENT_LEN: 1,
  POW_SAMPLE_K: 3,
  POW_FORCE_EDGE_1: true,
  POW_FORCE_EDGE_LAST: true,
  POW_CHAL_TTL_SEC: 120,
  POW_SOL_TTL_SEC: 600,
  POW_BIND_PATH: true,
  POW_BIND_IPRANGE: true,
  POW_BIND_COUNTRY: false,
  POW_BIND_ASN: false,
  POW_BIND_TLS: false,
  IPV4_PREFIX: 32,
  IPV6_PREFIX: 64,
  POW_COMMIT_COOKIE: "__Host-pow_commit",
  POW_CHAL_COOKIE: "__Host-pow_chal",
  POW_SOL_COOKIE: "__Host-pow_sol",
  POW_ESM_URL:
    "https://cdn.jsdelivr.net/gh/ImoutoHeaven/alist-landing-worker@controller-overhaul/snippets/esm/esm.js",
};

const CONFIG = [
  // Example:
  // { pattern: "alist-landing-*.example.com/*", config: { HMAC_SECRET: "replace-with-common-tokenHmacKey", POW_TOKEN: "replace-with-powToken", powcheck: true, stripDownloadPrefix: true, POW_DIFFICULTY_BASE: 4096, POW_DIFFICULTY_COEFF: 1.0, POW_MIN_STEPS: 512, POW_MAX_STEPS: 8192, POW_HASHCASH_BITS: 4, POW_SEGMENT_LEN: 1, POW_SAMPLE_K: 3, POW_FORCE_EDGE_1: true, POW_FORCE_EDGE_LAST: true, POW_CHAL_TTL_SEC: 180, POW_SOL_TTL_SEC: 600, POW_BIND_PATH: true, POW_BIND_IPRANGE: true, POW_BIND_COUNTRY: false, POW_BIND_ASN: false, POW_BIND_TLS: false, IPV4_PREFIX: 32, IPV6_PREFIX: 64 } },
  // { pattern: "alist-landing-*.example.com/**", config: { HMAC_SECRET: "replace-with-common-tokenHmacKey", POW_TOKEN: "replace-with-powToken", powcheck: true, stripDownloadPrefix: true, POW_DIFFICULTY_BASE: 4096, POW_DIFFICULTY_COEFF: 1.0, POW_MIN_STEPS: 512, POW_MAX_STEPS: 8192, POW_HASHCASH_BITS: 4, POW_SEGMENT_LEN: 1, POW_SAMPLE_K: 3, POW_FORCE_EDGE_1: true, POW_FORCE_EDGE_LAST: true, POW_CHAL_TTL_SEC: 180, POW_SOL_TTL_SEC: 600, POW_BIND_PATH: true, POW_BIND_IPRANGE: true, POW_BIND_COUNTRY: false, POW_BIND_ASN: false, POW_BIND_TLS: false, IPV4_PREFIX: 32, IPV6_PREFIX: 64 } },
  // { pattern: "alist-landing-*.example.com", config: { HMAC_SECRET: "replace-with-common-tokenHmacKey", POW_TOKEN: "replace-with-powToken", powcheck: true, stripDownloadPrefix: true, POW_DIFFICULTY_BASE: 4096, POW_DIFFICULTY_COEFF: 1.0, POW_MIN_STEPS: 512, POW_MAX_STEPS: 8192, POW_HASHCASH_BITS: 4, POW_SEGMENT_LEN: 1, POW_SAMPLE_K: 3, POW_FORCE_EDGE_1: true, POW_FORCE_EDGE_LAST: true, POW_CHAL_TTL_SEC: 180, POW_SOL_TTL_SEC: 600, POW_BIND_PATH: true, POW_BIND_IPRANGE: true, POW_BIND_COUNTRY: false, POW_BIND_ASN: false, POW_BIND_TLS: false, IPV4_PREFIX: 32, IPV6_PREFIX: 64 } },
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
const POW_API_PREFIX = DEFAULTS.POW_API_PREFIX;

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

const getConfigById = (cfgId) => {
  if (!Number.isInteger(cfgId) || cfgId < 0 || cfgId >= COMPILED_CONFIG.length) {
    return null;
  }
  const entry = COMPILED_CONFIG[cfgId];
  return entry && entry.config ? entry.config : null;
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

const concatBytes = (...chunks) => {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

const encodeUint32BE = (value) => {
  const out = new Uint8Array(4);
  const num = Number(value) >>> 0;
  out[0] = (num >>> 24) & 0xff;
  out[1] = (num >>> 16) & 0xff;
  out[2] = (num >>> 8) & 0xff;
  out[3] = num & 0xff;
  return out;
};

const bytesEqual = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
};

const leadingZeroBits = (bytes) => {
  let count = 0;
  for (const b of bytes || []) {
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
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS,POST");
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

const normalizeTlsFingerprint = (value) => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const buildTlsFingerprintHash = async (request) => {
  const cf = getRequestCf(request);
  if (!cf) return "";
  const extensions = normalizeTlsFingerprint(cf.tlsClientExtensionsSha1);
  const ciphers = normalizeTlsFingerprint(cf.tlsClientCiphersSha1);
  if (!extensions || !ciphers) return "";
  const digest = await sha256Bytes(`${extensions}|${ciphers}`);
  return base64UrlEncodeNoPad(digest);
};

const getPowSteps = (config) => {
  const base = normalizeNumber(config.POW_DIFFICULTY_BASE, DEFAULTS.POW_DIFFICULTY_BASE);
  const coeff = normalizeNumber(config.POW_DIFFICULTY_COEFF, DEFAULTS.POW_DIFFICULTY_COEFF);
  const minSteps = normalizeNumber(config.POW_MIN_STEPS, DEFAULTS.POW_MIN_STEPS);
  const maxSteps = normalizeNumber(config.POW_MAX_STEPS, DEFAULTS.POW_MAX_STEPS);
  const raw =
    Number.isFinite(base) && base > 0
      ? Number.isFinite(coeff) && coeff > 0
        ? base * coeff
        : base
      : 1;
  const steps = Math.max(1, Math.round(raw));
  const minVal = Number.isFinite(minSteps) ? Math.max(1, Math.floor(minSteps)) : 1;
  const maxVal = Number.isFinite(maxSteps) ? Math.max(minVal, Math.floor(maxSteps)) : minVal;
  return Math.min(maxVal, Math.max(minVal, steps));
};

const randomBase64Url = (byteLength) => {
  const len = Number.isInteger(byteLength) && byteLength > 0 ? byteLength : 16;
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeNoPad(bytes);
};

const POSW_SEED_PREFIX = encoder.encode("posw|seed|");
const POSW_STEP_PREFIX = encoder.encode("posw|step|");
const MERKLE_LEAF_PREFIX = encoder.encode("leaf|");
const MERKLE_NODE_PREFIX = encoder.encode("node|");
const PIPE_BYTES = encoder.encode("|");

const makePowBindingString = (
  ticket,
  hostname,
  pathHash,
  ipScope,
  country,
  asn,
  tlsFingerprint
) => {
  const host = typeof hostname === "string" ? hostname.toLowerCase() : "";
  return (
    "v=" +
    ticket.v +
    "&e=" +
    ticket.e +
    "&L=" +
    ticket.L +
    "&r=" +
    ticket.r +
    "&cfg=" +
    ticket.cfgId +
    "&h=" +
    host +
    "&ph=" +
    pathHash +
    "&s=" +
    ipScope +
    "&cc=" +
    country +
    "&asn=" +
    asn +
    "&tls=" +
    tlsFingerprint
  );
};

const hashPoswSeed = async (bindingString, nonce) =>
  sha256Bytes(
    concatBytes(
      POSW_SEED_PREFIX,
      utf8ToBytes(bindingString),
      PIPE_BYTES,
      utf8ToBytes(nonce || "")
    )
  );

const hashPoswStep = async (prevBytes, index) =>
  sha256Bytes(concatBytes(POSW_STEP_PREFIX, encodeUint32BE(index), prevBytes));

const hashMerkleLeaf = async (leafIndex, leafBytes) =>
  sha256Bytes(concatBytes(MERKLE_LEAF_PREFIX, encodeUint32BE(leafIndex), leafBytes));

const hashMerkleNode = async (leftBytes, rightBytes) =>
  sha256Bytes(concatBytes(MERKLE_NODE_PREFIX, leftBytes, rightBytes));

const computeMerkleDepth = (leafCount) => {
  let depth = 0;
  let size = Math.max(0, Math.floor(Number(leafCount) || 0));
  while (size > 1) {
    size = Math.ceil(size / 2);
    depth += 1;
  }
  return depth;
};

const verifyMerkleProof = async (rootBytes, leafBytes, leafIndex, leafCount, proof) => {
  if (!rootBytes || rootBytes.length !== 32) return false;
  if (!leafBytes || leafBytes.length !== 32) return false;
  const idx = Math.floor(Number(leafIndex));
  if (!Number.isFinite(idx) || idx < 0 || idx >= leafCount) return false;
  const sibs = proof && Array.isArray(proof.sibs) ? proof.sibs : null;
  const dirs = proof && typeof proof.dirs === "string" ? proof.dirs : "";
  const depth = computeMerkleDepth(leafCount);
  if (!sibs || sibs.length !== depth) return false;
  if (dirs && dirs.length !== depth) return false;
  let current = await hashMerkleLeaf(idx, leafBytes);
  let curIdx = idx;
  for (let i = 0; i < depth; i++) {
    const sibBytes = base64UrlDecodeToBytes(String(sibs[i] || ""));
    if (!sibBytes || sibBytes.length !== 32) return false;
    const dir = curIdx % 2 === 0 ? 0 : 1;
    if (dirs && Number(dirs[i]) !== dir) return false;
    current =
      dir === 0
        ? await hashMerkleNode(current, sibBytes)
        : await hashMerkleNode(sibBytes, current);
    curIdx = Math.floor(curIdx / 2);
  }
  return bytesEqual(current, rootBytes);
};

const encodePowTicket = (ticket) => {
  const raw = `${ticket.v}.${ticket.e}.${ticket.L}.${ticket.r}.${ticket.cfgId}.${ticket.mac}`;
  return base64UrlEncodeNoPad(utf8ToBytes(raw));
};

const parsePowTicket = (ticketB64) => {
  const bytes = base64UrlDecodeToBytes(ticketB64);
  if (!bytes) return null;
  const raw = bytesToUtf8(bytes);
  const parts = raw.split(".");
  if (parts.length !== 6) return null;
  const v = Number.parseInt(parts[0], 10);
  const e = Number.parseInt(parts[1], 10);
  const L = Number.parseInt(parts[2], 10);
  const r = parts[3] || "";
  const cfgId = Number.parseInt(parts[4], 10);
  const mac = parts[5] || "";
  if (!Number.isFinite(v) || !Number.isFinite(e) || !Number.isFinite(L)) return null;
  if (!Number.isFinite(cfgId) || cfgId < 0) return null;
  if (!r || !mac) return null;
  return { v, e, L, r, cfgId, mac };
};

const parsePowSolCookie = (value) => {
  if (!value || typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  if (parts[0] !== "v2") return null;
  const ticketB64 = parts[1] || "";
  const exp = Number.parseInt(parts[2], 10);
  const mac = parts[3] || "";
  if (!ticketB64 || !Number.isFinite(exp) || !mac) return null;
  return { ticketB64, exp, mac };
};

const parsePowCommitCookie = (value) => {
  if (!value || typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 7) return null;
  if (parts[0] !== "v2") return null;
  const ticketB64 = parts[1] || "";
  const rootB64 = parts[2] || "";
  const pathHash = parts[3] || "";
  const nonce = parts[4] || "";
  const exp = Number.parseInt(parts[5], 10);
  const mac = parts[6] || "";
  if (!ticketB64 || !rootB64 || !pathHash || !nonce || !Number.isFinite(exp) || !mac) {
    return null;
  }
  return { ticketB64, rootB64, pathHash, nonce, exp, mac };
};

const parsePowChalCookie = (value) => {
  if (!value || typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 6) return null;
  if (parts[0] !== "v2") return null;
  const sid = parts[1] || "";
  const ticketB64 = parts[2] || "";
  const indicesStr = parts[3] || "";
  const exp = Number.parseInt(parts[4], 10);
  const mac = parts[5] || "";
  if (!sid || !ticketB64 || !indicesStr || !Number.isFinite(exp) || !mac) return null;
  return { sid, ticketB64, indicesStr, exp, mac };
};

const parseIndicesStr = (value) => {
  if (!value || typeof value !== "string") return null;
  const parts = value.split(",");
  if (!parts.length) return null;
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    if (!part) return null;
    const num = Number.parseInt(part, 10);
    if (!Number.isFinite(num) || num <= 0) return null;
    if (seen.has(num)) return null;
    seen.add(num);
    out.push(num);
  }
  return out;
};

const computePathHash = async (canonicalPath) =>
  base64UrlEncodeNoPad(await sha256Bytes(canonicalPath));

const getPowBindingValuesWithPathHash = async (request, pathHash, config) => {
  const bindPath = config.POW_BIND_PATH !== false;
  const bindIp = config.POW_BIND_IPRANGE !== false;
  const bindCountry = config.POW_BIND_COUNTRY === true;
  const bindAsn = config.POW_BIND_ASN === true;
  const bindTls = config.POW_BIND_TLS === true;
  const normalizedPathHash =
    bindPath && typeof pathHash === "string" && pathHash ? pathHash : bindPath ? "" : "any";
  if (bindPath && !normalizedPathHash) return null;
  const ipScope = bindIp ? computeIpScope(getClientIP(request), config) : "any";
  const cf = getRequestCf(request);
  const country = bindCountry ? normalizeCountry(cf && cf.country) : "any";
  const asn = bindAsn ? normalizeAsn(cf && cf.asn) : "any";
  let tlsFingerprint = "any";
  if (bindTls) {
    tlsFingerprint = await buildTlsFingerprintHash(request);
    if (!tlsFingerprint) {
      return null;
    }
  }
  return { pathHash: normalizedPathHash, ipScope, country, asn, tlsFingerprint };
};

const getPowBindingValues = async (request, canonicalPath, config) => {
  const bindPath = config.POW_BIND_PATH !== false;
  const pathHash = bindPath ? await computePathHash(canonicalPath) : "any";
  return getPowBindingValuesWithPathHash(request, pathHash, config);
};

const verifyPowSol = async (request, url, canonicalPath, nowSeconds, config, powSecret, cfgId) => {
  const cookies = parseCookieHeader(request.headers.get("Cookie"));
  const solRaw = cookies.get(DEFAULTS.POW_SOL_COOKIE) || "";
  const sol = parsePowSolCookie(solRaw);
  if (!sol) return false;
  if (!Number.isFinite(sol.exp) || sol.exp <= 0 || sol.exp < nowSeconds) return false;
  const ticket = parsePowTicket(sol.ticketB64);
  if (!ticket) return false;
  const powVersion = normalizeNumber(config.POW_VERSION, DEFAULTS.POW_VERSION);
  if (ticket.v !== powVersion) return false;
  if (!Number.isFinite(ticket.e) || ticket.e <= 0 || ticket.e < nowSeconds) return false;
  if (!Number.isFinite(ticket.L) || ticket.L <= 0) return false;
  if (ticket.cfgId !== cfgId) return false;
  if (!powSecret) return false;
  const bindingValues = await getPowBindingValues(request, canonicalPath, config);
  if (!bindingValues) return false;
  const { pathHash, ipScope, country, asn, tlsFingerprint } = bindingValues;
  const bindingString = makePowBindingString(
    ticket,
    url.hostname,
    pathHash,
    ipScope,
    country,
    asn,
    tlsFingerprint
  );
  const expectedMac = await hmacSha256Base64UrlNoPad(powSecret, bindingString);
  if (!timingSafeEqual(expectedMac, ticket.mac)) return false;
  const expectedSolMac = await hmacSha256Base64UrlNoPad(
    powSecret,
    `ok|${sol.ticketB64}|${sol.exp}`
  );
  if (!timingSafeEqual(expectedSolMac, sol.mac)) return false;
  return true;
};

const buildPowChallengeHtml = ({
  bindingStringB64,
  steps,
  ticketB64,
  pathHash,
  hashcashBits,
  segmentLen,
  reloadUrlB64,
  apiPrefixB64,
  esmUrlB64,
}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VerifyRequest</title>
</head>
<body>
<pre id="log">Starting...</pre>
<script type="module">
  const CFG = {
    bindingB64: "${bindingStringB64}",
    steps: ${steps},
    ticketB64: "${ticketB64}",
    pathHash: "${pathHash}",
    hashcashBits: ${hashcashBits},
    segmentLen: ${segmentLen},
    reloadUrlB64: "${reloadUrlB64}",
    apiPrefixB64: "${apiPrefixB64}",
    esmUrlB64: "${esmUrlB64}",
  };

  const logEl = document.getElementById("log");
  const lines = ["Starting..."];
  const render = () => {
    logEl.textContent = lines.join("\\n");
  };
  const log = (msg) => {
    lines.push(msg);
    render();
    return lines.length - 1;
  };
  const update = (idx, msg) => {
    if (idx < 0 || idx >= lines.length) return;
    lines[idx] = msg;
    render();
  };
  render();

  const decodeB64Url = (str) => {
    try {
      let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64.length % 4;
      if (pad) b64 += "=".repeat(4 - pad);
      return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    } catch(e) { return null; }
  };

  const normalizeApiPrefix = (prefix) => {
    if (!prefix || typeof prefix !== "string") return "/__pow";
    return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  };

  const postJson = async (url, body) => {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      throw new Error("Request Failed");
    }
    try {
      return await res.json();
    } catch {
      return {};
    }
  };

  (async () => {
    try {
      log("Loading solver...");
      const esmUrl = decodeB64Url(CFG.esmUrlB64);
      const module = await import(esmUrl);
      const computePoswCommit = module.computePoswCommit;
      if (typeof computePoswCommit !== "function") {
        throw new Error("Solver Missing");
      }
      const spinIndex = log("Computing hash chain...");
      const spinChars = "|/-\\\\";
      let spinFrame = 0;
      const spinTimer = setInterval(() => {
        update(spinIndex, "Computing hash chain... " + spinChars[spinFrame++ % spinChars.length]);
      }, 120);
      const binding = decodeB64Url(CFG.bindingB64);
      const commit = await computePoswCommit(binding, CFG.steps, {
        hashcashBits: CFG.hashcashBits,
        segmentLen: CFG.segmentLen,
      });
      clearInterval(spinTimer);
      update(spinIndex, "Computing hash chain... done");
      log("Root: " + String(commit.rootB64 || "").slice(0, 12) + "...");
      const apiPrefix = normalizeApiPrefix(decodeB64Url(CFG.apiPrefixB64));
      log("Submitting commit...");
      await postJson(apiPrefix + "/commit", {
        ticketB64: CFG.ticketB64,
        rootB64: commit.rootB64,
        pathHash: CFG.pathHash,
        nonce: commit.nonce,
      });
      log("Requesting challenge...");
      const chal = await postJson(apiPrefix + "/challenge", {});
      if (!chal || !Array.isArray(chal.indices)) {
        throw new Error("Challenge Failed");
      }
      log("Opening proofs...");
      const opens = await commit.open(chal.indices);
      await postJson(apiPrefix + "/open", { sid: chal.sid, opens });
      log("Access granted. Redirecting...");
      document.title = "Redirecting";
      const target = decodeB64Url(CFG.reloadUrlB64);
      window.location.replace(target);
    } catch (e) {
      log("ERROR: " + (e && e.message ? e.message : String(e)));
    }
  })();
</script>
</body>
</html>`;

const respondPowChallengeHtml = async (
  request,
  url,
  canonicalPath,
  nowSeconds,
  config,
  powSecret,
  cfgId
) => {
  const ttl = normalizeNumber(config.POW_CHAL_TTL_SEC, DEFAULTS.POW_CHAL_TTL_SEC) || 0;
  const exp = nowSeconds + Math.max(1, ttl);
  const steps = getPowSteps(config);
  const hashcashBits = Math.max(
    0,
    Math.floor(
      normalizeNumber(config.POW_HASHCASH_BITS, DEFAULTS.POW_HASHCASH_BITS)
    )
  );
  const bindingValues = await getPowBindingValues(request, canonicalPath, config);
  if (!bindingValues) {
    return respondText(request.headers.get("Origin") || "", "tls fingerprint missing", 403);
  }
  const { pathHash, ipScope, country, asn, tlsFingerprint } = bindingValues;
  const powVersion = normalizeNumber(config.POW_VERSION, DEFAULTS.POW_VERSION);
  const ticket = {
    v: powVersion,
    e: exp,
    L: steps,
    r: randomBase64Url(16),
    cfgId,
    mac: "",
  };
  const bindingString = makePowBindingString(
    ticket,
    url.hostname,
    pathHash,
    ipScope,
    country,
    asn,
    tlsFingerprint
  );
  ticket.mac = await hmacSha256Base64UrlNoPad(powSecret, bindingString);
  const ticketB64 = encodePowTicket(ticket);
  const bindingStringB64 = base64UrlEncodeNoPad(utf8ToBytes(bindingString));
  const reloadUrlB64 = base64UrlEncodeNoPad(utf8ToBytes(url.toString()));
  const apiPrefixB64 = base64UrlEncodeNoPad(utf8ToBytes(POW_API_PREFIX));
  const esmUrlB64 = base64UrlEncodeNoPad(utf8ToBytes(String(config.POW_ESM_URL)));
  const html = buildPowChallengeHtml({
    bindingStringB64,
    steps,
    ticketB64,
    pathHash,
    hashcashBits,
    segmentLen: Math.max(
      1,
      Math.min(
        steps,
        Math.floor(
          normalizeNumber(config.POW_SEGMENT_LEN, DEFAULTS.POW_SEGMENT_LEN)
        )
      )
    ),
    reloadUrlB64,
    apiPrefixB64,
    esmUrlB64,
  });
  const headers = safeHeaders(request.headers.get("Origin") || "");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(html, { status: 200, headers });
};

const readJsonBody = async (request) => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

const setCookie = (headers, name, value, maxAge) => {
  const parts = [
    `${name}=${encodeURIComponent(String(value || ""))}`,
    "Path=/",
    "Secure",
    "SameSite=None",
    "HttpOnly",
  ];
  if (typeof maxAge === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  }
  headers.append("Set-Cookie", parts.join("; "));
};

const clearCookie = (headers, name) => {
  setCookie(headers, name, "deleted", 0);
};

const getPowSecret = (config) => {
  const signSecret = typeof config.HMAC_SECRET === "string" ? config.HMAC_SECRET : "";
  const powToken = typeof config.POW_TOKEN === "string" ? config.POW_TOKEN : "";
  return powToken || signSecret;
};

const randomInt = (max) => {
  const limit = Math.max(1, Math.floor(Number(max) || 1));
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % limit;
};

const sampleIndices = (maxIndex, extraCount, forceEdge1, forceEdgeLast) => {
  const max = Math.floor(Number(maxIndex) || 0);
  if (max <= 0) return [];
  const out = new Set();
  if (forceEdge1 && max >= 1) out.add(1);
  if (forceEdgeLast && max >= 1) out.add(max);
  const extra = Math.max(0, Math.floor(Number(extraCount) || 0));
  const lo = 2;
  const hi = max - 1;
  const len = Math.max(0, hi - lo + 1);
  if (extra > 0 && len > 0) {
    const bucketCount = Math.min(extra, len);
    for (let b = 0; b < bucketCount; b++) {
      const bLo = lo + Math.floor((b * len) / bucketCount);
      const bHi = lo + Math.floor(((b + 1) * len) / bucketCount) - 1;
      const width = Math.max(1, bHi - bLo + 1);
      const pick = bLo + randomInt(width);
      out.add(pick);
    }
  }
  return Array.from(out).sort((a, b) => a - b);
};

const handlePowCommit = async (request, url, nowSeconds) => {
  const origin = request.headers.get("Origin") || "";
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") {
    return respondText(origin, "invalid payload", 400);
  }
  const ticketB64 = typeof body.ticketB64 === "string" ? body.ticketB64 : "";
  const rootB64 = typeof body.rootB64 === "string" ? body.rootB64 : "";
  const pathHash = typeof body.pathHash === "string" ? body.pathHash : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  if (!ticketB64 || !rootB64 || !nonce) {
    return respondText(origin, "invalid payload", 400);
  }
  const ticket = parsePowTicket(ticketB64);
  if (!ticket) return deny(origin, "ticket invalid");
  const baseConfig = getConfigById(ticket.cfgId);
  if (!baseConfig) return deny(origin, "config invalid");
  const config = { ...DEFAULTS, ...baseConfig };
  const powSecret = getPowSecret(config);
  if (!powSecret) return respondText(origin, "misconfigured", 500);
  if (config.powcheck !== true) return respondText(origin, "misconfigured", 500);
  const powVersion = normalizeNumber(config.POW_VERSION, DEFAULTS.POW_VERSION);
  if (ticket.v !== powVersion) return deny(origin, "ticket invalid");
  if (isExpired(ticket.e, nowSeconds)) return deny(origin, "ticket expired");
  if (nonce.length > 128) {
    return respondText(origin, "invalid payload", 400);
  }
  const bindPath = config.POW_BIND_PATH !== false;
  const normalizedPathHash = bindPath ? pathHash : "any";
  if (bindPath && !normalizedPathHash) {
    return respondText(origin, "invalid path", 400);
  }
  const bindingValues = await getPowBindingValuesWithPathHash(
    request,
    normalizedPathHash,
    config
  );
  if (!bindingValues) return respondText(origin, "tls fingerprint missing", 403);
  const bindingString = makePowBindingString(
    ticket,
    url.hostname,
    bindingValues.pathHash,
    bindingValues.ipScope,
    bindingValues.country,
    bindingValues.asn,
    bindingValues.tlsFingerprint
  );
  const expectedMac = await hmacSha256Base64UrlNoPad(powSecret, bindingString);
  if (!timingSafeEqual(expectedMac, ticket.mac)) return deny(origin, "ticket invalid");
  const rootBytes = base64UrlDecodeToBytes(rootB64);
  if (!rootBytes || rootBytes.length !== 32) {
    return respondText(origin, "invalid root", 400);
  }
  const ttl = normalizeNumber(config.POW_CHAL_TTL_SEC, DEFAULTS.POW_CHAL_TTL_SEC) || 0;
  const exp = nowSeconds + Math.max(1, ttl);
  const mac = await hmacSha256Base64UrlNoPad(
    powSecret,
    `commit|${ticketB64}|${rootB64}|${bindingValues.pathHash}|${nonce}|${exp}`
  );
  const value = `v2.${ticketB64}.${rootB64}.${bindingValues.pathHash}.${nonce}.${exp}.${mac}`;
  const headers = safeHeaders(origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  setCookie(headers, DEFAULTS.POW_COMMIT_COOKIE, value, ttl);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};

const handlePowChallenge = async (request, url, nowSeconds) => {
  const origin = request.headers.get("Origin") || "";
  const cookies = parseCookieHeader(request.headers.get("Cookie"));
  const commitRaw = cookies.get(DEFAULTS.POW_COMMIT_COOKIE) || "";
  const commit = parsePowCommitCookie(commitRaw);
  if (!commit) return deny(origin, "commit missing");
  const ticket = parsePowTicket(commit.ticketB64);
  if (!ticket) return deny(origin, "ticket invalid");
  const baseConfig = getConfigById(ticket.cfgId);
  if (!baseConfig) return deny(origin, "config invalid");
  const config = { ...DEFAULTS, ...baseConfig };
  const powSecret = getPowSecret(config);
  if (!powSecret) return respondText(origin, "misconfigured", 500);
  if (config.powcheck !== true) return respondText(origin, "misconfigured", 500);
  if (isExpired(commit.exp, nowSeconds)) return deny(origin, "commit expired");
  if (isExpired(ticket.e, nowSeconds)) return deny(origin, "ticket expired");
  const expectedMac = await hmacSha256Base64UrlNoPad(
    powSecret,
    `commit|${commit.ticketB64}|${commit.rootB64}|${commit.pathHash}|${commit.nonce}|${commit.exp}`
  );
  if (!timingSafeEqual(expectedMac, commit.mac)) return deny(origin, "commit invalid");
  const powVersion = normalizeNumber(config.POW_VERSION, DEFAULTS.POW_VERSION);
  if (ticket.v !== powVersion) return deny(origin, "ticket invalid");
  if (!Number.isFinite(ticket.L) || ticket.L <= 0) return deny(origin, "ticket invalid");
  const indices = sampleIndices(
    ticket.L,
    normalizeNumber(config.POW_SAMPLE_K, DEFAULTS.POW_SAMPLE_K),
    config.POW_FORCE_EDGE_1 === true,
    config.POW_FORCE_EDGE_LAST === true
  );
  if (!indices.length) return deny(origin, "challenge invalid");
  const sid = randomBase64Url(12);
  const ttl = normalizeNumber(config.POW_CHAL_TTL_SEC, DEFAULTS.POW_CHAL_TTL_SEC) || 0;
  const exp = nowSeconds + Math.max(1, ttl);
  const indicesStr = indices.join(",");
  const mac = await hmacSha256Base64UrlNoPad(
    powSecret,
    `chal|${sid}|${commit.ticketB64}|${indicesStr}|${exp}`
  );
  const value = `v2.${sid}.${commit.ticketB64}.${indicesStr}.${exp}.${mac}`;
  const headers = safeHeaders(origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  setCookie(headers, DEFAULTS.POW_CHAL_COOKIE, value, ttl);
  return new Response(JSON.stringify({ sid, L: ticket.L, indices }), { status: 200, headers });
};

const handlePowOpen = async (request, url, nowSeconds) => {
  const origin = request.headers.get("Origin") || "";
  const cookies = parseCookieHeader(request.headers.get("Cookie"));
  const commitRaw = cookies.get(DEFAULTS.POW_COMMIT_COOKIE) || "";
  const chalRaw = cookies.get(DEFAULTS.POW_CHAL_COOKIE) || "";
  const commit = parsePowCommitCookie(commitRaw);
  const chal = parsePowChalCookie(chalRaw);
  if (!commit || !chal) return deny(origin, "challenge missing");
  if (commit.ticketB64 !== chal.ticketB64) return deny(origin, "challenge invalid");
  const ticket = parsePowTicket(commit.ticketB64);
  if (!ticket) return deny(origin, "ticket invalid");
  const baseConfig = getConfigById(ticket.cfgId);
  if (!baseConfig) return deny(origin, "config invalid");
  const config = { ...DEFAULTS, ...baseConfig };
  const powSecret = getPowSecret(config);
  if (!powSecret) return respondText(origin, "misconfigured", 500);
  if (config.powcheck !== true) return respondText(origin, "misconfigured", 500);
  const powVersion = normalizeNumber(config.POW_VERSION, DEFAULTS.POW_VERSION);
  if (ticket.v !== powVersion) return deny(origin, "ticket invalid");
  if (isExpired(commit.exp, nowSeconds) || isExpired(chal.exp, nowSeconds)) {
    return deny(origin, "challenge expired");
  }
  if (isExpired(ticket.e, nowSeconds)) return deny(origin, "ticket expired");
  const commitMac = await hmacSha256Base64UrlNoPad(
    powSecret,
    `commit|${commit.ticketB64}|${commit.rootB64}|${commit.pathHash}|${commit.nonce}|${commit.exp}`
  );
  if (!timingSafeEqual(commitMac, commit.mac)) return deny(origin, "commit invalid");
  const chalMac = await hmacSha256Base64UrlNoPad(
    powSecret,
    `chal|${chal.sid}|${chal.ticketB64}|${chal.indicesStr}|${chal.exp}`
  );
  if (!timingSafeEqual(chalMac, chal.mac)) return deny(origin, "challenge invalid");
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") {
    return respondText(origin, "invalid payload", 400);
  }
  const sid = typeof body.sid === "string" ? body.sid : "";
  const opens = Array.isArray(body.opens) ? body.opens : null;
  if (!sid || !opens) return respondText(origin, "invalid payload", 400);
  if (sid !== chal.sid) return deny(origin, "challenge invalid");
  const indices = parseIndicesStr(chal.indicesStr);
  if (!indices || indices.length !== opens.length) return deny(origin, "challenge invalid");
  const openMap = new Map();
  for (const open of opens) {
    const idx = open && Number.parseInt(open.i, 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > ticket.L) {
      return respondText(origin, "invalid payload", 400);
    }
    if (openMap.has(idx)) return respondText(origin, "invalid payload", 400);
    openMap.set(idx, open);
  }
  for (const idx of indices) {
    if (!openMap.has(idx)) return deny(origin, "challenge invalid");
  }
  const bindingValues = await getPowBindingValuesWithPathHash(
    request,
    commit.pathHash,
    config
  );
  if (!bindingValues) return respondText(origin, "tls fingerprint missing", 403);
  const bindingString = makePowBindingString(
    ticket,
    url.hostname,
    bindingValues.pathHash,
    bindingValues.ipScope,
    bindingValues.country,
    bindingValues.asn,
    bindingValues.tlsFingerprint
  );
  const expectedMac = await hmacSha256Base64UrlNoPad(powSecret, bindingString);
  if (!timingSafeEqual(expectedMac, ticket.mac)) return deny(origin, "ticket invalid");
  const rootBytes = base64UrlDecodeToBytes(commit.rootB64);
  if (!rootBytes || rootBytes.length !== 32) return deny(origin, "commit invalid");
  const leafCount = Math.max(0, Math.floor(ticket.L)) + 1;
  if (leafCount < 2) return deny(origin, "ticket invalid");
  const hashcashBits = Math.max(
    0,
    Math.floor(
      normalizeNumber(config.POW_HASHCASH_BITS, DEFAULTS.POW_HASHCASH_BITS)
    )
  );
  const segmentLen = Math.max(
    1,
    Math.min(
      ticket.L,
      Math.floor(
        normalizeNumber(config.POW_SEGMENT_LEN, DEFAULTS.POW_SEGMENT_LEN)
      )
    )
  );
  if (hashcashBits > 0 && !openMap.has(ticket.L)) return deny(origin, "challenge invalid");
  const seedHash = await hashPoswSeed(bindingString, commit.nonce);
  let hashcashOk = hashcashBits <= 0;
  for (const idx of indices) {
    const open = openMap.get(idx);
    const hPrevBytes = base64UrlDecodeToBytes(String(open.hPrev || ""));
    const hCurrBytes = base64UrlDecodeToBytes(String(open.hCurr || ""));
    if (!hPrevBytes || !hCurrBytes || hPrevBytes.length !== 32 || hCurrBytes.length !== 32) {
      return respondText(origin, "invalid payload", 400);
    }
    const proofPrev = open.proofPrev;
    const proofCurr = open.proofCurr;
    if (!proofPrev || !proofCurr) return respondText(origin, "invalid payload", 400);
    const effectiveSegmentLen = Math.min(segmentLen, idx);
    let prevBytes = hPrevBytes;
    const firstIdx = idx - effectiveSegmentLen;
    if (firstIdx < 0) return deny(origin, "challenge invalid");
    for (let step = 1; step <= effectiveSegmentLen; step++) {
      const expected = await hashPoswStep(prevBytes, firstIdx + step);
      if (step === effectiveSegmentLen) {
        if (!bytesEqual(expected, hCurrBytes)) return deny(origin, "challenge invalid");
      } else {
        prevBytes = expected;
      }
    }
    if (idx === 1 && !bytesEqual(hPrevBytes, seedHash)) {
      return deny(origin, "challenge invalid");
    }
    if (idx === ticket.L && hashcashBits > 0) {
      if (leadingZeroBits(hCurrBytes) < hashcashBits) {
        return deny(origin, "challenge invalid");
      }
      hashcashOk = true;
    }
    const okPrev = await verifyMerkleProof(
      rootBytes,
      hPrevBytes,
      idx - effectiveSegmentLen,
      leafCount,
      proofPrev
    );
    if (!okPrev) return deny(origin, "challenge invalid");
    const okCurr = await verifyMerkleProof(
      rootBytes,
      hCurrBytes,
      idx,
      leafCount,
      proofCurr
    );
    if (!okCurr) return deny(origin, "challenge invalid");
  }
  if (!hashcashOk) return deny(origin, "challenge invalid");
  const solTtl = normalizeNumber(config.POW_SOL_TTL_SEC, DEFAULTS.POW_SOL_TTL_SEC) || 0;
  const remaining = ticket.e - nowSeconds;
  const ttl = Math.max(1, Math.min(solTtl, remaining));
  if (!Number.isFinite(ttl) || ttl <= 0) return deny(origin, "ticket expired");
  const exp = nowSeconds + ttl;
  const solMac = await hmacSha256Base64UrlNoPad(
    powSecret,
    `ok|${commit.ticketB64}|${exp}`
  );
  const solValue = `v2.${commit.ticketB64}.${exp}.${solMac}`;
  const headers = safeHeaders(origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  setCookie(headers, DEFAULTS.POW_SOL_COOKIE, solValue, ttl);
  clearCookie(headers, DEFAULTS.POW_COMMIT_COOKIE);
  clearCookie(headers, DEFAULTS.POW_CHAL_COOKIE);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};

const handlePowApi = async (request, url, nowSeconds) => {
  const origin = request.headers.get("Origin") || "";
  if (request.method !== "POST") {
    return respondText(origin, "method not allowed", 405);
  }
  const path = normalizePath(url.pathname);
  if (!path || !path.startsWith(`${POW_API_PREFIX}/`)) {
    return respondText(origin, "not found", 404);
  }
  const action = path.slice(POW_API_PREFIX.length);
  if (action === "/commit") {
    return handlePowCommit(request, url, nowSeconds);
  }
  if (action === "/challenge") {
    return handlePowChallenge(request, url, nowSeconds);
  }
  if (action === "/open") {
    return handlePowOpen(request, url, nowSeconds);
  }
  return respondText(origin, "not found", 404);
};

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const hostname = url.hostname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: safeHeaders(origin) });
    }

    const nowSeconds = Math.floor(Date.now() / 1000);

    const requestPath = normalizePath(url.pathname);
    if (!requestPath) return respondText(origin, "invalid path", 400);
    if (requestPath.startsWith(`${POW_API_PREFIX}/`)) {
      return handlePowApi(request, url, nowSeconds);
    }
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
    }

    const selected = pickConfigWithId(hostname, matchPath);
    const config = selected ? { ...DEFAULTS, ...selected.config } : null;
    if (!config) return respondText(origin, "misconfigured", 500);
    const cfgId = selected.cfgId;
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

    const powOk = await verifyPowSol(
      request,
      url,
      authPath,
      nowSeconds,
      config,
      powSecret,
      cfgId
    );
    if (powOk) {
      return fetch(request);
    }

    if (!isNavigationRequest(request)) {
      return respondJson(origin, { code: "pow_required" }, 403);
    }

    return respondPowChallengeHtml(request, url, authPath, nowSeconds, config, powSecret, cfgId);
  },
};
