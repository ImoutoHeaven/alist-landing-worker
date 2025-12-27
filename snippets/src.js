// Cloudflare Snippet: pre-auth for landing
// Set HMAC_SECRET to common.tokenHmacKey (and keep common.signSecret aligned).

// ===== Global Switch =====
const powcheck = false; // false: keep legacy behavior; true: enable PoW gate

// ===== Existing =====
const HMAC_SECRET = "replace-with-common-tokenHmacKey";

// ===== PoW =====
const POW_VERSION = 1;
const POW_DIFFICULTY_BASE = 18;
const POW_DIFFICULTY_COEFF = 1.0;
const POW_CHAL_TTL_SEC = 120;
const POW_SOL_TTL_SEC = 600;

const IPV4_PREFIX = 32;
const IPV6_PREFIX = 64;

const POW_SOL_COOKIE = "__Host-pow_sol";
const POW_ESM_URL =
  "https://cdn.jsdelivr.net/gh/ImoutoHeaven/alist-landing-worker@controller-overhaul/snippets/esm/esm.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let hmacKeyPromise = null;

const getHmacKey = () => {
  if (!hmacKeyPromise) {
    hmacKeyPromise = crypto.subtle.importKey(
      "raw",
      encoder.encode(HMAC_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
  }
  return hmacKeyPromise;
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

const hmacSha256 = async (data) => {
  const key = await getHmacKey();
  const payload = encoder.encode(data);
  const buf = await crypto.subtle.sign("HMAC", key, payload);
  return new Uint8Array(buf);
};

const hmacSha256Sign = async (data, expire) => {
  const payload = `${data}:${expire}`;
  const bytes = await hmacSha256(payload);
  return `${base64UrlEncode(bytes)}:${expire}`;
};

const hmacSha256Base64UrlNoPad = async (data) => {
  const bytes = await hmacSha256(data);
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

const computeIpScope = (ip) => {
  if (isIpv4(ip)) {
    return ipv4Cidr(ip, IPV4_PREFIX) || "unknown";
  }
  if (isIpv6(ip)) {
    return ipv6Cidr(ip, IPV6_PREFIX) || "unknown";
  }
  return "unknown";
};

const getPowDifficulty = () => {
  const base = Number(POW_DIFFICULTY_BASE);
  const coeff = Number(POW_DIFFICULTY_COEFF);
  if (!Number.isFinite(base) || base <= 0) return 1;
  if (!Number.isFinite(coeff) || coeff <= 0) return Math.max(1, Math.round(base));
  return Math.max(1, Math.round(base * coeff));
};

const getPowSolMaxAge = () =>
  Math.max(1, Math.min(Number(POW_SOL_TTL_SEC) || 0, Number(POW_CHAL_TTL_SEC) || 0));

const randomBase64Url = (byteLength) => {
  const len = Number.isInteger(byteLength) && byteLength > 0 ? byteLength : 16;
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeNoPad(bytes);
};

const makePowBindingString = (ticket, hostname, pathHash, ipScope) => {
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
    ipScope
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
  if (!r || !mac) return null;
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

const verifyPowSol = async (request, url, canonicalPath, nowSeconds) => {
  const cookies = parseCookieHeader(request.headers.get("Cookie"));
  const solRaw = cookies.get(POW_SOL_COOKIE) || "";
  const sol = parsePowSolCookie(solRaw);
  if (!sol) return false;
  const ticket = sol.ticket;
  if (ticket.v !== POW_VERSION) return false;
  if (!Number.isFinite(ticket.e) || ticket.e <= 0 || ticket.e < nowSeconds) return false;
  const ip = getClientIP(request);
  const ipScope = computeIpScope(ip);
  const pathHash = base64UrlEncodeNoPad(await sha256Bytes(canonicalPath));
  const bindingString = makePowBindingString(ticket, url.hostname, pathHash, ipScope);
  const expectedMac = await hmacSha256Base64UrlNoPad(bindingString);
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
}) => `<!doctype html>
<meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="cache-control" content="no-store">
<title>Verifying</title>
<script type="module">
  const bindingB64 = "${bindingStringB64}";
  const difficulty = ${difficulty};
  const reloadUrlB64 = "${reloadUrlB64}";
  const solCookieName = "${solCookieName}";
  const solMaxAge = ${solMaxAge};
  const ticketB64 = "${ticketB64}";
  const esmUrlB64 = "${esmUrlB64}";

  const decodeB64Url = (b64u) => {
    let b64 = b64u.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  const encodeB64Url = (bytes) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
  };

  try {
    const bindingString = decodeB64Url(bindingB64);
    const reloadUrl = decodeB64Url(reloadUrlB64);
    const esmUrl = decodeB64Url(esmUrlB64);
    const { solvePow } = await import(esmUrl);
    const nonce = await solvePow(bindingString, difficulty);
    const nonceB64 = encodeB64Url(new TextEncoder().encode(String(nonce || "")));
    document.cookie =
      solCookieName +
      "=" +
      ticketB64 +
      "." +
      nonceB64 +
      "; Max-Age=" +
      solMaxAge +
      "; Path=/; Secure; SameSite=None";
    document.title = "SubmitThisForm";
    location.replace(reloadUrl);
  } catch (e) {
    document.body.textContent = "PoW verification failed. Please refresh.";
  }
</script>
`;

const respondPowChallengeHtml = async (request, url, canonicalPath, nowSeconds) => {
  const ttl = Number(POW_CHAL_TTL_SEC) || 0;
  const exp = nowSeconds + Math.max(1, ttl);
  const difficulty = getPowDifficulty();
  const ip = getClientIP(request);
  const ipScope = computeIpScope(ip);
  const pathHash = base64UrlEncodeNoPad(await sha256Bytes(canonicalPath));
  const ticket = {
    v: POW_VERSION,
    e: exp,
    d: difficulty,
    r: randomBase64Url(16),
    mac: "",
  };
  const bindingString = makePowBindingString(ticket, url.hostname, pathHash, ipScope);
  ticket.mac = await hmacSha256Base64UrlNoPad(bindingString);
  const ticketB64 = encodePowTicket(ticket);
  const bindingStringB64 = base64UrlEncodeNoPad(utf8ToBytes(bindingString));
  const reloadUrlB64 = base64UrlEncodeNoPad(utf8ToBytes(url.toString()));
  const esmUrlB64 = base64UrlEncodeNoPad(utf8ToBytes(String(POW_ESM_URL)));
  const solMaxAge = getPowSolMaxAge();
  const html = buildPowChallengeHtml({
    bindingStringB64,
    difficulty,
    ticketB64,
    reloadUrlB64,
    solCookieName: POW_SOL_COOKIE,
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
    if (!HMAC_SECRET) return respondText(origin, "misconfigured", 500);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: safeHeaders(origin) });
    }

    const url = new URL(request.url);
    const nowSeconds = Math.floor(Date.now() / 1000);

    const requestPath = normalizePath(url.pathname);
    if (!requestPath) return respondText(origin, "invalid path", 400);
    const isInfoPath = requestPath === "/info";
    let authPath = requestPath;
    if (isInfoPath) {
      const rawPath = url.searchParams.get("path");
      if (!rawPath) return respondText(origin, "path is required", 400);
      authPath = decodePathParam(rawPath);
      if (!authPath) return respondText(origin, "invalid path encoding", 400);
    }

    const sign = url.searchParams.get("sign") || "";
    const signMeta = parseSignature(sign);
    if (!signMeta) return deny(origin, "sign invalid");
    if (isExpired(signMeta.expire, nowSeconds)) return deny(origin, "sign expired");

    const expected = await hmacSha256Sign(authPath, signMeta.expire);
    if (expected !== sign) return deny(origin, "sign mismatch");

    if (!powcheck) {
      return fetch(request);
    }

    if (!POW_ESM_URL) {
      return respondText(origin, "misconfigured", 500);
    }

    const powOk = await verifyPowSol(request, url, authPath, nowSeconds);
    if (powOk) {
      return fetch(request);
    }

    if (!isNavigationRequest(request)) {
      return respondJson(origin, { code: "pow_required" }, 403);
    }

    return respondPowChallengeHtml(request, url, authPath, nowSeconds);
  },
};
