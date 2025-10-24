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
   - `DB_MODE` (plain) - Optional: Database mode for rate limiting ("neon", "firebase", "d1", "d1-rest", "custom-pg-rest")
   - `POSTGRES_URL` (secret) - Optional: PostgreSQL URL for rate limiting (required when DB_MODE=neon)
   - `D1_DATABASE_BINDING` (plain) - Optional: D1 binding name (default: DB, required when DB_MODE=d1)
   - `D1_TABLE_NAME` (plain) - Optional: D1 table name (default: IP_LIMIT_TABLE, for DB_MODE=d1 or d1-rest)
   - `D1_ACCOUNT_ID` (plain) - Optional: Cloudflare account ID (required when DB_MODE=d1-rest)
   - `D1_DATABASE_ID` (plain) - Optional: D1 database ID (required when DB_MODE=d1-rest)
   - `D1_API_TOKEN` (secret) - Optional: Cloudflare API token (required when DB_MODE=d1-rest)
   - `POSTGREST_URL` (plain) - Optional: PostgREST API endpoint URL (required when DB_MODE=custom-pg-rest)
   - `POSTGREST_TABLE_NAME` (plain) - Optional: PostgREST table name (default: IP_LIMIT_TABLE, for DB_MODE=custom-pg-rest)
   - `IPSUBNET_WINDOWTIME_LIMIT` (plain) - Optional: Max requests per subnet (e.g., 100)
   - `WINDOW_TIME` (plain) - Optional: Time window (e.g., 24h, 4h, 30m)
   - `IPV4_SUFFIX` (plain) - Optional: IPv4 subnet mask (default: /32)
   - `IPV6_SUFFIX` (plain) - Optional: IPv6 subnet mask (default: /60)
   - `PG_ERROR_HANDLE` (plain) - Optional: fail-closed or fail-open (default: fail-closed)
   - `CLEANUP_PERCENTAGE` (plain) - Optional: Cleanup probability 0-100 (default: 1, decimals allowed like 0.1 for 0.1%)
   - `BLOCK_TIME` (plain) - Optional: Additional block time when rate limit exceeded (default: 10m, format: s/m/h)

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
| `DB_MODE` | Plain | ❌ No | Database mode for rate limiting: `neon`, `firebase`, `d1`, `d1-rest`, `custom-pg-rest`. If not set, rate limiting is disabled |
| `POSTGRES_URL` | Secret | ❌ No | PostgreSQL connection URL (required when `DB_MODE=neon`) |
| `D1_DATABASE_BINDING` | Plain | ❌ No | D1 binding name (default: `DB`, required when `DB_MODE=d1`) |
| `D1_TABLE_NAME` | Plain | ❌ No | D1 table name (default: `IP_LIMIT_TABLE`, for `DB_MODE=d1` or `d1-rest`) |
| `D1_ACCOUNT_ID` | Plain | ❌ No | Cloudflare account ID (required when `DB_MODE=d1-rest`) |
| `D1_DATABASE_ID` | Plain | ❌ No | D1 database ID (required when `DB_MODE=d1-rest`) |
| `D1_API_TOKEN` | Secret | ❌ No | Cloudflare API token (required when `DB_MODE=d1-rest`) |
| `POSTGREST_URL` | Plain | ❌ No | PostgREST API endpoint URL (required when `DB_MODE=custom-pg-rest`) |
| `POSTGREST_TABLE_NAME` | Plain | ❌ No | PostgREST table name (default: `IP_LIMIT_TABLE`, for `DB_MODE=custom-pg-rest`) |
| `IPSUBNET_WINDOWTIME_LIMIT` | Plain | ❌ No | Max requests per IP subnet within time window. Must be positive integer. Required for rate limiting |
| `WINDOW_TIME` | Plain | ❌ No | Sliding time window (format: `24h`, `4h`, `30m`, `10s`). Required for rate limiting |
| `IPV4_SUFFIX` | Plain | ❌ No | IPv4 subnet mask (default: `/32`). Examples: `/24`, `/32` |
| `IPV6_SUFFIX` | Plain | ❌ No | IPv6 subnet mask (default: `/60`). Examples: `/56`, `/60`, `/64` |
| `PG_ERROR_HANDLE` | Plain | ❌ No | Error handling strategy: `fail-closed` (default, reject on DB errors) or `fail-open` (allow on DB errors) |
| `CLEANUP_PERCENTAGE` | Plain | ❌ No | Cleanup probability in percentage (default: `1`). Range: 0-100, decimals allowed (e.g., `0.1`). Removes records older than `WINDOW_TIME × 2` |
| `BLOCK_TIME` | Plain | ❌ No | Additional block time when rate limit exceeded (default: `10m`). Format: `{number}{unit}` where unit is `s`/`m`/`h`. Examples: `30s`, `10m`, `2h` |

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

## IP Subnet Rate Limiting

Protect your worker from abuse by implementing IP subnet-based rate limiting with multiple database backend options.

### Overview

The rate limiting feature:
- Supports multiple database backends: **Neon (PostgreSQL)**, **Firebase (Firestore)**, **Cloudflare D1**
- Tracks request counts per IP subnet with sliding time window algorithm
- Supports both IPv4 and IPv6 with configurable subnet granularity
- Only applies to `/info` endpoint and fast redirect requests
- Returns HTTP 429 with `Retry-After` header when limit exceeded

### Database Mode Options

| Mode | Description | Use Case |
|------|-------------|----------|
| `neon` | Neon Serverless PostgreSQL | High performance, mature SQL database |
| `firebase` | Google Firebase Firestore | Serverless NoSQL, generous free tier |
| `d1` | Cloudflare D1 (Binding) | Native Cloudflare integration, lowest latency |
| `d1-rest` | Cloudflare D1 (REST API) | Remote access without Workers binding |
| `custom-pg-rest` | Self-hosted PostgreSQL + PostgREST | Full control, self-hosted infrastructure |

**Choose D1 if:**
- You want the lowest latency (same datacenter as your Worker)
- You prefer native Cloudflare integration
- You want free tier with 5 GB storage + 5 million reads/day

**Choose Neon if:**
- You need mature PostgreSQL features
- You have existing Postgres infrastructure
- You require complex queries or analytics

**Choose Firebase if:**
- You want generous free tier (1 GB storage, 50K reads/day)
- You use other Google Cloud services
- You prefer NoSQL flexibility

**Choose custom-pg-rest if:**
- You have self-hosted PostgreSQL infrastructure
- You want full control over your database
- You're already using PostgREST for other services
- You need to avoid third-party dependencies

### Common Configuration

**Required for ALL database modes:**
```env
DB_MODE=d1                     # or "neon", "firebase", "d1-rest", "custom-pg-rest"
IPSUBNET_WINDOWTIME_LIMIT=100
WINDOW_TIME=24h
```

**Optional Variables (all modes):**
```env
IPV4_SUFFIX=/24        # Default: /32 (single IP)
IPV6_SUFFIX=/60        # Default: /60
PG_ERROR_HANDLE=fail-closed  # Default: fail-closed
CLEANUP_PERCENTAGE=1   # Default: 1 (1% probability). Supports decimals (e.g., 0.1 = 0.1%)
BLOCK_TIME=10m         # Default: 10m (additional block time when limit exceeded)
```

### Configuration by Database Mode

#### Option 1: Cloudflare D1 (Binding Mode) - Recommended

**Advantages:**
- Lowest latency (runs in same datacenter)
- No external dependencies
- Free tier: 5 GB storage + 5 million reads/day + 100K writes/day
- Automatic connection pooling

**Step 1: Create D1 Database**
```bash
# Login to Cloudflare
wrangler login

# Create a new D1 database
wrangler d1 create alist-ratelimit-db

# Output will show:
# ✅ Successfully created DB 'alist-ratelimit-db'!
#
# [[d1_databases]]
# binding = "DB"
# database_name = "alist-ratelimit-db"
# database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Step 2: Add Binding to wrangler.toml**

Copy the output from Step 1 and add to your `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"  # Must match D1_DATABASE_BINDING env var
database_name = "alist-ratelimit-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # Use your actual database_id
```

**Step 3: Set Environment Variables**

For local development (`.dev.vars`):
```env
DB_MODE=d1
D1_DATABASE_BINDING=DB  # Optional, defaults to "DB"
D1_TABLE_NAME=IP_LIMIT_TABLE  # Optional, defaults to "IP_LIMIT_TABLE"
IPSUBNET_WINDOWTIME_LIMIT=100
WINDOW_TIME=24h
```

For production (Cloudflare Dashboard):
1. Go to Workers & Pages > Your Worker > Settings > Variables
2. Add environment variables:
   - `DB_MODE` = `d1`
   - `D1_DATABASE_BINDING` = `DB` (optional)
   - `D1_TABLE_NAME` = `IP_LIMIT_TABLE` (optional)
   - `IPSUBNET_WINDOWTIME_LIMIT` = `100`
   - `WINDOW_TIME` = `24h`

**Step 4: Deploy**
```bash
npm run deploy
```

The worker will automatically create the `IP_LIMIT_TABLE` table on first request.

**Note:** The D1 binding is configured in `wrangler.toml`, so no additional environment variables are needed for the database connection itself.

---

#### Option 2: Cloudflare D1 (REST API Mode)

**Advantages:**
- No need to modify `wrangler.toml`
- Can be used from external services
- Same free tier as binding mode

**When to use:**
- You cannot use Workers bindings
- You need to access D1 from external APIs
- You're testing before setting up bindings

**Step 1: Create D1 Database**
```bash
wrangler login
wrangler d1 create alist-ratelimit-db
```

Copy the `database_id` from the output.

**Step 2: Get Your Cloudflare Account ID**
```bash
# Method 1: Using wrangler
wrangler whoami

# Output will show:
# Account ID: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Method 2: From Dashboard
# Visit https://dash.cloudflare.com/
# Click on any domain > Right sidebar shows "Account ID"
```

**Step 3: Create API Token**

Visit: https://dash.cloudflare.com/profile/api-tokens

Click "Create Token" > Choose one of:

**Option A: Use Template (Easier)**
1. Find "Edit Cloudflare Workers" template
2. Click "Use template"
3. Add **D1 Edit** permission:
   - Click "Add more" under Permissions
   - Select: Account > D1 > Edit
4. Click "Continue to summary"
5. Click "Create Token"
6. **Copy the token immediately** (you can't view it again)

**Option B: Create Custom Token (More Secure)**
1. Click "Create Custom Token"
2. Give it a name: `D1 Rate Limit API Token`
3. Add permissions:
   - Account > D1 > Edit
4. (Optional) Add IP filtering or TTL for security
5. Click "Continue to summary"
6. Click "Create Token"
7. **Copy the token immediately**

**Step 4: Set Environment Variables**

For local development (`.dev.vars`):
```env
DB_MODE=d1-rest
D1_ACCOUNT_ID=your-account-id-here
D1_DATABASE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
D1_API_TOKEN=your-api-token-here
D1_TABLE_NAME=IP_LIMIT_TABLE  # Optional
IPSUBNET_WINDOWTIME_LIMIT=100
WINDOW_TIME=24h
```

For production (Cloudflare Dashboard):
1. Go to Workers & Pages > Your Worker > Settings > Variables
2. Add as **encrypted** secrets:
   - `DB_MODE` = `d1-rest`
   - `D1_ACCOUNT_ID` = your account ID
   - `D1_DATABASE_ID` = your database ID
   - `D1_API_TOKEN` = your API token (mark as secret)
   - `D1_TABLE_NAME` = `IP_LIMIT_TABLE` (optional)
   - `IPSUBNET_WINDOWTIME_LIMIT` = `100`
   - `WINDOW_TIME` = `24h`

**Step 5: Deploy**
```bash
npm run deploy
```

**⚠️ Important Notes:**
- REST API mode has rate limits: ~1200 requests per 5 minutes per account
- Higher latency than binding mode (~100-200ms extra)
- Best for low-traffic scenarios or development
- For production with high traffic, use binding mode instead

---

#### Option 3: Neon (PostgreSQL)

**Step 1: Create Neon Database**

**Setup:**
1. Visit https://neon.tech
2. Create a new project
3. Copy the connection string
4. **Run init.sql** to create table and indexes:
   ```bash
   # Download or locate init.sql from the project
   psql "postgresql://user:password@ep-xxx.neon.tech/neondb?sslmode=require" < init.sql
   ```
   This creates:
   - `IP_LIMIT_TABLE` table (without `IP_ADDR` field)
   - Performance indexes

**Step 2: Set Environment Variables**

For local development (`.dev.vars`):
```env
DB_MODE=neon
POSTGRES_URL=postgresql://user:password@ep-xxx.neon.tech/neondb?sslmode=require
IPSUBNET_WINDOWTIME_LIMIT=100
WINDOW_TIME=24h
```

For production (Cloudflare Dashboard):
- Add `POSTGRES_URL` as an encrypted secret
- Add other variables as plain text

**Step 3: Deploy**
```bash
npm run deploy
```

### Time Window Format

`WINDOW_TIME` accepts the following formats:
- Hours: `24h`, `1h`, `48h`
- Minutes: `30m`, `15m`, `60m`
- Seconds: `10s`, `30s`, `600s`

### Subnet Granularity

**IPv4 Examples:**
- `/32` - Single IP (most restrictive, default)
- `/24` - 256 IPs (e.g., 192.168.1.0 - 192.168.1.255)
- `/16` - 65,536 IPs (entire class C network)

**IPv6 Examples:**
- `/64` - Standard subnet (18 quintillion addresses)
- `/60` - 16 /64 subnets (default)
- `/56` - 256 /64 subnets

### Error Handling Strategies

**fail-closed (default, recommended):**
- When database connection/query fails, reject the request
- Returns HTTP 500 error
- More secure, prevents bypass during outages
- Use for high-security scenarios

**fail-open:**
- When database fails, allow the request to proceed
- Logs error but doesn't block user
- Better availability, less secure
- Use when uptime is critical

### Database Schema

**⚠️ IMPORTANT: After v2.0 atomic refactoring, the `IP_ADDR` field has been removed for simplified atomic operations.**

**For SQL databases (D1, Neon, custom-pg-rest):**

Use `init.sql` to create the table:

```sql
CREATE TABLE IF NOT EXISTS "IP_LIMIT_TABLE" (
  "IP_HASH" TEXT PRIMARY KEY,        -- SHA256 hash of IP subnet
  "IP_RANGE" TEXT NOT NULL,          -- Original IP subnet (e.g., "192.168.1.0/24")
  "ACCESS_COUNT" INTEGER NOT NULL,   -- Number of requests in current window
  "LAST_WINDOW_TIME" INTEGER NOT NULL, -- Unix timestamp of window start
  "BLOCK_UNTIL" INTEGER              -- Unix timestamp when block expires (NULL if not blocked)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_last_window_time ON "IP_LIMIT_TABLE"("LAST_WINDOW_TIME");
CREATE INDEX IF NOT EXISTS idx_block_until ON "IP_LIMIT_TABLE"("BLOCK_UNTIL") WHERE "BLOCK_UNTIL" IS NOT NULL;
```

**For custom-pg-rest only**: `init.sql` also creates the `upsert_rate_limit()` stored procedure required for atomic operations.

**For NoSQL databases (Firebase):**
Collection: `IP_LIMIT_TABLE` (configurable)
Document structure:
```json
{
  "IP_RANGE": "192.168.1.0/24",
  "IP_ADDR": ["192.168.1.10", "192.168.1.20"],
  "ACCESS_COUNT": 42,
  "LAST_WINDOW_TIME": 1234567890,
  "BLOCK_UNTIL": 1234567890  // or null
}
```

**Note**: Firebase still uses `IP_ADDR` field. Only SQL database implementations (Neon, D1, custom-pg-rest) have removed it.

### How It Works

1. Extract client IP from `CF-Connecting-IP` header
2. Calculate IP subnet based on `IPV4_SUFFIX` or `IPV6_SUFFIX`
3. Generate SHA256 hash of subnet as database key
4. Query database for existing record:
   - **No record**: Create new entry with count=1, allow request
   - **Record exists**:
     - **Priority 1**: If `BLOCK_UNTIL` is set and not expired: Return 429 with retry after remaining block time
     - **Priority 2**: If `BLOCK_UNTIL` expired: Clear block, reset count=1, allow request
     - **Priority 3**: If time window expired: Reset count=1, clear block, allow request
     - **Priority 4**: If within window and count < limit: Increment count, allow request
     - **Priority 5**: If within window and count >= limit: Set `BLOCK_UNTIL = now + BLOCK_TIME`, return 429

### Rate Limit Response

When limit is exceeded, returns:
```json
{
  "code": 429,
  "message": "192.168.1.0/24 exceeds the limit of 100 requests in 24h",
  "retry-after": 43200
}
```

Headers:
```
HTTP/1.1 429 Too Many Requests
Retry-After: 43200
Content-Type: application/json
```

**Note:** The `retry-after` field (in seconds) is included in both the response body and the `Retry-After` HTTP header for client convenience.

---

#### Option 4: Firebase (Firestore)

**Configuration:**
```env
DB_MODE=firebase
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY_ID=your-private-key-id
FIREBASE_COLLECTION=IP_LIMIT_TABLE  # Optional
IPSUBNET_WINDOWTIME_LIMIT=100
WINDOW_TIME=24h
```

**Setup:**
1. Visit https://console.firebase.google.com
2. Create a new project
3. Go to Project Settings > Service Accounts
4. Click "Generate New Private Key"
5. Extract credentials from downloaded JSON
6. Add to environment variables
7. Deploy: `npm run deploy`

---

#### Option 5: Custom PostgreSQL + PostgREST

**Advantages:**
- Full control over database and infrastructure
- No third-party dependencies or vendor lock-in
- Use existing PostgreSQL infrastructure
- Low latency if hosted nearby

**When to use:**
- You have self-hosted PostgreSQL database
- You're already using PostgREST for other services
- You want complete control over data and infrastructure
- You need to avoid cloud vendor dependencies

**Prerequisites:**
1. PostgreSQL database (self-hosted or managed) with `CREATE TABLE` permissions
2. PostgREST installed and configured (see https://postgrest.org)
3. Reverse proxy with authentication (e.g., nginx with custom headers)

**⚠️ Before you start:**
- Unlike D1/Neon/Firebase modes, this mode **does NOT auto-create tables or stored procedures**
- You MUST manually run `init.sql` on your PostgreSQL database (see Step 1 below)
- Failure to run init.sql will result in `PGRST205` errors or RPC function not found errors

**Step 1: Run init.sql on Your PostgreSQL Database**

**⚠️ CRITICAL: You MUST run init.sql before deployment!**

PostgREST cannot execute DDL commands via REST API. Connect to your PostgreSQL database and run the provided `init.sql`:

```bash
# Method 1: Using psql
psql "postgres://username:password@localhost:5432/database" < init.sql

# Method 2: Using psql interactive mode
psql -h localhost -U username -d database
\i /path/to/init.sql
```

**What init.sql creates:**
1. **`IP_LIMIT_TABLE` table** (without `IP_ADDR` field)
2. **`upsert_rate_limit()` stored procedure** - Required for atomic rate limiting operations
3. **Indexes** for performance optimization

**⚠️ Important Notes:**
- Table name is **uppercase** (`"IP_LIMIT_TABLE"`) - double quotes preserve case
- The stored procedure is **essential** - worker will fail without it
- See `init.sql` in project root for full SQL code

**⚠️ PostgreSQL Table Name Case Sensitivity:**
- Without quotes: `CREATE TABLE IP_LIMIT_TABLE` → creates `ip_limit_table` (lowercase)
- With quotes: `CREATE TABLE "IP_LIMIT_TABLE"` → creates `IP_LIMIT_TABLE` (uppercase) ✅
- PostgREST API paths are case-sensitive: `/IP_LIMIT_TABLE` ≠ `/ip_limit_table`
- **Always use double quotes** to match the default table name expected by the worker

**Verify table creation:**
```sql
-- Check if uppercase table exists (should work without errors)
SELECT * FROM "IP_LIMIT_TABLE" LIMIT 0;

-- List all tables to verify exact name
\dt
-- Look for: IP_LIMIT_TABLE (uppercase, not ip_limit_table)

-- Alternative: Query system catalog
SELECT tablename FROM pg_tables WHERE schemaname = 'public';
-- Should show: IP_LIMIT_TABLE (not ip_limit_table)
```

**If using a custom table name**, replace `IP_LIMIT_TABLE` with your chosen name and set `POSTGREST_TABLE_NAME` environment variable accordingly.

**Step 2: Configure PostgREST**

Create or update your PostgREST configuration file (`postgrest.conf`):

```conf
db-uri = "postgres://username:password@localhost:5432/database"
db-schemas = "public"
db-anon-role = "web_anon"
server-host = "127.0.0.1"
server-port = 3000
```

Start PostgREST:
```bash
postgrest postgrest.conf
```

**Step 3: Set Up Reverse Proxy Authentication**

Configure nginx (or your reverse proxy) to add authentication headers:

```nginx
location /postgrest/ {
    # Verify custom authentication header
    if ($http_x_api_key != "your-secret-key") {
        return 401;
    }

    # Proxy to PostgREST
    proxy_pass http://localhost:3000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

**Step 4: Set Environment Variables**

For local development (`.dev.vars`):
```env
DB_MODE=custom-pg-rest
POSTGREST_URL=https://your-domain.com/postgrest
POSTGREST_TABLE_NAME=IP_LIMIT_TABLE  # Optional, defaults to IP_LIMIT_TABLE
VERIFY_HEADER=X-API-Key
VERIFY_SECRET=your-secret-key
IPSUBNET_WINDOWTIME_LIMIT=100
WINDOW_TIME=24h
```

For production (Cloudflare Dashboard):
1. Go to Workers & Pages > Your Worker > Settings > Variables
2. Add environment variables:
   - `DB_MODE` = `custom-pg-rest`
   - `POSTGREST_URL` = `https://your-domain.com/postgrest`
   - `POSTGREST_TABLE_NAME` = `IP_LIMIT_TABLE` (optional)
   - `VERIFY_HEADER` = `X-API-Key` (or your custom header name)
   - `VERIFY_SECRET` = your secret key (mark as secret)
   - `IPSUBNET_WINDOWTIME_LIMIT` = `100`
   - `WINDOW_TIME` = `24h`

**Step 5: Deploy**
```bash
npm run deploy
```

**⚠️ Important Notes:**
- **CRITICAL**: The table MUST be created manually before deployment (see Step 1)
  - PostgREST cannot execute CREATE TABLE via REST API
  - Worker will fail with `PGRST205` error if table doesn't exist
  - No automatic table creation like D1/Neon modes
- PostgREST must be accessible from Cloudflare Workers (public HTTPS endpoint)
- Use HTTPS and authentication headers to secure your PostgREST endpoint
- Latency depends on your PostgreSQL server location (~50-200ms typical)
- For production, use connection pooling (e.g., PgBouncer) for better performance
- Consider creating indexes on `LAST_WINDOW_TIME` and `BLOCK_UNTIL` for better cleanup performance

**Security Best Practices:**
- Always use HTTPS for PostgREST endpoint
- Implement rate limiting on your reverse proxy
- Use strong authentication credentials
- Restrict PostgREST access to only the rate limit table
- Monitor PostgreSQL logs for suspicious activity
- Use separate PostgreSQL role with minimal permissions

### Example Configurations

**Strict per-IP limiting (24 hours):**
```env
POSTGRES_URL=postgresql://...
IPSUBNET_WINDOWTIME_LIMIT=50
WINDOW_TIME=24h
IPV4_SUFFIX=/32
IPV6_SUFFIX=/64
PG_ERROR_HANDLE=fail-closed
CLEANUP_PERCENTAGE=1
BLOCK_TIME=30m
```

**Subnet-based limiting (4 hours):**
```env
POSTGRES_URL=postgresql://...
IPSUBNET_WINDOWTIME_LIMIT=1000
WINDOW_TIME=4h
IPV4_SUFFIX=/24
IPV6_SUFFIX=/60
PG_ERROR_HANDLE=fail-open
CLEANUP_PERCENTAGE=2
BLOCK_TIME=15m
```

**Short burst protection (30 minutes):**
```env
POSTGRES_URL=postgresql://...
IPSUBNET_WINDOWTIME_LIMIT=20
WINDOW_TIME=30m
IPV4_SUFFIX=/32
IPV6_SUFFIX=/64
PG_ERROR_HANDLE=fail-closed
CLEANUP_PERCENTAGE=5
BLOCK_TIME=10m
```

### Automatic Data Cleanup

The worker automatically cleans up expired records to prevent database bloat.

**How it works:**
- **Cleanup Threshold**: Records older than `WINDOW_TIME × 2` are deleted
- **BLOCK_UNTIL Protection**: Records that are still blocked (BLOCK_UNTIL not expired) are **never deleted**, even if their window time is old
- **Cleanup Probability**: Controlled by `CLEANUP_PERCENTAGE` (default: 1%, decimals allowed)
- **Trigger**: On each successful rate limit check
- **Execution**: Asynchronous (doesn't block user requests)

**Configuration:**

```env
CLEANUP_PERCENTAGE=1   # 1% probability (default). Supports decimals (e.g., 0.1 = 0.1%)
```

**Probability Examples:**
- `0` - Never cleanup (not recommended, database will grow indefinitely)
- `0.1` - 0.1% probability (~1 cleanup per 1000 requests, very light touch)
- `1` - 1% probability (default, ~1 cleanup per 100 requests)
- `5` - 5% probability (aggressive, ~1 cleanup per 20 requests)
- `10` - 10% probability (very aggressive, high database load)
- `100` - Always cleanup (extreme load, not recommended)

**Choosing the right value:**
- **Low traffic (< 1000 req/day)**: `1` or lower
- **Medium traffic (1000-10000 req/day)**: `1-2`
- **High traffic (> 10000 req/day)**: `2-5`
- **Very high traffic (> 100000 req/day)**: `5-10`

**Storage impact:**
```
WINDOW_TIME=24h → Keeps 2 days of data (+ blocked IPs until BLOCK_TIME expires)
WINDOW_TIME=4h  → Keeps 8 hours of data (+ blocked IPs until BLOCK_TIME expires)
WINDOW_TIME=30m → Keeps 1 hour of data (+ blocked IPs until BLOCK_TIME expires)
```

**Important:** If `BLOCK_TIME` is longer than `WINDOW_TIME × 2`, blocked IP records will be retained until the block expires, not just 2× the window time. This ensures blocked IPs cannot bypass the punishment by waiting for cleanup.

With `CLEANUP_PERCENTAGE=1` and moderate traffic, database size typically stabilizes at < 10 MB.

### Monitoring

Check Cloudflare Workers logs for:
- `Cleaned up X expired rate limit records (older than Ys and not blocked)` - Successful cleanup operations
- `Rate limit cleanup failed: ...` - Cleanup errors (non-critical, requests continue)
- `Rate limit check failed (fail-open):` - Database errors in fail-open mode
- HTTP 429 responses in analytics
- HTTP 500 responses (may indicate database issues in fail-closed mode)

### Performance Considerations

- Database queries add ~50-200ms latency per request
- Neon Serverless Postgres provides excellent cold start performance
- Connection pooling is handled automatically by `@neondatabase/serverless`
- Consider using fail-open for high-traffic scenarios if occasional bypass is acceptable

### Disabling Rate Limiting

To disable, simply remove `DB_MODE` or leave it empty:
```env
DB_MODE=
# or remove the variable entirely
```

Alternatively, remove any of the required rate limiting variables:
```env
IPSUBNET_WINDOWTIME_LIMIT=
# or
WINDOW_TIME=
```

### Performance Comparison

| Database | Latency | Free Tier | Best For |
|----------|---------|-----------|----------|
| D1 (Binding) | ~10-30ms | 5M reads/day | ⭐ Best overall performance |
| D1 (REST) | ~100-200ms | 5M reads/day | Development/testing |
| Neon | ~50-150ms | 0.5 GB storage | PostgreSQL features |
| Firebase | ~100-300ms | 50K reads/day | NoSQL flexibility |
| Custom PG+REST | ~50-200ms | Depends on hosting | Self-hosted control |

**Recommendation:** Use D1 with binding mode for production deployments, or custom-pg-rest if you need full control.

## Troubleshooting

### Error: "PostgREST API error (404): PGRST205 - Could not find the table"

**Symptom:**
```
Rate limit check failed (fail-open): PostgREST API error (404):
{"code":"PGRST205","message":"Could not find the table 'public.IP_LIMIT_TABLE' in the schema cache"}
```

**Cause:** The rate limit table doesn't exist in your PostgreSQL database.

**Solution:**

1. Connect to your PostgreSQL database:
   ```bash
   psql -h your-host -U your-user -d your-database
   ```

2. Run `init.sql` from the project root:
   ```bash
   psql -h your-host -U your-user -d your-database < init.sql
   ```

   Or create the table and stored procedure manually:
   ```sql
   -- See init.sql for full SQL
   -- Creates IP_LIMIT_TABLE (without IP_ADDR field)
   -- Creates upsert_rate_limit() stored procedure
   -- Creates performance indexes
   ```

3. Verify the table exists with correct case:
   ```sql
   -- Check uppercase table exists
   SELECT * FROM "IP_LIMIT_TABLE" LIMIT 0;

   -- List tables to verify exact name
   \dt
   -- Should show: IP_LIMIT_TABLE (uppercase)

   -- Check in system catalog
   SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'IP_LIMIT_TABLE';
   -- Should return: IP_LIMIT_TABLE (if empty, table is lowercase)
   ```

4. If using a custom table name, ensure `POSTGREST_TABLE_NAME` environment variable matches

5. Reload PostgREST schema cache:
   ```bash
   # Send SIGUSR1 to reload schema cache (if using systemd)
   sudo systemctl reload postgrest

   # Or restart PostgREST
   sudo systemctl restart postgrest
   ```

**Note:** Unlike D1/Neon modes, PostgREST cannot auto-create tables. This is a one-time manual setup.

---

### Error: "Perhaps you meant the table 'public.ip_limit_table'" (case mismatch)

**Symptom:**
```
Rate limit check failed (fail-open): PostgREST API error (404):
{"code":"PGRST205","hint":"Perhaps you meant the table 'public.ip_limit_table'",
 "message":"Could not find the table 'public.IP_LIMIT_TABLE' in the schema cache"}
```

**Cause:** Table was created without quotes, PostgreSQL converted it to lowercase `ip_limit_table`.

**Solution:**

**Option A: Recreate table with correct uppercase name (recommended)**

```sql
-- Drop the lowercase table
DROP TABLE ip_limit_table;

-- Create uppercase table with quotes
CREATE TABLE "IP_LIMIT_TABLE" (
  IP_HASH TEXT PRIMARY KEY,
  IP_RANGE TEXT NOT NULL,
  IP_ADDR TEXT NOT NULL,
  ACCESS_COUNT INTEGER NOT NULL,
  LAST_WINDOW_TIME INTEGER NOT NULL,
  BLOCK_UNTIL INTEGER
);

-- Recreate indexes
CREATE INDEX idx_last_window_time ON "IP_LIMIT_TABLE"(LAST_WINDOW_TIME);
CREATE INDEX idx_block_until ON "IP_LIMIT_TABLE"(BLOCK_UNTIL) WHERE BLOCK_UNTIL IS NOT NULL;
```

**Option B: Use lowercase table name in worker (if you want to keep existing table)**

Set environment variable to match the lowercase table:
```env
POSTGREST_TABLE_NAME=ip_limit_table
```

**Important:**
- PostgreSQL treats `IP_LIMIT_TABLE` and `"IP_LIMIT_TABLE"` differently
- Without quotes → `ip_limit_table` (lowercase, SQL standard)
- With quotes → `IP_LIMIT_TABLE` (preserves case)
- PostgREST API paths are case-sensitive: `/IP_LIMIT_TABLE` ≠ `/ip_limit_table`

---

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
