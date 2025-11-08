# AList Landing Worker

A simplified Cloudflare Workers project for AList plain file downloads with Turnstile protection.

## Features

- **Plain File Only**: No encryption/decryption, only handles plain files
- **Turnstile Protection**: Optional Cloudflare Turnstile verification
- **Load Balancing**: Supports multiple download workers with random selection
- **Sign Verification**: Strict HMAC-SHA256 signature validation
- **Clean UI**: Modern dark-themed interface

## Architecture

This worker acts as a landing page that:
1. Receives user requests with signed URLs
2. Optionally verifies Turnstile tokens
3. Generates `hashSign`, `workerSign`, and an AES-GCM encrypted origin snapshot (`additionalInfo.encrypt`)
4. Redirects users to download workers with proper authentication

## Environment Variables

### Required
- `TOKEN`: HMAC signing key (used for signature generation/verification)
- `WORKER_ADDRESS_DOWNLOAD`: Download worker URLs (comma-separated for load balancing)
  - Example: `https://worker1.example.com,https://worker2.example.com`

### Optional
- `SIGN_SECRET`: Separate signing key (defaults to TOKEN if not set)
- `UNDER_ATTACK`: Enable Turnstile protection (`true`/`false`)
- `TURNSTILE_SITE_KEY`: Cloudflare Turnstile site key
- `TURNSTILE_SECRET_KEY`: Cloudflare Turnstile secret key
- `IPV4_ONLY`: Block IPv6 access (`true`/`false`)
- `VERIFY_HEADER`: Custom verification header name
- `VERIFY_SECRET`: Custom verification header value

## Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Create `.dev.vars` for local development:
```
TOKEN=your-secret-token
WORKER_ADDRESS_DOWNLOAD=https://download-worker.example.com
UNDER_ATTACK=false
```

### 3. Build
```bash
npm run build
```

This generates `dist/worker.js` - a bundled and minified version ready for deployment.

### 4. Development
```bash
npm run dev
```

### 5. Deploy
```bash
npm run deploy
```

This automatically runs `npm run build` before deploying. After deployment, configure environment variables in Cloudflare Dashboard.

## URL Format

### Landing Page
```
https://landing-worker.example.com/path/to/file.txt?sign=SIGNATURE
```

### Info Endpoint
```
GET /info?path=/path/to/file.txt&sign=SIGNATURE
```
Returns JSON with download URL including `hashSign`, `workerSign`, `additionalInfo`, and `additionalInfoSign`.

## Signature Algorithm

1. **sign**: `HMAC-SHA256(path, expire)`
2. **hashSign**: `HMAC-SHA256(base64(path), expire)`
3. **workerSign**: `HMAC-SHA256(JSON.stringify({path, worker_addr}), expire)`
4. **additionalInfo.encrypt**: AES-256-GCM encrypted JSON snapshot of the client (`ip_addr`, country/continent/region/city, ASN). The payload plus metadata (`pathHash`, `filesize`, `expireTime`, `idle_timeout`) is signed via `additionalInfoSign = HMAC-SHA256(additionalInfo, expire)`.

All signatures use the format `base64(hmac):expire` and share the same `TOKEN`. The download worker derives its own AES key from `TOKEN` to decrypt the snapshot and enforce `CHECK_ORIGIN`.

## Changes from Original

This is a simplified version of `alist-crypt-worker-client` with the following changes:

### Removed
- ❌ All encryption/decryption logic
- ❌ FileHandle/OPFS download functionality
- ❌ Progress tracking and speed display
- ❌ Download segmentation
- ❌ `crypt_meta` API calls
- ❌ Advanced settings (retry limits, parallelism, connections)

### Added
- ✅ Direct signature generation (sign/hashSign/workerSign) and AES origin snapshot encryption
- ✅ Download worker load balancing
- ✅ Strict sign verification with recalculation check

### Retained
- ✅ Turnstile verification
- ✅ Clean dark-themed UI
- ✅ Cache management
- ✅ Event logging

## License

MIT
