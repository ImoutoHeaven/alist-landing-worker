// Cloudflare Snippet: pre-auth for landing
// Set HMAC_SECRET to common.tokenHmacKey (and keep common.signSecret aligned).
const HMAC_SECRET = "replace-with-common-tokenHmacKey";

const encoder = new TextEncoder();
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

const parseSignature = (sig) => {
  if (!sig || typeof sig !== "string") return null;
  const idx = sig.lastIndexOf(":");
  if (idx <= 0 || idx === sig.length - 1) return null;
  const expire = Number.parseInt(sig.slice(idx + 1), 10);
  if (Number.isNaN(expire)) return null;
  return { expire };
};

const isExpired = (expire, nowSeconds) => expire > 0 && expire < nowSeconds;

const hmacSha256Sign = async (data, expire) => {
  const key = await getHmacKey();
  const payload = `${data}:${expire}`;
  const buf = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${base64UrlEncode(new Uint8Array(buf))}:${expire}`;
};

const deny = (msg) =>
  new Response(msg, { status: 403, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request, env, ctx) {
    if (!HMAC_SECRET) return new Response("misconfigured", { status: 500 });

    const url = new URL(request.url);
    const nowSeconds = Math.floor(Date.now() / 1000);

    const path = normalizePath(url.pathname);
    if (!path) return new Response("invalid path", { status: 400 });

    const sign = url.searchParams.get("sign") || "";
    const signMeta = parseSignature(sign);
    if (!signMeta) return deny("sign invalid");
    if (isExpired(signMeta.expire, nowSeconds)) return deny("sign expired");

    const expected = await hmacSha256Sign(path, signMeta.expire);
    if (expected !== sign) return deny("sign mismatch");

    return fetch(request);
  },
};
