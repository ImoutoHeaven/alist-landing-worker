# Deployment Guide

## Quick Start

### 1. Prerequisites
- Node.js 18+ installed
- Cloudflare account with Workers enabled
- Wrangler CLI installed globally: `npm install -g wrangler`

### 2. Initial Setup
```bash
cd alist-landing-worker
npm install
```

### 3. Configure Environment Variables

#### For Local Development
Create `.dev.vars` file:
```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your values:
```
TOKEN=your-actual-hmac-secret
WORKER_ADDRESS_DOWNLOAD=https://download1.example.com,https://download2.example.com
UNDER_ATTACK=false
FAST_REDIRECT=false

# Optional: Path blacklist/whitelist/except
BLACKLIST_PREFIX=/private,/admin
BLACKLIST_ACTION=block
WHITELIST_PREFIX=/public,/shared
WHITELIST_ACTION=pass-asis
EXCEPT_PREFIX=/guest,/public
EXCEPT_ACTION=block-except
```

#### For Production
Set environment variables in Cloudflare Dashboard:
1. Go to Workers & Pages > Your Worker > Settings > Variables
2. Add the following variables:
   - `TOKEN` (secret) - Your HMAC signing key
   - `WORKER_ADDRESS_DOWNLOAD` (plain) - Comma-separated worker URLs
   - `UNDER_ATTACK` (plain) - `true` or `false`
   - `FAST_REDIRECT` (plain) - `true` or `false` (enables direct 302 redirect)
   - `TURNSTILE_SITE_KEY` (plain) - If using Turnstile
   - `TURNSTILE_SECRET_KEY` (secret) - If using Turnstile
   - `BLACKLIST_PREFIX` (plain) - Optional: Comma-separated path prefixes to blacklist
   - `BLACKLIST_ACTION` (plain) - Optional: Action for blacklisted paths (block/verify/pass-web/pass-server/pass-asis)
   - `WHITELIST_PREFIX` (plain) - Optional: Comma-separated path prefixes to whitelist
   - `WHITELIST_ACTION` (plain) - Optional: Action for whitelisted paths
   - `EXCEPT_PREFIX` (plain) - Optional: Comma-separated path prefixes for inverse matching
   - `EXCEPT_ACTION` (plain) - Optional: Action format {action}-except (e.g., block-except)

### 4. Build the Project
```bash
npm run build
```

This creates `dist/worker.js` - a bundled, minified version of the worker.

**Build output:**
- `dist/worker.js` - Production-ready worker code
- `dist/worker.js.map` - Source map for debugging

### 5. Local Development
```bash
npm run dev
```

Visit http://localhost:8787/test-file.txt?sign=SIGNATURE to test.

**Note:** `npm run dev` uses the source files directly without building.

### 6. Deploy to Production
```bash
npm run deploy
```

This automatically runs `npm run build` before deploying.

Or manually:
```bash
npm run build
wrangler deploy
```

## Environment Variables Reference

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `TOKEN` | Secret | ✅ Yes | HMAC-SHA256 signing key for all signatures |
| `WORKER_ADDRESS_DOWNLOAD` | Plain | ✅ Yes | Download worker URLs (comma-separated for load balancing) |
| `SIGN_SECRET` | Secret | ❌ No | Separate signing key (defaults to TOKEN) |
| `UNDER_ATTACK` | Plain | ❌ No | Enable Turnstile protection (`true`/`false`) |
| `FAST_REDIRECT` | Plain | ❌ No | Enable direct 302 redirect mode (`true`/`false`, default: `false`). Only works when `UNDER_ATTACK=false` |
| `TURNSTILE_SITE_KEY` | Plain | ❌ No | Cloudflare Turnstile site key (required if UNDER_ATTACK=true) |
| `TURNSTILE_SECRET_KEY` | Secret | ❌ No | Cloudflare Turnstile secret key (required if UNDER_ATTACK=true) |
| `IPV4_ONLY` | Plain | ❌ No | Block IPv6 access (`true`/`false`) |
| `VERIFY_HEADER` | Plain | ❌ No | Custom verification header name |
| `VERIFY_SECRET` | Secret | ❌ No | Custom verification header value |
| `BLACKLIST_PREFIX` | Plain | ❌ No | Comma-separated path prefixes to blacklist. Requires `BLACKLIST_ACTION` to be set |
| `BLACKLIST_ACTION` | Plain | ❌ No | Action for blacklisted paths: `block`/`verify`/`pass-web`/`pass-server`/`pass-asis` |
| `WHITELIST_PREFIX` | Plain | ❌ No | Comma-separated path prefixes to whitelist. Requires `WHITELIST_ACTION` to be set |
| `WHITELIST_ACTION` | Plain | ❌ No | Action for whitelisted paths: `block`/`verify`/`pass-web`/`pass-server`/`pass-asis` |
| `EXCEPT_PREFIX` | Plain | ❌ No | Comma-separated path prefixes for inverse matching. Requires `EXCEPT_ACTION` to be set |
| `EXCEPT_ACTION` | Plain | ❌ No | Inverse action format `{action}-except` (e.g., `block-except`). Paths NOT matching EXCEPT_PREFIX will trigger the action |

## Testing

### Test Landing Page
```bash
curl https://your-worker.workers.dev/test-file.txt?sign=YOUR_SIGNATURE
```

Should return HTML landing page.

### Test Info Endpoint
```bash
curl 'https://your-worker.workers.dev/info?path=/test-file.txt&sign=YOUR_SIGNATURE' \
  -H 'cf-turnstile-response: TOKEN_IF_NEEDED'
```

Should return JSON:
```json
{
  "code": 200,
  "data": {
    "download": {
      "url": "https://download-worker.com/test-file.txt?sign=...&hashSign=...&ipSign=..."
    },
    "meta": {
      "path": "/test-file.txt"
    },
    "settings": {
      "underAttack": false
    }
  }
}
```

## Integration with Download Workers

This landing worker generates three signatures for the download worker:

1. **sign**: Original signature from URL (already verified)
   - Format: `HMAC-SHA256(path, expire)`
2. **hashSign**: Base64-encoded path signature
   - Format: `HMAC-SHA256(base64(path), expire)`
3. **ipSign**: Path and IP binding signature
   - Format: `HMAC-SHA256(JSON.stringify({path: "/file", ip: "1.2.3.4"}), expire)`
   - This prevents signature reuse across different files by the same IP

Your download worker (e.g., `simple-alist-cf-proxy`) should verify all three signatures.

### Fast Redirect Mode

When `FAST_REDIRECT=true` and `UNDER_ATTACK=false`:
- Users are **immediately redirected** (HTTP 302) to the download URL
- No landing page is shown
- Signature verification happens server-side before redirect
- Users experience faster downloads without clicking

When `FAST_REDIRECT=false` (default):
- Users see a landing page
- Client-side JavaScript calls `/info` endpoint
- User clicks "Download" button to start download

**Note:** Fast redirect is automatically disabled when `UNDER_ATTACK=true` to ensure Turnstile verification.

### Path Blacklist/Whitelist/Except

Control access to specific paths using blacklist, whitelist, and except prefixes:

#### Configuration

**Blacklist Example:**
```env
BLACKLIST_PREFIX=/private,/admin,/internal
BLACKLIST_ACTION=block
```

**Whitelist Example:**
```env
WHITELIST_PREFIX=/public,/shared,/downloads
WHITELIST_ACTION=pass-asis
```

**Except Example (Inverse Matching):**
```env
EXCEPT_PREFIX=/guest,/public
EXCEPT_ACTION=block-except
```
This configuration blocks all paths **except** those matching `/guest` or `/public`. Paths matching the except prefixes are allowed, while all others are blocked.

#### Available Actions

| Action | Behavior |
|--------|----------|
| `block` | Return 403 Forbidden, deny all access |
| `verify` | Force Turnstile verification regardless of `UNDER_ATTACK` setting |
| `pass-web` | Bypass Turnstile verification, force render landing page (ignore `FAST_REDIRECT`) |
| `pass-server` | Bypass Turnstile verification, force 302 redirect (ignore `UNDER_ATTACK`) |
| `pass-asis` | Bypass Turnstile verification, respect `FAST_REDIRECT` setting |

#### Priority Rules

1. **Blacklist** takes highest priority
2. **Whitelist** takes second priority
3. **Except** takes third priority (inverse matching logic)
4. **Default behavior** (based on `UNDER_ATTACK` and `FAST_REDIRECT`)

When a path matches multiple lists, the action from the highest priority list is executed.

**Except Inverse Logic:**
- If path **matches** any `EXCEPT_PREFIX` → action is **NOT** applied (path is excepted)
- If path **does NOT match** any `EXCEPT_PREFIX` → action **IS** applied

Example with `EXCEPT_ACTION=block-except` and `EXCEPT_PREFIX=/guest`:
- `/guest/file.txt` → Allowed (matches except prefix, block is NOT applied)
- `/admin/file.txt` → Blocked (doesn't match except prefix, block IS applied)

#### Activation Requirements

- Blacklist is **only active** when both `BLACKLIST_PREFIX` and `BLACKLIST_ACTION` are set
- Whitelist is **only active** when both `WHITELIST_PREFIX` and `WHITELIST_ACTION` are set
- Except is **only active** when both `EXCEPT_PREFIX` and `EXCEPT_ACTION` are set
- `EXCEPT_ACTION` must be in format `{action}-except` (e.g., `block-except`, `verify-except`)
- If either variable is empty/unset, that list is disabled

#### Use Cases

**Block sensitive paths:**
```env
BLACKLIST_PREFIX=/admin,/api/internal
BLACKLIST_ACTION=block
```

**Require verification for valuable content:**
```env
BLACKLIST_PREFIX=/premium,/exclusive
BLACKLIST_ACTION=verify
```

**Fast-track public downloads:**
```env
WHITELIST_PREFIX=/public
WHITELIST_ACTION=pass-server
```

**Force landing page for documentation:**
```env
WHITELIST_PREFIX=/docs,/guides
WHITELIST_ACTION=pass-web
```

**Block all paths except guest/public (inverse matching):**
```env
EXCEPT_PREFIX=/guest,/public
EXCEPT_ACTION=block-except
```

**Require verification for all except free content:**
```env
EXCEPT_PREFIX=/free,/trial
EXCEPT_ACTION=verify-except
```

## Troubleshooting

### Error: "sign algorithm mismatch"
- This means the recalculated signature doesn't match the provided one
- Check that TOKEN matches the one used to generate the original signature
- Verify path encoding/decoding is consistent

### Error: "WORKER_ADDRESS_DOWNLOAD contains no valid addresses"
- Ensure WORKER_ADDRESS_DOWNLOAD is set
- Check for proper comma separation without extra spaces
- Example: `https://w1.com,https://w2.com` (not `https://w1.com, https://w2.com`)

### Turnstile Not Loading
- Verify UNDER_ATTACK=true
- Check TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set
- Ensure site key matches your Cloudflare account

### CORS Errors
- The worker automatically sets CORS headers
- If issues persist, check Origin header in requests

## Security Best Practices

1. **Keep TOKEN secret**: Never expose in client-side code or logs
2. **Use HTTPS only**: Ensure all worker URLs use HTTPS
3. **Enable Turnstile for public sites**: Protect against abuse
4. **Set expiration times**: Use reasonable expire values in signatures (e.g., 1 hour)
5. **Monitor logs**: Check Cloudflare analytics for suspicious activity

## Performance Tips

1. **Use multiple download workers**: Distribute load across workers
2. **Enable caching**: Configure appropriate cache headers in download workers
3. **Geographic distribution**: Deploy workers in regions close to users
4. **Monitor metrics**: Use Cloudflare Analytics to track performance

## Next Steps

After deployment:
1. Update your AList or file server to generate signed URLs pointing to this worker
2. Configure download workers to accept the three signature types
3. Test with real files of various sizes
4. Set up monitoring and alerts in Cloudflare Dashboard
5. Consider enabling Turnstile if experiencing abuse

## Support

For issues or questions:
- Check README.md for architecture details
- Review worker.js:handleInfo for signature logic
- Verify environment variables are correctly set
- Check Cloudflare Workers logs for errors
