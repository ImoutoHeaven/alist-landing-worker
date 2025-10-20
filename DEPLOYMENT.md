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
```

#### For Production
Set environment variables in Cloudflare Dashboard:
1. Go to Workers & Pages > Your Worker > Settings > Variables
2. Add the following variables:
   - `TOKEN` (secret) - Your HMAC signing key
   - `WORKER_ADDRESS_DOWNLOAD` (plain) - Comma-separated worker URLs
   - `UNDER_ATTACK` (plain) - `true` or `false`
   - `TURNSTILE_SITE_KEY` (plain) - If using Turnstile
   - `TURNSTILE_SECRET_KEY` (secret) - If using Turnstile

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
| `TURNSTILE_SITE_KEY` | Plain | ❌ No | Cloudflare Turnstile site key (required if UNDER_ATTACK=true) |
| `TURNSTILE_SECRET_KEY` | Secret | ❌ No | Cloudflare Turnstile secret key (required if UNDER_ATTACK=true) |
| `IPV4_ONLY` | Plain | ❌ No | Block IPv6 access (`true`/`false`) |
| `VERIFY_HEADER` | Plain | ❌ No | Custom verification header name |
| `VERIFY_SECRET` | Secret | ❌ No | Custom verification header value |

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
2. **hashSign**: `HMAC-SHA256(base64(path), expire)`
3. **ipSign**: `HMAC-SHA256(clientIP, expire)`

Your download worker (e.g., `simple-alist-cf-proxy`) should verify all three signatures.

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
