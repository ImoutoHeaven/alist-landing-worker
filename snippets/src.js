// Cloudflare Snippet: pre-auth for landing
// Set HMAC_SECRET in CONFIG to common.tokenHmacKey (and keep common.signSecret aligned).

const DEFAULTS = {
  powcheck: false,
  POW_VERSION: 1,
  POW_DIFFICULTY_BASE: 18,
  POW_DIFFICULTY_COEFF: 1.0,
  POW_CHAL_TTL_SEC: 120,
  POW_SOL_TTL_SEC: 600,
  IPV4_PREFIX: 32,
  IPV6_PREFIX: 64,
  POW_SOL_COOKIE: "__Host-pow_sol",
  POW_ESM_URL:
    "https://cdn.jsdelivr.net/gh/ImoutoHeaven/alist-landing-worker@controller-overhaul/snippets/esm/esm.js",
};

const CONFIG = [
  // Example:
  // { pattern: "alist-landing-*.example.com", config: { HMAC_SECRET: "replace-with-common-tokenHmacKey", powcheck: true, POW_DIFFICULTY_BASE: 20, POW_DIFFICULTY_COEFF: 1.2, POW_CHAL_TTL_SEC: 180, POW_SOL_TTL_SEC: 600, IPV4_PREFIX: 32, IPV6_PREFIX: 64 } },
];

const compilePattern = (pattern) => {
  if (typeof pattern !== "string") return null;
  const trimmed = pattern.trim().toLowerCase();
  if (!trimmed) return null;
  const escaped = trimmed.replace(/\./g, "\\.").replace(/\*/g, "[^.]*");
  try {
    return new RegExp(`^${escaped}$`);
  } catch {
    return null;
  }
};

const COMPILED_CONFIG = CONFIG.map((entry) => ({
  pattern: entry && entry.pattern,
  regex: compilePattern(entry && entry.pattern),
  config: (entry && entry.config) || {},
}));

const pickConfig = (hostname) => {
  const host = typeof hostname === "string" ? hostname.toLowerCase() : "";
  if (!host) return null;
  for (const rule of COMPILED_CONFIG) {
    if (!rule || !rule.regex) continue;
    if (rule.regex.test(host)) return rule.config || null;
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

const verifyPowSol = async (request, url, canonicalPath, nowSeconds, config) => {
  const cookies = parseCookieHeader(request.headers.get("Cookie"));
  const solRaw = cookies.get(config.POW_SOL_COOKIE) || "";
  const sol = parsePowSolCookie(solRaw);
  if (!sol) return false;
  const ticket = sol.ticket;
  const powVersion = normalizeNumber(config.POW_VERSION, DEFAULTS.POW_VERSION);
  if (ticket.v !== powVersion) return false;
  if (!Number.isFinite(ticket.e) || ticket.e <= 0 || ticket.e < nowSeconds) return false;
  const ip = getClientIP(request);
  const ipScope = computeIpScope(ip, config);
  const pathHash = base64UrlEncodeNoPad(await sha256Bytes(canonicalPath));
  const bindingString = makePowBindingString(ticket, url.hostname, pathHash, ipScope);
  const expectedMac = await hmacSha256Base64UrlNoPad(config.HMAC_SECRET, bindingString);
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
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Command Prompt - Security Check</title>
<style>
  :root {
    --win-bg: #c0c0c0;
    --win-border-light: #dfdfdf;
    --win-border-dark: #808080;
    --win-border-black: #000000;
    --win-title-l: #000080;
    --win-title-r: #1084d0;
    --term-bg: #000000;
    --term-fg: #c0c0c0; /* Classic CMD gray/white */
    --term-font: "Consolas", "Lucida Console", "Monaco", "Courier New", monospace;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0; padding: 0;
    height: 100vh;
    width: 100vw;
    background-color: #2e2e2e; /* Dark desktop background */
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--term-font);
    overflow: hidden;
    /* Subtle CRT flicker on the whole screen */
    animation: flicker 0.15s infinite;
  }

  @keyframes flicker {
    0% { opacity: 0.99; }
    100% { opacity: 1; }
  }

  /* --- Windows 9x Style Window --- */
  .window {
    width: 90%;
    max-width: 800px;
    height: 70vh;
    min-height: 320px;
    background-color: var(--win-bg);
    border-top: 2px solid var(--win-border-light);
    border-left: 2px solid var(--win-border-light);
    border-right: 2px solid var(--win-border-black);
    border-bottom: 2px solid var(--win-border-black);
    box-shadow: 1px 1px 0 0 var(--win-border-dark) inset, 0 0 20px rgba(0,0,0,0.5);
    display: flex;
    flex-direction: column;
    padding: 3px;
  }

  .title-bar {
    height: 24px;
    background: linear-gradient(90deg, var(--win-title-l), var(--win-title-r));
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px;
    margin-bottom: 3px;
    user-select: none;
  }

  .title-text {
    color: white;
    font-weight: bold;
    font-size: 13px;
    letter-spacing: 0.5px;
    font-family: Tahoma, sans-serif;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  
  .icon-prompt {
    width: 14px; 
    height: 14px;
    background: white;
    border: 1px solid gray;
    position: relative;
  }
  .icon-prompt::after {
    content: "C_";
    color: black;
    font-size: 10px;
    position: absolute;
    top: -2px; left: 1px;
    font-family: monospace;
    font-weight: bold;
  }

  .controls {
    display: flex;
    gap: 2px;
  }

  .btn {
    width: 16px;
    height: 14px;
    background-color: var(--win-bg);
    border-top: 1px solid var(--win-border-light);
    border-left: 1px solid var(--win-border-light);
    border-right: 1px solid var(--win-border-black);
    border-bottom: 1px solid var(--win-border-black);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-family: Tahoma, sans-serif;
    font-weight: bold;
    color: black;
    cursor: default;
    box-shadow: 1px 1px 0 var(--win-border-dark);
  }
  
  .btn:active {
    border-top: 1px solid var(--win-border-black);
    border-left: 1px solid var(--win-border-black);
    border-right: 1px solid var(--win-border-light);
    border-bottom: 1px solid var(--win-border-light);
    transform: translate(1px, 1px);
    box-shadow: none;
  }

  .terminal-content {
    flex: 1;
    background-color: var(--term-bg);
    color: var(--term-fg);
    border-top: 2px solid var(--win-border-dark);
    border-left: 2px solid var(--win-border-dark);
    border-right: 2px solid var(--win-border-light);
    border-bottom: 2px solid var(--win-border-light);
    padding: 8px;
    font-size: 14px; /* Standard CMD size */
    line-height: 1.4;
    overflow-y: auto;
    overflow-x: hidden;
    position: relative;
  }

  /* Custom Scrollbar for Webkit to match CMD dark theme */
  .terminal-content::-webkit-scrollbar { width: 12px; }
  .terminal-content::-webkit-scrollbar-track { background: #222; }
  .terminal-content::-webkit-scrollbar-thumb { background: #555; border: 1px solid #222; }

  /* Utilities */
  .line { margin-bottom: 0px; word-break: break-all; }
  .cursor {
    display: inline-block;
    width: 8px;
    height: 14px;
    background-color: var(--term-fg);
    vertical-align: text-bottom;
    animation: blink 1s step-end infinite;
  }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

  .hidden { display: none; }
  .green { color: #00ff00; }
  .yellow { color: #ffff00; }
  .red { color: #ff3333; }
  .cyan { color: #00ffff; }
  .bold { font-weight: bold; color: #fff; }

</style>
</head>
<body>

  <div class="window">
    <div class="title-bar">
      <div class="title-text">
        <div class="icon-prompt"></div>
        Administrator: Command Prompt
      </div>
      <div class="controls">
        <div class="btn">_</div>
        <div class="btn">□</div>
        <div class="btn">X</div>
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
    bootDelay: 400,
  };

  // --- Utils ---
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  
  const decodeB64Url = (str) => {
    try {
      const b64 = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + (4 - str.length % 4) % 4, "=");
      return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    } catch(e) { return null; }
  };
  
  const encodeB64Url = (str) => {
    const bytes = new TextEncoder().encode(str);
    return btoa(String.fromCharCode(...bytes)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
  };

  // --- Terminal Class ---
  class Terminal {
    constructor(el) {
      this.el = el;
      this.promptStr = "C:\\Windows\\System32>";
      this.cursor = document.createElement("span");
      this.cursor.className = "cursor";
      // Initialize empty
      this.currentLine = this.createLine();
      this.el.appendChild(this.currentLine);
      this.currentLine.appendChild(this.cursor);
    }

    createLine() {
      const div = document.createElement("div");
      div.className = "line";
      return div;
    }

    // Print text without newline
    async write(text, className = "", delay = 0) {
      const span = document.createElement("span");
      if (className) span.className = className;
      this.currentLine.insertBefore(span, this.cursor);
      
      if (delay === 0) {
        span.textContent = text;
      } else {
        for (const char of text) {
          span.textContent += char;
          // Randomize typing speed slightly for realism
          await sleep(delay + Math.random() * 10);
          this.el.scrollTop = this.el.scrollHeight;
        }
      }
      this.el.scrollTop = this.el.scrollHeight;
    }

    // Print text with newline
    async println(text, className = "", delay = 0) {
      await this.write(text, className, delay);
      this.newLine();
    }

    // Start a new line and move cursor
    newLine() {
      this.currentLine = this.createLine();
      this.el.appendChild(this.currentLine);
      this.currentLine.appendChild(this.cursor);
      this.el.scrollTop = this.el.scrollHeight;
    }

    // Show the standard prompt
    async showPrompt() {
      this.newLine();
      await this.write(this.promptStr, "", 0);
      await this.write(" ", "", 0); // Spacer
    }
  }

  // --- Main Logic ---
  async function boot() {
    const term = new Terminal($("console"));

    try {
      // Header Info
      await term.println("Microsoft Windows [Version 10.0.19045.2486]");
      await term.println("(c) Microsoft Corporation. All rights reserved.");
      await term.println("");
      
      await term.write(term.promptStr + " ");
      await term.write("alist-guard.exe --verify --pow", "bold", 30); // Simulated typing
      await sleep(300);
      term.newLine();

      // Step 1: Init
      await term.println("Initializing Alist Guardian Protocol v${DEFAULTS.POW_VERSION}.0...", "cyan");
      await sleep(200);
      
      // Step 2: Env Check
      await term.write("Checking Environment... ");
      await sleep(300);
      const cores = navigator.hardwareConcurrency || 1;
      await term.println("OK", "green");
      await term.println(\`  CPU Cores: \${cores}\`);
      await term.println(\`  Difficulty: \${CFG.difficulty}\`);

      // Step 3: Load Module
      await term.write("Loading Solver Module... ");
      const esmUrl = decodeB64Url(CFG.esmUrlB64);
      const loadStart = performance.now();
      
      let solvePow;
      try {
        const module = await import(esmUrl);
        solvePow = module.solvePow;
      } catch(e) {
        throw new Error("Failed to load solver module: " + e.message);
      }
      
      const loadTime = (performance.now() - loadStart).toFixed(2);
      await term.println(\`Done (\${loadTime}ms)\`, "green");

      // Step 4: Solve
      await term.write("Solving Challenge... ");
      
      // Spinner effect while solving
      const spinnerChars = ["|", "/", "-", "\\\\"];
      let spinIdx = 0;
      const spinSpan = document.createElement("span");
      term.currentLine.insertBefore(spinSpan, term.cursor);
      
      const spinnerInterval = setInterval(() => {
        spinSpan.textContent = spinnerChars[spinIdx++ % 4];
      }, 100);

      // Actual Computation
      // Yield to UI thread briefly so the spinner renders
      await sleep(50); 
      
      const binding = decodeB64Url(CFG.bindingB64);
      const solveStart = performance.now();
      const nonce = await solvePow(binding, CFG.difficulty);
      const solveTime = (performance.now() - solveStart).toFixed(0);

      clearInterval(spinnerInterval);
      spinSpan.textContent = ""; // Clear spinner

      await term.println(\`Hash found!\`, "green");
      await term.println(\`  Nonce: \${nonce}\`);
      await term.println(\`  Time:  \${solveTime}ms\`);

      // Step 5: Auth
      await term.write("Authenticating Ticket... ");
      
      const nonceB64 = encodeB64Url(String(nonce));
      const cookieVal = \`\${CFG.ticketB64}.\${nonceB64}\`;
      document.cookie = \`\${CFG.solCookieName}=\${cookieVal}; Max-Age=\${CFG.solMaxAge}; Path=/; Secure; SameSite=None\`;
      
      await sleep(300);
      await term.println("Authorized.", "green");

      // Redirect
      await term.println("");
      await term.println("Redirecting to target...", "yellow");
      
      const target = decodeB64Url(CFG.reloadUrlB64);
      setTimeout(() => {
        window.location.replace(target);
      }, 800);

    } catch (e) {
      console.error(e);
      term.newLine();
      await term.println("FATAL ERROR:", "red");
      await term.println(e.message || "Unknown Error", "red");
      await term.println("");
      await term.println("Please refresh the page to try again.");
      term.newLine();
      await term.write(term.promptStr + " ");
    }
  }

  // Start
  setTimeout(boot, CFG.bootDelay);

</script>
</body>
</html>`;

const respondPowChallengeHtml = async (request, url, canonicalPath, nowSeconds, config) => {
  const ttl = normalizeNumber(config.POW_CHAL_TTL_SEC, DEFAULTS.POW_CHAL_TTL_SEC) || 0;
  const exp = nowSeconds + Math.max(1, ttl);
  const difficulty = getPowDifficulty(config);
  const ip = getClientIP(request);
  const ipScope = computeIpScope(ip, config);
  const pathHash = base64UrlEncodeNoPad(await sha256Bytes(canonicalPath));
  const powVersion = normalizeNumber(config.POW_VERSION, DEFAULTS.POW_VERSION);
  const ticket = {
    v: powVersion,
    e: exp,
    d: difficulty,
    r: randomBase64Url(16),
    mac: "",
  };
  const bindingString = makePowBindingString(ticket, url.hostname, pathHash, ipScope);
  ticket.mac = await hmacSha256Base64UrlNoPad(config.HMAC_SECRET, bindingString);
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
    const selected = pickConfig(hostname);
    const config = selected ? { ...DEFAULTS, ...selected } : null;
    const secret = config && typeof config.HMAC_SECRET === "string" ? config.HMAC_SECRET : "";
    if (!secret) return respondText(origin, "misconfigured", 500);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: safeHeaders(origin) });
    }

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

    const expected = await hmacSha256Sign(secret, authPath, signMeta.expire);
    if (expected !== sign) return deny(origin, "sign mismatch");

    if (config.powcheck !== true) {
      return fetch(request);
    }

    if (!config.POW_ESM_URL) {
      return respondText(origin, "misconfigured", 500);
    }

    const powOk = await verifyPowSol(request, url, authPath, nowSeconds, config);
    if (powOk) {
      return fetch(request);
    }

    if (!isNavigationRequest(request)) {
      return respondJson(origin, { code: "pow_required" }, 403);
    }

    return respondPowChallengeHtml(request, url, authPath, nowSeconds, config);
  },
};
