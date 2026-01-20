# alist-landing-worker 架构说明（基于 `src/worker.js`）

本文以当前代码为准，描述 landing worker 在 controller-overhaul 体系下的实际行为与数据流。

## 1. 角色与边界

- **Landing Worker（本仓库）**  
  负责验证链、限流、票据签发与落地页渲染；不直接代理文件下载。
- **Controller（`controller/`）**  
  下发 bootstrap 配置与路径决策；landing worker 依赖 controller 运行。
- **Download Worker**  
  执行真实文件下载并校验 landing 票据（例如 `simple-alist-cf-proxy`）。
- **Powdet 服务（`powdet/`）**  
  提供 PoW challenge / verify API 与前端静态资源。
- **PostgREST + PostgreSQL**  
  提供统一检查（限流 + 缓存 + token 状态），仅支持 `custom-pg-rest` 模式。
- **Cloudflare Rate Limiter**  
  可选的无状态边缘限流。
- **D1（仅用于 controller bootstrap 缓存）**  
  `BOOTSTRAP_CACHE_MODE=d1` 时缓存 controller 配置。

## 2. 配置来源与控制面

### 2.1 Controller Bootstrap

Worker 启动后会从 controller 拉取 `bootstrap`，并基于 `paths.*` 匹配路径规则。  
若匹配到的 profile 标记为 `dynamic=true`，则会额外调用 controller 的 `/decision` 以获取动态决策覆盖。

重要字段：

- `common`：`tokenHmacKey`、`signSecret`、`workerAddresses`、`landingWorkerAddresses`、`alistBaseUrl`、`alistAuthHeaders`
- `landing`：`pageSecret`、`frontend.*`、`turnstile/altcha/powdet`、`paths.*`、`db`、`crypt`、`webDownloader`、`additional`

没有 controller 或 bootstrap/decision 获取失败时，Worker 会返回 503。

### 2.2 Worker 环境变量（infra 级）

- `CONTROLLER_URL` / `CONTROLLER_API_PREFIX` / `CONTROLLER_API_TOKEN`
- `ENV` / `ROLE` / `INSTANCE_ID` / `APP_NAME` / `APP_VERSION`
- `BOOTSTRAP_CACHE_MODE`（`direct`/`d1`）+ `CACHE_D1` + `INIT_TABLES`
- `INTERNAL_API_TOKEN`（用于 `/api/v0/health|refresh|flush`）
- `INNER_AUTH_SECRET` / `INNER_AUTH_HEADER`（入口内网鉴权，可选）
- `ENABLE_CF_RATELIMITER` / `CF_RATELIMITER_BINDING`（可选）

### 2.3 来源域名限制

请求的 `url.origin` 必须在 `common.landingWorkerAddresses` 中，否则返回 403。

## 3. 入口路由与控制面 API

Worker 入口逻辑（`fetch`）顺序：

1. **内部控制 API**：`/api/v0/health`、`/api/v0/refresh`、`/api/v0/flush`  
   需 `Authorization: Bearer <INTERNAL_API_TOKEN>`，未授权会直接落回普通路由。
2. **入口内网鉴权（可选）**：  
   当 `INNER_AUTH_SECRET` 存在时，必须携带指定 header（默认 `X-Inner-Auth`）。
3. **`/info` 或普通路径**：  
   `/info` 仅允许 `GET`，其余方法返回 405。

## 4. `/info` 处理流程（JSON 下载信息）

1. 解析并解码 `path` / `sign`，检查 IPv4-only（`landing.ipv4Only`）。
2. 可选 CF Rate Limiter（fail-open）。
3. 从 controller 决策中提取 `captchaCombo`，解析成动作集合：  
   `verify-altcha` / `verify-turn` / `verify-powdet` / `pass-web` / `pass-server` / `pass-asis` / `pass-web-download` / `pass-decrypt` / `verify-web-download` / `verify-decrypt`。  
   这些动作决定是否强制验证、强制落地页/跳转、以及是否启用 webDownloader / client-decrypt。
4. 若启用 TLS 指纹绑定（`landing.tlsFingerprintBinding`），要求 `request.cf` 中包含 `tlsClientExtensionsSha1` 与 `tlsClientCiphersSha1`，否则直接拒绝。
5. **ALTCHA 校验**：  
   - 无状态校验：`altcha-lib` 的 `verifySolution`。  
   - 绑定校验：pathHash（含 IP 范围 scope hash 与难度指数）+ ipHash + expires + salt + 可选 TLS 指纹。  
   - 动态难度：通过 `landing_get_altcha_difficulty` 获取状态，超限时直接 429。  
6. **Turnstile 校验**：  
   - 校验 binding payload（path/ip/expires + 可选 TLS 指纹）与 cData。  
   - 调用 Cloudflare siteverify，并按配置校验 action/hostname。  
   - 如启用 token binding，则要求 DB 可用并在 unified check 中验证/消费。
7. **Powdet 校验**：  
   - 验证 payload 时窗（expireAt + skew + maxWindow）。  
   - 按 `ipRangeHash + pathHash + expireAt + randomStr + challenge (+ TLS fingerprint)` 计算 HMAC；  
     HMAC 密钥使用 `common.tokenHmacKey`。  
   - 调用 Powdet `/Verify`；失败会落入短期 LRU 拒绝。
8. **签名校验**：  
   `sign = base64url(HMAC_SHA256(signSecret, path + ":" + expire)) + ":" + expire`  
   `signSecret` 取自 `common.signSecret`，为空时回落到 `tokenHmacKey`。
9. **统一检查 / 限流 / 缓存**：  
   - `custom-pg-rest` 时优先调用 `landing_unified_check`，在一次 RPC 内完成限流、token 绑定、Powdet 消费与文件大小缓存。  
   - 失败时按 `pgErrorHandle`（fail-open / fail-closed）决定是否继续。
10. **AList 元信息**：  
    调用 `POST {alistBaseUrl}/api/fs/get`，默认 `Authorization: tokenHmacKey`，并附加 `alistAuthHeaders`。
11. **生成下载 URL**：  
    - 选择 download worker：随机或 HRW（`downloadWorkerHrwEnabled` + 小文件阈值）。  
    - 生成 `hashSign` / `workerSign`。  
    - 构造 `additionalInfo`（见第 8 节），并写入可选 `idle` 记录。
12. 返回 JSON：包含 `download.url`、`meta`，并在需要时返回 webDownloader / decrypt 参数。

## 5. 普通路径处理（落地页或快速 302）

1. 仅允许 `GET/HEAD`，`HEAD` 直接返回 200。  
2. 校验 `sign`，执行 CF Rate Limiter。  
3. 根据 controller 决策、验证需求与 `fastRedirect` 判断是否直接 302：  
   - 当无需验证且无需 webDownloader/clientDecrypt 时可快速跳转。  
4. 非 302 时渲染落地页：  
   - 生成 Turnstile binding  
   - 生成 ALTCHA challenge（含动态难度、算法升级）  
   - 生成 Powdet challenge（调用 `/GetChallenges` + HMAC 绑定）  
   - `renderLandingPage` 注入前端资源与验证 payload。

## 6. 验证链与绑定策略

### 6.1 Turnstile Binding

- 绑定字段：`pathHash` + `ipHash` + `expiresAt`（可选 TLS 指纹）。
- cData = HMAC(pageSecret, bindingMac + nonce)。
- DB token binding 需要 `custom-pg-rest` 与 `TURNSTILE_TOKEN_BINDING` 表。

### 6.2 ALTCHA Binding

- `pathHash` 中包含 `pathHash + scopeHash + exponent` 的 canonical JSON。
- `scopeHash` 基于 `calculateIPSubnet` 的 IP 范围哈希。
- 可选 TLS 指纹写入绑定 MAC。
- 动态难度采用 `landing_get_altcha_difficulty` / `landing_update_altcha_difficulty`。

### 6.3 Powdet Binding

- HMAC 绑定：`ipRangeHash + pathHash + expireAt + randomStr + challenge (+ TLS fingerprint)`。
- 校验时序窗口：`expireAt` + `clockSkewSeconds` + `maxWindowSeconds`。
- 动态难度采用同一组 RPC，但传入 `POWDET_DIFFICULTY_STATE` 表名。

## 7. 限流、缓存与清理

### 7.1 CF Rate Limiter

可选绑定 `CF_RATELIMITER_BINDING`，按 IP 子网 hash 限流，异常 fail-open。

### 7.2 PostgREST（`custom-pg-rest`）

- **统一检查**：`landing_unified_check`  
  同时返回 IP/文件限流、token 状态、Powdet 消费与文件大小缓存。
- **文件大小缓存**：`landing_upsert_filesize_cache` + `FILESIZE_CACHE_TABLE`
- **ALTCHA token**：`landing_record_altcha_token` + `ALTCHA_TOKEN_LIST`
- **动态难度**：`landing_get_altcha_difficulty` / `landing_update_altcha_difficulty`

### 7.3 本地 LRU 与慢失败

Worker 内部维护 LRU 缓存用于：

- IP 子网 / IP+文件限流短期拒绝
- ALTCHA token / Powdet challenge 重放防护
- Powdet 校验失败短期阻断

对部分失败路径统一增加 5 秒延迟（`SLOW_FAIL_DELAY_MS`）以降低刷爆风险。

### 7.4 清理调度

`scheduleAllCleanups` 按 `cleanupPercentage` 概率触发：

- `landing_cleanup_expired_rate_limits`
- `landing_cleanup_expired_file_rate_limits`
- `landing_cleanup_expired_cache`
- `landing_cleanup_expired_tokens`
- `landing_cleanup_expired_altcha_tokens`
- `landing_cleanup_altcha_difficulty_state`
- `landing_cleanup_expired_pow_challenges`
- `landing_cleanup_altcha_difficulty_state`（传入 `POWDET_DIFFICULTY_STATE` 表名）

## 8. 下载票据与 Origin 绑定

### 8.1 签名结构

- `sign = base64url(HMAC_SHA256(signSecret, path + ":" + expire)) + ":" + expire`
- `hashSign = HMAC_SHA256(signSecret, base64(path) + ":" + expire)`
- `workerSign = HMAC_SHA256(signSecret, JSON.stringify({path, worker_addr}) + ":" + expire)`

### 8.2 additionalInfo

`additionalInfo` 为 JSON 的 Base64（去掉末尾 `=`），字段包含：

- `pathHash`（`sha256(path)`）
- `filesize`
- `expireTime`
- `idle_timeout`
- `encrypt`：AES-256-GCM 加密的 origin snapshot（IP/ASN/国家/城市/issuer 等）
- `isCrypted`

`additionalInfoSign = HMAC_SHA256(signSecret, additionalInfo + ":" + expire)`。

### 8.3 Idle 记录

当 `landing.db.idleTimeoutSeconds > 0` 时，会调用 `download_update_last_active` 写入 `DOWNLOAD_LAST_ACTIVE_TABLE` 初始记录。

## 9. 前端与下载模式

- `renderLandingPage` 通过 `frontend.glueUrl/htmlUrl/commonCssUrl/themeCssUrl` 渲染页面。
- `webDownloader` 与 `clientDecrypt` 由 `landing.webDownloader` / `landing.clientDecryptEnabled` 决定，并依赖 `landing.crypt`。
- Powdet 静态资源优先使用 `powdet.staticBaseUrl`，否则回退到 `{powdet.baseUrl}/powdet/static` 或 `/powdet/static`。

## 10. 关键文件

- `src/worker.js`：核心逻辑
- `src/frontend.js`：前端交互
- `controller/`：控制面
- `powdet/`：Powdet 后端与静态资源
- `snippets/sign.js`：边缘签名校验（可选）
