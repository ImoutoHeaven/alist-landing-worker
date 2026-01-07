# Cloudflare Snippet: `sign.js` (signature gate)

This directory contains the Cloudflare Snippet that implements URL signature validation (`?sign=`) plus a small amount of request-path semantics used by the AList landing/proxy setup.

The stateless PoW/Turnstile snippet and its client assets have been moved to:

- `git@github.com:ImoutoHeaven/snippet-posw.git`

## Files

- `sign.js`: validates `?sign=` for matched routes; optional `/info?path=...` path substitution and `/d`/`/p` prefix normalization.
- `build.mjs`: builds `sign.js` to `dist/snippet.js` for Cloudflare Snippets.
- `dist/snippet.js`: build output (ready to paste into Cloudflare Snippets).

## Cloudflare Snippets Order

If you deploy PoW/Turnstile + sign together, ensure:

1. PoW/Turnstile snippet (from `snippet-posw`)
2. `sign.js` (this directory)

## Configuration

Edit `CONFIG` in `sign.js`:

```js
const CONFIG = [
  // Basic: validate ?sign= for all paths
  { pattern: "alist-landing-*.example.com/**", config: { HMAC_SECRET: "replace-me", stripDownloadPrefix: true } },

  // /info?path=... semantics (path substitution for signature input)
  { pattern: "alist-landing-*.example.com/info", config: { HMAC_SECRET: "replace-me", enableInfoEndpoint: true } },
];
```

### Supported keys

- `HMAC_SECRET` (`string`): enable `?sign=` validation; empty disables sign check (pass-through).
- `stripDownloadPrefix` (`boolean`): normalize `/d/...` and `/p/...` to the underlying path for signature input.
- `enableInfoEndpoint` (`boolean`): treat `/info?path=...` as a proxy-style endpoint; signature input comes from query param `path`.

### `sign` format

`sign = base64url(HMAC_SHA256(HMAC_SECRET, authPath + ":" + expire)) + ":" + expire`

Where `expire` is a unix timestamp in seconds.

## Build

```bash
node build.mjs
```

Output: `dist/snippet.js`.
