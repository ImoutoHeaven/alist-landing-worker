# Deployment Guide

本指南侧重「如何把 alist-landing-worker 正确上线」，与当前 `wrangler.toml` 和 `alist-landing-worker-architecture.md` 保持一致。  
详细字段/算法说明请优先参考：
- 架构说明：`alist-landing-worker-architecture.md`
- 配置注释：`wrangler.toml`

这里只给出实用向的部署和配置步骤。

---

## 1. Quick Start

### 1.1 Prerequisites

- Node.js 18+  
- Cloudflare 账号，已开启 Workers  
- Wrangler CLI：`npm install -g wrangler`

### 1.2 Install & Build

```bash
cd alist-landing-worker
npm install
npm run build
```

构建完成后会生成 `dist/worker.js`，即 Worker 入口。

### 1.3 Minimal `.dev.vars` (no DB / no ALTCHA / no Powdet)

在项目根目录创建 `.dev.vars`：

```bash
TOKEN=your-hmac-token-here
WORKER_ADDRESS_DOWNLOAD=https://download1.example.com,https://download2.example.com
ALIST_ADDRESS=https://alist.example.com

UNDER_ATTACK=false
FAST_REDIRECT=false
AUTO_REDIRECT=false

# 关闭额外 PoW 模块（按需再开启）
ALTCHA_ENABLED=false
POWDET_ENABLED=false

# 不启用数据库限流
DB_MODE=
```

说明：
- `TOKEN` 用于所有 HMAC 及 AES 加密（如未单独配置 `SIGN_SECRET`）。  
- `WORKER_ADDRESS_DOWNLOAD` 为 download worker 列表（例如 `simple-alist-cf-proxy`）。  
- `ALIST_ADDRESS` 为 AList 实例地址，用于 `/api/fs/get` 查询文件信息。  
- 初始可以不开启 ALTCHA / Powdet / DB，待验证通过后再慢慢加安全层。  

### 1.4 Local Development

```bash
npm run dev
```

访问：
- `http://localhost:8787/path/to/file.txt?sign=SIGNATURE` → 落地页  
- `http://localhost:8787/info?path=/path/to/file.txt&sign=SIGNATURE` → JSON 下载信息  

签名算法与字段见下文「与 download worker 集成」小节。

### 1.5 Deploy to Cloudflare

```bash
npm run deploy
```

部署会自动执行 `npm run build`。  
上线后在 Cloudflare Dashboard 中配置环境变量（与 `.dev.vars` 保持一致即可）。

---

## 2. Configuration Overview

详细注释可在 `wrangler.toml` 中找到，这里只按功能分组列出常用项。

### 2.1 Core

- `TOKEN`（必填，Secret）  
  - 所有签名与 origin snapshot 加密的基础密钥。  
- `SIGN_SECRET`（可选，Secret）  
  - 若设置，则用它替代 `TOKEN` 做 HMAC；未设置时等同于 `TOKEN`。  
- `WORKER_ADDRESS_DOWNLOAD`（必填）  
  - 逗号分隔的 download worker 列表，随机轮询。  
- `ALIST_ADDRESS`  
  - AList API 根地址，例如 `https://alist.example.com`。  
  - 当启用 `IF_APPEND_ADDITIONAL=true`（默认）时必须配置，用于给下载链接附加过期时间。  

### 2.2 Behavior & Path Rules

- `UNDER_ATTACK`  
  - `true` 时启用 Turnstile 验证。  
- `FAST_REDIRECT`  
  - `true` 且非攻击模式时，接到签名 URL 后直接 302 跳转到 download worker，不渲染落地页。  
- `AUTO_REDIRECT`  
  - 验证通过后是否自动从落地页跳转到 download URL。  
- 路径规则（详见 `wrangler.toml` 注释与架构文档 ACTION 部分）：  
  - `BLACKLIST_PREFIX`, `WHITELIST_PREFIX`, `EXCEPT_PREFIX`  
  - `BLACKLIST_ACTION`, `WHITELIST_ACTION`, `EXCEPT_ACTION`  
  - `*_DIR_INCLUDES`, `*_NAME_INCLUDES`, `*_PATH_INCLUDES`  
  - 动作值包括：`block` / `verify-*` / `pass-web` / `pass-server` / `pass-asis` / `pass-web-download` / `pass-decrypt` 以及对应的 `*-except` 变体。

### 2.3 Security Modules

#### Turnstile

核心变量（更多细节见 `wrangler.toml` 中 Turnstile 小节）：

- `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`  
- `TURNSTILE_TOKEN_BINDING`（默认 `true`）  
- `TURNSTILE_TOKEN_TTL`, `TURNSTILE_TOKEN_TABLE`  
- `TURNSTILE_COOKIE_EXPIRE_TIME`  
- `TURNSTILE_EXPECTED_ACTION`, `TURNSTILE_ENFORCE_ACTION`  
- `TURNSTILE_ENFORCE_HOSTNAME`, `TURNSTILE_ALLOWED_HOSTNAMES`  

部署建议：
- `UNDER_ATTACK=true` 时开启 Turnstile。  
- 若已配置数据库（`DB_MODE` 非空），建议保持 `TURNSTILE_TOKEN_BINDING=true`，以防止打码平台 Token 转移。  

#### ALTCHA PoW

ALTCHA 将 `/info` 请求前置一个前端 PoW 挑战，可工作于无状态或有状态（DB）模式。

关键变量：

- `ALTCHA_ENABLED`  
- `ALTCHA_DIFFICULTY`（或区间：`100000-400000`）  
- `ALTCHA_TOKEN_EXPIRE`  
- `PAGE_SECRET`（若未设置则回落到 `TOKEN`）  
- 动态难度与封禁窗口：  
  - `ALTCHA_MIN_UPGRADE_MULTIPLIER`, `ALTCHA_MAX_MULTIPLIER`, `ALTCHA_MAX_BLOCK_TIME`  
  - `ALTCHA_DIFFICULTY_WINDOW`, `ALTCHA_DIFFICULTY_RESET`  
- 表名与清理（DB 模式）：  
  - `ALTCHA_TOKEN_BINDING_TABLE`（默认 `ALTCHA_TOKEN_LIST`）  

行为概要（与架构文档一致）：
- `DB_MODE` 为空 → 纯无状态，依赖 ALTCHA 内建过期检查。  
- `DB_MODE` 非空 → 使用 `ALTCHA_TOKEN_LIST` / `ALTCHA_DIFFICULTY_STATE` 做：
  - Token 一次性消费与路径/IP 绑定（防重放 / 防 IP 迁移 / 防路径劫持）  
  - 按 IP 维度动态提升难度与短期封禁。  

#### Pow Bot Deterrent (Powdet, Argon2id)

Powdet 提供第二套 PoW 防爬机制，本仓库内 `powdet/` 目录为推荐后端实现。

关键变量：

- `POWDET_ENABLED`  
- `POWDET_BASE_URL`（Powdet HTTP 服务，如 `https://powdet.example.com`）  
- `POWDET_STATIC_BASE_URL`（可选；不设时默认 `{POWDET_BASE_URL}/powdet/static` 或 `/powdet/static`）  
- `POWDET_API_TOKEN`（访问 `/GetChallenges` 与 `/Verify` 的 Bearer Token）  
- `POWDET_TABLE_NAME`（默认 `POW_CHALLENGE_TICKET`）  
- 静态/动态难度参数：  
  - `POWDET_STATIC_LEVEL`  
  - `POWDET_EXPIRE_SECONDS`, `POWDET_CLOCK_SKEW_SECONDS`, `POWDET_MAX_WINDOW_SECONDS`  
  - `POWDET_DYNAMIC_ENABLED`, `POWDET_DYNAMIC_WINDOW_SECONDS`, `POWDET_DYNAMIC_RESET_SECONDS`, `POWDET_DYNAMIC_BLOCK_SECONDS`  
  - `POWDET_BASE_LEVEL_MIN`, `POWDET_BASE_LEVEL_MAX`, `POWDET_LEVEL_STEP`, `POWDET_MAX_LEVEL`  

数据库表（由 `init.sql` 创建）：
- `POW_CHALLENGE_TICKET` – 一次性挑战票据  
- `POWDET_DIFFICULTY_STATE` – Powdet 动态难度状态  

更多细节参见：
- `powdet/README.md` – Powdet Argon2 服务的构建与配置  
- 架构文档中 Powdet 集成小节  

### 2.4 Database & Unified Check (`DB_MODE`)

数据库相关变量与行为在 `wrangler.toml` 中有完整注释，这里只列出主线：

- `DB_MODE`：`""` / `"custom-pg-rest"`  
- 速率限制与窗口参数：  
  - `IPSUBNET_WINDOWTIME_LIMIT`, `WINDOW_TIME`, `BLOCK_TIME`  
  - `IPV4_SUFFIX`, `IPV6_SUFFIX`  
  - 文件维度：`IPSUBNET_FILE_WINDOWTIME_LIMIT`, `FILE_WINDOW_TIME`, `FILE_BLOCK_TIME`  
- 错误策略与清理：  
  - `PG_ERROR_HANDLE` (`fail-closed` / `fail-open`)  
  - `CLEANUP_PERCENTAGE`  
- 文件大小缓存：  
  - `FILESIZE_CACHE_TABLE`（默认 `FILESIZE_CACHE_TABLE`）  
  - `SIZE_TTL`  
- 表创建控制：  
  - `INIT_TABLES` – 仅保留兼容用途；PostgREST 模式下仍需先执行 `init.sql` 创建函数与表。  

统一检查（`landing_unified_check`，见 `init.sql`）会在一次 RPC 内完成：
- IP / 文件维度限流（`IP_LIMIT_TABLE` / `IP_FILE_LIMIT_TABLE`）  
- 文件大小缓存读取（`FILESIZE_CACHE_TABLE`）  
- Turnstile token / ALTCHA token / Powdet challenge 状态检查与消费。  

### 2.5 Web Downloader & Client Decrypt

当你希望在浏览器内做分段下载、断点续传或客户端解密时，启用以下配置。

- `WEB_DOWNLOADER_ENABLED`  
  - 开启浏览器端多连接分段下载（Range 请求 + Dexie/IndexedDB 断点续传）。  
- `WEB_DOWNLOADER_MAX_CONNECTIONS`  
  - 最大并发连接数（默认 16）。  
- Crypt 相关：  
  - `CRYPT_PREFIX` / `CRYPT_INCLUDES` – 决定哪些路径被视为加密文件。  
  - `CRYPT_ENCRYPTION_MODE` – 当前仅 `crypt`。  
  - `CRYPT_FILE_HEADER_SIZE`, `CRYPT_BLOCK_HEADER_SIZE`, `CRYPT_BLOCK_DATA_SIZE` – rclone crypt 格式参数。  
  - `CRYPT_DATA_KEY` – 32 字节 key 的 64 位 hex 编码，必须与 upstream 一致。  
- `CLIENT_DECRYPT_ENABLED`  
  - 开启离线解密辅助 UI。用户可先通过 IDM/aria2 下载密文，再在页面上传并本地解密。  

前端行为与 UX 细节，请参考架构文档「前端：landing 页面、webDownloader 与 client-decrypt」章节。

### 2.6 Idle Timeout & CF Rate Limiter

- Idle Timeout：  
  - `IDLE_TIMEOUT`, `IDLE_TABLE_NAME`（仅在 `DB_MODE="custom-pg-rest"` 时生效）。  
- Cloudflare Rate Limiter Binding：  
  - `ENABLE_CF_RATELIMITER`, `CF_RATELIMITER_BINDING`  
  - 同时配合 `[[rate_limit]]` 绑定使用，作为第一层无状态限流，详见 `wrangler.toml`。  

---

## 3. Database Backends (DB_MODE)

当前仅支持两种模式：

- `DB_MODE=""`：无数据库，依赖 Cloudflare Rate Limiter / ALTCHA / Powdet 的无状态能力。
- `DB_MODE="custom-pg-rest"`：启用 PostgreSQL + PostgREST 的统一检查（限流 / 缓存 / Token 状态）。

### 3.1 Shared Settings

启用数据库功能时，至少需要：

```env
DB_MODE=custom-pg-rest
POSTGREST_URL=https://postgrest.example.com
VERIFY_HEADER=X-Auth-Token
VERIFY_SECRET=your-postgrest-secret
IPSUBNET_WINDOWTIME_LIMIT=100
WINDOW_TIME=24h
```

推荐同时设置：

```env
IPV4_SUFFIX=/32
IPV6_SUFFIX=/60
PG_ERROR_HANDLE=fail-closed
CLEANUP_PERCENTAGE=5
BLOCK_TIME=10m
FILESIZE_CACHE_TABLE=FILESIZE_CACHE_TABLE
SIZE_TTL=24h
```

### 3.2 Custom PostgreSQL + PostgREST (`DB_MODE="custom-pg-rest"`)

此模式使用你自建的 PostgreSQL + PostgREST 服务。

1. 部署并配置 PostgREST，确保能通过 HTTP 访问 PostgreSQL。  
2. **必须** 手工执行根目录的 `init.sql`（仅一次）：
   ```bash
   psql "postgres://user:pass@host:5432/dbname" < init.sql
   ```
3. 环境变量（示例）：
   ```env
   DB_MODE=custom-pg-rest
   POSTGREST_URL=https://postgrest.example.com
   POSTGREST_TABLE_NAME=IP_LIMIT_TABLE   # 可省略

   VERIFY_HEADER=X-Auth-Token
   VERIFY_SECRET=your-postgrest-secret
   ```

`init.sql` 会创建并维护以下内容（与 `wrangler.toml` 中注释一致）：
- 表：
  - `IP_LIMIT_TABLE`, `IP_FILE_LIMIT_TABLE`
  - `FILESIZE_CACHE_TABLE`
  - `TURNSTILE_TOKEN_BINDING`
  - `ALTCHA_TOKEN_LIST`, `ALTCHA_DIFFICULTY_STATE`
  - `POW_CHALLENGE_TICKET`, `POWDET_DIFFICULTY_STATE`
- 核心函数：
  - `landing_upsert_rate_limit`, `landing_cleanup_expired_rate_limits`
  - `landing_upsert_file_rate_limit`, `landing_cleanup_expired_file_rate_limits`
  - `landing_upsert_filesize_cache`, `landing_cleanup_expired_cache`
  - `landing_upsert_token_binding`, `landing_cleanup_expired_tokens`
  - `landing_verify_altcha_token`, `landing_record_altcha_token`, `landing_cleanup_expired_altcha_tokens`
  - ALTCHA / Powdet 动态难度相关函数
  - `landing_unified_check` – 单次 RPC 完成 cache + rate + Turnstile + ALTCHA + Powdet 检查。  

如果 PostgREST 出现 `PGRST205` 找不到表/函数错误，通常是 `init.sql` 未正确执行或表名大小写不匹配，可参考 `init.sql` 中的注释与 wrangler.toml 的说明进行排查。

### 3.3 从 D1 迁移到 PostgREST

- 本版本已移除 `DB_MODE=d1` / `d1-rest`，Worker 启动时会直接报错。  
- 迁移步骤建议：
  1) 准备可用的 PostgreSQL + PostgREST 服务，并执行 `init.sql`；  
  2) 将 `DB_MODE` 设为 `custom-pg-rest`，配置 `POSTGREST_URL` / `VERIFY_HEADER` / `VERIFY_SECRET`；  
  3) 移除所有 `D1_*`、`IDLE_D1_*` 等旧环境变量与 `[[d1_databases]]` 绑定片段；  
  4) download worker（如 `simple-alist-cf-proxy`）也需同步改为 `custom-pg-rest`；  
  5) 验证统一检查与缓存/限流功能是否正常。

---

## 4. Deploy Powdet Backend (`powdet/`)

Powdet 后端位于本仓库 `powdet/` 目录，为 Argon2id 实现的 pow-bot-deterrent 服务。

### 4.1 Build & Run

```bash
cd powdet
go build ./...
./powdet   # 或 go run main.go
```

默认监听端口可在 `powdet/config.json` 中配置（或通过 `POW_BOT_DETERRENT_*` 环境变量）。  
服务会暴露：
- `POST /GetChallenges`  
- `POST /Verify`  
- 静态资源：`/powdet/static/...`（powdet JS / worker / hash-wasm-argon2 等）

### 4.2 Integrate with Landing Worker

在 Cloudflare Worker 侧设置：

```env
POWDET_ENABLED=true
POWDET_BASE_URL=https://powdet.example.com
POWDET_API_TOKEN=your-bearer-token
# 可选：若前端静态资源放在单独域名
POWDET_STATIC_BASE_URL=https://powdet.example.com/powdet/static
```

落地页前端会通过 `powdetStaticBase` 自动从 `/powdet/static`（或你指定的 URL）加载 `pow-bot-deterrent.js` 和相关 worker。

---

## 5. Testing

### 5.1 Landing Page

```bash
curl "https://your-landing-worker.workers.dev/test-file.txt?sign=YOUR_SIGNATURE"
```

期望返回 HTML 页面；若启用了 Turnstile / ALTCHA / Powdet，会在前端完成相应验证。

### 5.2 Info Endpoint

在未启用 ALTCHA / Powdet、且 `UNDER_ATTACK=false` 的情况下，可以直接测试 `/info`：

```bash
curl "https://your-landing-worker.workers.dev/info?path=/test-file.txt&sign=YOUR_SIGNATURE"
```

典型成功响应（简化）：

```json
{
  "code": 200,
  "data": {
    "download": {
      "url": "https://download-worker.com/test-file.txt?sign=...&hashSign=...&workerSign=...&additionalInfo=...&additionalInfoSign=..."
    },
    "meta": {
      "path": "/test-file.txt",
      "size": 123456
    }
  }
}
```

如果启用了 Turnstile / ALTCHA / Powdet，建议通过浏览器访问落地页来完成前端挑战，再观察 `/info` 请求与响应。

---

## 6. Integration with Download Workers

Landing worker 在校验 URL 中的原始 `sign` 后，会为 download worker 生成完整下载 URL，包含三段签名与附加信息：

1. **`sign`**：原始签名（来自 AList 或上游）  
   - 格式：`HMAC-SHA256(path, expire)`  
2. **`hashSign`**：基于 Base64(path) 的签名  
   - 格式：`HMAC-SHA256(base64(path), expire)`  
3. **`workerSign`**：绑定路径与选中 download worker 地址  
   - 格式：`HMAC-SHA256(JSON.stringify({path, worker_addr}), expire)`  
4. **`additionalInfo` / `additionalInfoSign`**：附加元数据与 origin snapshot  
   - `additionalInfo` 携带字段（JSON → Base64url）：  
     - `pathHash`：`sha256(path)`  
     - `filesize`：文件大小  
     - `expireTime`：有效期时间戳  
     - `idle_timeout`：download worker 侧空闲超时  
     - `encrypt`：AES-256-GCM 加密的 origin snapshot（`ip_addr` + Geo + ASN 等）  
     - `isCrypted`：当前路径是否按加密文件处理  
   - `additionalInfoSign = HMAC-SHA256(additionalInfo, expire)`  

Download worker（例如 `simple-alist-cf-proxy`）应：
- 校验 `sign` / `hashSign` / `workerSign` / `additionalInfoSign`；  
- 使用与 landing 相同的 `TOKEN` / `SIGN_SECRET`；  
- 解密 `encrypt` 并按需要校验 origin（`CHECK_ORIGIN`）；  
- 使用 `expireTime` 与 `idle_timeout` 控制链接与会话生命周期。  

更完整的数据结构与签名流程，请参考 `alist-landing-worker-architecture.md` 中关于「下载票据构造」的章节。

---

## 7. Troubleshooting (Common Issues)

- **签名不匹配 / `sign algorithm mismatch`**  
  - 确认 AList 与 landing worker 的 `TOKEN` / `SIGN_SECRET` 完全一致。  
  - 检查路径编码是否一致（是否多加或少加 `/`，是否 URL 解码两次等）。  

- **数据库相关错误（D1 / PostgREST）**  
  - D1 / D1-REST：通常是 `DB_MODE`、绑定名或 `D1_*` 配置错误；检查 `wrangler.toml` 与 Dashboard。  
  - custom-pg-rest：出现 `PGRST205`/找不到表或函数时，先确认已对正确数据库执行 `init.sql`。  

- **ALTCHA / Powdet 始终验证失败**  
  - 检查时钟偏差参数（`ALTCHA_TOKEN_EXPIRE`、`POWDET_CLOCK_SKEW_SECONDS`、`POWDET_MAX_WINDOW_SECONDS`）。  
  - 确认前后端使用同一 `PAGE_SECRET` / `POWDET_API_TOKEN`。  

- **Turnstile 不显示或返回 403**  
  - 确认 `UNDER_ATTACK=true` 且 Site Key / Secret Key 正确。  
  - 若启用 hostname/action 校验，确保前端域名与 `TURNSTILE_ALLOWED_HOSTNAMES`、`TURNSTILE_EXPECTED_ACTION` 一致。  

- **Fast Redirect 行为异常**  
  - 记住：`UNDER_ATTACK=true` 时 Fast Redirect 会自动关闭（必须先通过 Turnstile）。  
  - 路径规则中的 `pass-web` / `pass-server` / `pass-asis` 也会影响最终行为。  

更多细节问题，可结合 Cloudflare 日志、控制台报错与 `wrangler.toml` 的注释进行排查。  
