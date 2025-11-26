# alist-landing-worker 架构说明

本文基于 `wrangler.toml` 与 `src` 源码梳理，忽略 README 中已过期的描述。

## 一、总体定位与角色

- 部署形态：Cloudflare Worker（入口：`src/worker.js`，前端：`src/frontend.js`）
- 职责：
  - 作为 AList 下载体系的「Landing 页面 / 网关」
  - 承担三层防护：
    - Cloudflare Turnstile（人机验证）+ 可选 Token Binding
    - ALTCHA（前端 PoW，人机判断，支持动态难度与 DB 状态）
    - pow-bot-deterrent（PoW Bot Deterrent，以下简称 Powdet）
  - 承担三层限速/限流：
    - Cloudflare Rate Limiter Binding（可选）
    - DB 支持的 IP 子网/文件限流（D1 / D1-REST / PostgREST）
    - 统一检查（cache + ratelimit + token 验证）以减少往返
  - 生成面向 download worker 的下载票据，统一对接 simple-alist-cf-proxy。

系统整体调用链（从用户视角）：

1. 用户访问 Landing worker 的文件 URL（`GET /<path>?sign=...`）→ 呈现前端页面（`frontend.js`）
2. 前端视配置决定是否显示/执行：
   - Turnstile 小组件
   - ALTCHA 前端 PoW 挑战
   - pow-bot-deterrent 前端 PoW 挑战
3. 验证通过后，前端调用 `GET /info?path=...&sign=...`（可带 Turnstile / ALTCHA / Powdet 结果）
4. 后端 `handleInfo`：
   - 校验签名 / PoW / 速率限制 / token 绑定
   - 向 AList 查询文件元信息
   - 通过 Unified Check（数据库 RPC）更新并读取一站式状态
   - 构造 download worker 的下载 URL 与附加参数
5. 前端收到 `/info` 结果：
   - 可使用内置 web segment downloader 直连 download worker
   - 或根据配置自动 302 跳转 / 手动点击下载。

## 二、核心模块与职责

### 1. Worker 主入口与路由

文件：`src/worker.js`

- 默认导出对象实现 `fetch(request, env, ctx)`：
  - 调用 `resolveConfig(env)` 解析所有环境变量与运行时配置（包括 DB_MODE、ALTCHA/Powdet/Turnstile 等）
  - 基于 `config.dbMode` 创建：
    - `createRateLimiter`（IP/文件级 DB 限流）
    - `createCacheManager`（文件大小 cache）
  - 调用 `routeRequest(request, env, config, rateLimiter, ctx)`：
    - `OPTIONS` 请求 → `handleOptions`
    - `GET /info` → `handleInfo`（返回 JSON 下载信息）
    - 其它路径 → `handleFileRequest`（渲染 landing HTML 页面）

Landing worker自身不直接向 AList / upstream 代理文件，而是只做「权限+票据发行」以及静态 landing 页渲染。

### 2. handleFileRequest：Landing 页面后端逻辑

`handleFileRequest` 是 landing 的主处理函数，负责：

1. **基本解析**
   - 解析 URL path、查询参数、`Origin` 等；
   - 根据 path 通过 `checkPathListAction` 与 `ACTION` 规则（结合 `BLACKLIST_* / WHITELIST_* / EXCEPT_*` 环境变量）决定：
     - 是否阻断访问（`block`）
     - 是否强制走 Web 下载 / 直接重定向 / 保持默认行为（`pass-web` / `pass-server` / `pass-asis` / `pass-web-download` / `pass-decrypt` 等）
     - 是否强制启用/关闭 ALTCHA/Turnstile/Powdet（`verify-*` 组合）。

2. **CF Rate Limiter（可选）**
   - 若 `ENABLE_CF_RATELIMITER=true`：
     - 使用 `CF_RATELIMITER_BINDING` 绑定的 `Rate Limiter` 计算 IP 子网 hash，执行限流；
     - 若超限，直接返回 429 + `Retry-After`。

3. **DB 限流与 cache 配置**
   - 基于 `DB_MODE`（`""` / `custom-pg-rest`）构造：
     - `rateLimitConfig`：IP 子网限流 + 文件维度限流（`IP_LIMIT_TABLE` / `IP_FILE_LIMIT_TABLE`）
     - `cacheConfig`：文件大小 cache（`FILESIZE_CACHE_TABLE`）
   - `DB_MODE` 为空则完全关闭这些功能，仅依赖 Cloudflare 原生 Rate Limiter 与 PoW。

4. **ALTCHA 动态难度与 Token 绑定配置**
   - 环境变量（见 `wrangler.toml`）：
     - `ALTCHA_ENABLED`：启用前端 ALTCHA PoW
     - `ALTCHA_DIFFICULTY` 或区间：基础难度范围
     - `ALTCHA_DYNAMIC_ENABLED`：启用动态难度（DB 支持）
     - `ALTCHA_DYNAMIC_*`：窗口、重置时间、最大指数、阻断时长等
     - `ALTCHA_TOKEN_EXPIRE` / `PAGE_SECRET` 等用于 HMAC 与 token 过期时间
   - 状态存储：
     - 难度状态表：`ALTCHA_DIFFICULTY_STATE`
     - Token 一次性列表：`ALTCHA_TOKEN_LIST`
   - 逻辑：
     - 根据客户端 IP 计算子网，查 `ALTCHA_DIFFICULTY_STATE`（经 unified RCP 或直接 SQL），计算难度与是否 block；
     - 更新难度状态（IP 连续成功则指数递增，间隔过长则回落/重置）；
     - 生成 ALTCHA challenge（`altcha-lib`）并生成绑定信息（pathHash + IP scope hash + expiresAt + salt），前端承接后提交 `/info`。

5. **Turnstile & Token Binding**
   - 环境变量：
     - `UNDER_ATTACK`：开启 Turnstile 保护
     - `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`
     - `TURNSTILE_TOKEN_BINDING`：是否启用 token 绑定（需要 DB）
     - `TURNSTILE_TOKEN_TTL` / `TURNSTILE_TOKEN_TABLE`
     - 及 action/hostname enforcement 环境变量。
   - 动作：
     - 在 landing 页面侧生成一个与 path + client IP / hash 绑定的 MAC（基于 `PAGE_SECRET`）；
     - 构造 Turnstile Binding payload（`pathHash + ipHash + bindingMac + expires + nonce + cdata`），传递到前端；
     - 若启用 token binding + DB，则使用 `TURNSTILE_TOKEN_BINDING` 表和相关 stored procedure 进行 insert / verify；
     - 前端在 `/info` 请求时附带 Turnstile token 与 binding payload，`handleInfo` 中验证：
       - token → Turnstile siteverify；
       - binding → pathHash / ipHash / cdata / expires 一致性；
       - token 表：IP + 文件 + 未过期 + 未用过（防打码平台）。

6. **Pow-bot-deterrent (Powdet) 集成**

Powdet 是独立部署的 PoW Bot Deterrent 服务（推荐使用本仓库 `powdet/` 目录下的 Argon2id 版本），Landing worker 通过 REST API 与其交互：

- 环境变量（`wrangler.toml`）：
  - `POWDET_ENABLED`：启用 PoW阻断
  - `POWDET_BASE_URL`：Powdet HTTP API 服务地址，例如 `https://powdet.example.com`
  - `POWDET_STATIC_BASE_URL`：Powdet 前端静态资源基地址（可选，未设置时默认 `{POWDET_BASE_URL}/powdet/static` 或 `/powdet/static`）
  - `POWDET_API_TOKEN`：用于 Powdet API 调用的 Bearer Token
  - `POWDET_TABLE_NAME`：一次性挑战票据表名（默认 `POW_CHALLENGE_TICKET`）
  - `POWDET_EXPIRE_SECONDS` / `POWDET_CLOCK_SKEW_SECONDS` / `POWDET_MAX_WINDOW_SECONDS`：前后端时间窗口/容忍度
  - `POWDET_STATIC_LEVEL` 或 `POWDET_DYNAMIC_*`：静态 / 动态难度参数
  - `POWDET_DIFFICULTY_STATE` 表用于存储难度状态。

后端流程：

1. `handleFileRequest` 中，根据 ACTION 与全局开关确定是否需要 Powdet。
2. 若需要并启用动态难度：
   - 使用 `POWDET_DIFFICULTY_STATE`（D1 / D1-REST / PostgREST）查询与更新 per-IP 范围难度；
3. 调用 Powdet 服务 `POST /GetChallenges?difficultyLevel=...` 获取 challenge 字符串；
4. 构造挑战绑定 payload：
   - `ipRangeHash = sha256(ipRange)`（基于 `calculateIPSubnet`）
   - `pathHash = sha256(decodedPath)`
   - `expireAt`、随机字符串 `randomStr`、challenge
   - 使用 `TOKEN` 计算 HMAC（`computePowdetHmac`），得到 `hmac`，并存入 DB（`POW_CHALLENGE_TICKET`）；
5. 将 `{challenge, expireAt, randomStr, hmac}` 通过 `renderLandingPage` 下发到前端。

前端流程：

- `frontend.js` 中：
  - 根据 `web __ALIST_SECURITY__.powdetChallenge` 初始化 headless pow-bot-deterrent 组件：
    - 通过 `powdetStaticBase` 动态加载 JS：默认从 `/powdet/static/pow-bot-deterrent.js` 加载；若配置 `POWDET_STATIC_BASE_URL`，则优先使用该基址（例如 `https://powdet.example.com/powdet/static/pow-bot-deterrent.js`），否则回退到 `{POWDET_BASE_URL}/powdet/static`。
    - 创建隐藏 Form + 容器 `#powdet-headless-container` + widget div，并设置：
      - `data-pow-bot-deterrent-static-assets-cross-origin-url`
      - `data-pow-bot-deterrent-challenge`
      - `data-pow-bot-deterrent-callback="powdetDoneCallback"`
    - 调用 `window.powBotDeterrentInit()` 后触发挖矿 UI（即便容器隐藏，计算仍进行）。
  - Powdet 计算完成后：
    - `window.powdetDoneCallback(nonce)` 被调用；
    - 保存 nonce 到 `state.verification.powdetNonce`；
  - 在点击「获取信息」/自动流程时：
    - 构造 `powdetSolution = {challenge, expireAt, randomStr, hmac, nonce}`；
    - Base64url 编码后作为 `powdetSolution` 查询参数附带到 `/info`。

`/info` 中验证：

1. 重算 `expectedHmac = HMAC(TOKEN, {ipRangeHash,pathHash,expireAt,randomStr,challenge})`，与 payload 的 `hmac` 做恒等时间比较；
2. 校验 `expireAt` 与当前时间（包含 `POWDET_CLOCK_SKEW_SECONDS` 与 `POWDET_MAX_WINDOW_SECONDS`）；
3. 使用 `verifyPowdet()` 调用 Powdet 服务 `POST /Verify?challenge=...&nonce=...` 验证；
4. 若 DB_MODE 存在，记录挑战消费（`POW_CHALLENGE_TICKET` 中置 `CONSUMED`，防二次使用）。

#### ALTCHA / Powdet 动态升级策略

ALTCHA 与 Powdet 都支持按 IP 维度的「动态难度升级」，核心思想类似：同一 IP 范围在短时间内连续成功通过验证，则提升难度；长时间无访问则回落或重置，极端情况下进入短暂封禁。

- ALTCHA 动态难度（`ALTCHA_DIFFICULTY_STATE`）
  - 状态表字段：`IP_HASH`, `IP_RANGE`, `LEVEL`, `LAST_SUCCESS_AT`, `BLOCK_UNTIL`。
  - 每次验证成功后，worker 会根据当前时间与配置：
    - `ALTCHA_DIFFICULTY_WINDOW`：短于该窗口的连续成功会使 `LEVEL+1`（难度翻倍）；
    - `ALTCHA_DIFFICULTY_RESET`：超过该间隔未再成功访问则直接重置为 `LEVEL=0`；
    - 中间区间则按步长下降（`LEVEL=max(LEVEL-1,0)`），实现缓慢降级。
  - 有效级数通过 `ALTCHA_MAX_MULTIPLIER`（或对应 exponent）控制，上限以上会：
    - 设置 `BLOCK_UNTIL = now + ALTCHA_MAX_BLOCK_TIME`；
    - `handleFileRequest` / `handleInfo` 中看到 `blocked=true` 则直接返回 429 + `Retry-After`。
  - 前端实际难度为：
    - `baseDifficulty` 在配置区间内随机选取；
    - `effectiveExponent = clamp(level, 0, maxExponent-1)`；
    - 最终难度 `difficulty = baseDifficulty * 2^effectiveExponent`；
    - 当 exponent 达到 `ALTCHA_MIN_UPGRADE_MULTIPLIER` 指定阈值时，会从 SHA-256 升级为 SHA-384/SHA-512 之一，进一步增加计算成本。

- Powdet 动态难度（`POWDET_DIFFICULTY_STATE`）
  - 状态表字段同样包含：`IP_HASH`, `IP_RANGE`, `LEVEL`, `LAST_SUCCESS_AT`, `BLOCK_UNTIL`。
  - 每次通过 Powdet 验证后，worker 根据配置：
    - 短间隔连续成功 → `LEVEL+1`；
    - 长时间无访问 → 直接归零；
    - 中间区间缓慢回落；
    - 超过 `maxLevel` 且配置了 `blockSeconds` 时，将 IP 范围短期封禁。
  - `getPowdetDifficultyForClient` 会根据当前 `LEVEL` 计算 difficultyLevel：
    - `difficultyLevel = baseLevelMin + level * levelStep`，再 clamp 到 `[baseLevelMin, baseLevelMax]`；
    - 若 LEVEL 达到 `maxLevel`，返回 `blocked=true` + `retryAfterSeconds`，`handleFileRequest` 会以 429 + JSON 提示「powdet blocked」。

两套动态升级机制均通过 `cleanupAltchaDifficultyState` / `cleanupExpiredPowdetTickets` / `cleanupPowdetDifficultyState` 等定期清理老旧记录（以 `ALTCHA_DIFFICULTY_CLEANUP_MAX_AGE` 或 TTL 为界），避免状态表无限增长。

### 3.5 Captcha Context Binding（Turnstile / ALTCHA）

Landing worker 对「验证码」类验证（Turnstile、ALTCHA）做了上下文绑定，确保验证结果只能在同一上下文中使用，避免 Token 被中继或重放。

#### ALTCHA Binding（路径 + IP 范围）

相关函数与结构：

- `buildAltchaPathBindingValue(pathHash, scopeHash, level)`：
  - 将文件路径 hash 与 IP 作用域 hash 以及难度指数封装为 JSON：
    - `v`: 版本号
    - `p`: `pathHash`（通常为 `sha256(解码后的路径)`）
    - `s`: `scopeHash`（`ipRange` 经 `sha256` 得到）
    - `l`: 难度指数（用于 Dynamic Difficulty）
  - 经过 JSON 序列化后再作为「路径绑定值」使用，后续在验证时会重新 canonicalize 并比较，防止字段被篡改。
- `computeAltchaIpScope(clientIP, ipv4Suffix, ipv6Suffix)`：
  - 把 clientIP 映射到子网（`calculateIPSubnet`）并计算：
    - `ipRange`: 子网字符串（例如 `1.2.3.0/24`）
    - `ipHash`: `sha256(ipRange)`
- `buildAltchaBinding(secret, pathHash, ipHash, expiresAt, salt)`：
  - 将 pathHash（含 scopeHash）、IP hash 与过期时间 + salt 作为 payload，使用 `PAGE_SECRET` 进行 HMAC；
  - 得到 `bindingMac`，连同 pathHash / ipHash / expiresAt 一起下发给前端。

挑战下发过程：

1. `handleFileRequest` 中确定需要 ALTCHA 验证时：
   - 计算 `baseChallengePathHash = sha256(decodedPath)`；
   - 计算 `altchaScope = {ipRange, ipHash}`；
   - 使用 `buildAltchaPathBindingValue(baseChallengePathHash, altchaScope.ipHash, effectiveExponent)` 得到 `challengePathHash`；
   - 再计算 `challengeIpHash = sha256(clientIP)`（用于前端 IP binding）；
   - 调用 `createChallenge`（altcha-lib）生成 PoW 挑战；
   - 使用 `buildAltchaBinding(PAGE_SECRET, challengePathHash, challengeIpHash, expiresAt, challenge.salt)` 生成绑定 MAC；
   - 最终 challenge payload 包含：
     - `algorithm, challenge, salt, signature, maxnumber`
     - `pathHash`（包含 scopeHash 的 JSON 串）
     - `ipHash`（clientIP hash）
     - `binding`（MAC）
     - `bindingExpiresAt`。
2. 前端执行 PoW 后：
   - 将完整 payload Base64url 编码为 `altChallengeResult` 并传给 `/info`。

`/info` 中验证：

1. 先使用 `verifySolution`（altcha-lib）进行无状态验证（难度与签名）；
2. 再解析 `pathHash` 为结构体：
   - 通过 `parseAltchaPathBindingValue` 检查 JSON 的 `pathHash/scopeHash/level` 与 canonical value 是否一致；
   - 确保没有被人修改字段（payload tampering 检测）。
3. 重算：
   - `expectedPathHash = sha256(当前请求路径)`；
   - `expectedIpHash = sha256(当前 clientIP)`；
   - 对比：
     - 路径 hash 是否匹配；
     - scopeHash 是否与当前 IP 作用域 hash 一致；
     - `bindingExpiresAt` 是否未过期；
   - 使用 `buildAltchaBinding` 再次生成 expected binding，并比较：
     - pathHash / ipHash / bindingMac / expiresAt 是否与 payload 完全一致；
4. 若 DB_MODE 已配置且 ALTCHA token 列表启用：
   - 再通过 `landing_verify_altcha_token` / `landing_record_altcha_token` 确保 token 对应的：
     - client IP
     - filepath hash
     - expireAt  
     一致且尚未被使用。

通过上述流程，ALTCHA PoW 的结果被硬绑定到「路径 + IP 范围 + 过期时间 + 难度级别」，并且可以选择性与 DB 中的一次性 token 记录联动，防止 token 被重复利用或被转移到其他路径/IP。

#### Turnstile Binding（路径 + IP + cData）

相关函数与结构：

- `buildBindingPayload(secret, pathHash, ipHash, expiresAt, context, additionalData)`：
  - 将 `pathHash`, `ipHash`, `expiresAt` 与 optional 附加字段打包；
  - 使用 `PAGE_SECRET` 做 HMAC，得到 `bindingMac`；
  - 返回 `{pathHash, ipHash, bindingMac, expiresAt}`。
- `buildTurnstileCData(secret, bindingMac, nonce)`：
  - 利用 `PAGE_SECRET` 对「bindingMac + nonce」再做一次 HMAC；
  - 得到 Turnstile `cData`，用于 Cloudflare 官方 siteverify 的 `cdata` 字段校验。

挑战生成过程（handleFileRequest）：

1. 若当前路径需要 Turnstile 且启用了 token binding：
   - 计算 `bindingPathHash = sha256(decodedChallengePath)`；
   - 计算 `bindingIpHash = sha256(clientIP)`；
   - 确定 TTL（`TURNSTILE_COOKIE_EXPIRE_TIME`）得出 `expiresAt`；
   - 调用 `buildBindingPayload(PAGE_SECRET, bindingPathHash, bindingIpHash, expiresAt, 'Turnstile')` 获得 binding；
   - 生成随机 `nonce = generateNonce()`；
   - 调用 `buildTurnstileCData(PAGE_SECRET, binding.bindingMac, nonce)` 得 `cdata`；
   - 将 `{pathHash, ipHash, binding, bindingExpiresAt, nonce, cdata}` 下发给前端，存入 `turnstileBinding`。
2. 前端在调用 `/info` 时：
   - 将 binding payload Base64url 编码为字符串，放在：
     - 请求 header `x-turnstile-binding` 或 query 参数 `turnstile_binding`；
   - 同时准备好 Turnstile widget 所需的 `cdata`（由 `turnstileBinding.cdata` 提供）。

`/info` 中验证：

1. 从 header / query 中读取 binding payload，Base64url 解码为 JSON：
   - 取出 `pathHash`, `ipHash`, `binding`（MAC）, `bindingExpiresAt`, `nonce`, `cdata`；
2. 重算：
   - `expectedPathHash = sha256(当前请求路径)`；
   - `expectedIpHash = sha256(当前 clientIP)`；
   - 调用 `buildBindingPayload(PAGE_SECRET, expectedPathHash, expectedIpHash, bindingExpiresAt, 'Turnstile')`；
   - 比较 pathHash / ipHash / bindingMac / expiresAt 是否全一致；
3. 再调用 `buildTurnstileCData(PAGE_SECRET, bindingMac, nonce)`：
   - 对比 payload 中传入的 `cdata`；
4. 之后再调用 Cloudflare 官方 Turnstile siteverify：
   - 若 `TURNSTILE_ENFORCE_ACTION/HOSTNAME` 启用，则校验 action 与 hostname；
   - 若 `TURNSTILE_TOKEN_BINDING` 开启并配置了 DB_MODE，则再通过 `TURNSTILE_TOKEN_BINDING` 表做一次「IP + pathHash + expiresAt + access_count」核对。

这样，Turnstile token 的使用不仅受限于 Cloudflare 侧的 `siteverify`，还被进一步绑定到 Worker 所看到的「路径 + IP + 自定义 TTL + action/hostname」，阻止攻击者把 token 从一个 IP/路径中继到另一个环境中。

### 3. /info API：统一验证与下载票据发行

`handleInfo` 的主要职责：

1. 解析参数：
   - `path`、`sign`；
   - Turnstile header + binding query；
   - ALTCHA payload（`altChallengeResult`）；
   - `powdetSolution`；
2. 路径与 ACTION：
   - 与 `handleFileRequest` 一致的列表匹配，决定是否 block / 强制开启/关闭三类验证；
3. 执行三类验证（如前节所述）：
   - ALTCHA：调用 `verifySolution`（stateless）+ ALTCHA token 列表（stateful）；
   - Turnstile：siteverify + Token Binding + optional hostname/action enforcement；
   - Powdet：payload 结构校验 + HMAC + 远端验证 + 一次性消费；
4. 签名验证：
   - 基于 `SIGN_SECRET`（默认为 `TOKEN`）与 path:
     - `verifySignature(sign)`：过期 / HMAC 是否匹配；
     - Recalculate sign 再次确认（防 secret 不一致配置）；
   - 若任何失败 → 401/403/500 对应错误码。
5. Unified Check（数据库统一查询，PostgREST 模式）：
   - 当 `DB_MODE=""`：跳过 unified check，依赖 CF Rate Limiter + ALTCHA/Turnstile/Powdet 的无状态校验。
   - 当 `DB_MODE="custom-pg-rest"`：调用 `unifiedCheck`（封装 `landing_unified_check` RPC）：
     - 入参包括：
       - IP hash + IP range（限流）
       - Path hash / Filepath hash
       - ALTCHA token hash（如有）与 IP + filepath hash
       - Turnstile token hash（如有）与 IP + filepath hash
       - Powdet challenge hash（如有）与 expireAt
     - 返回结果：
       - 当前 IP/文件是否超限（IP/文件级限流）
       - 缓存的文件大小（`FILESIZE_CACHE_TABLE`）
       - ALTCHA / Turnstile / Powdet Token 的状态（是否已使用/过期/不匹配）。
     - 若限流或 token 无效，则返回对应错误（含 429/463/464 等细分 code）。
6. 获取 AList 文件信息：
   - 调用 `fetchAlistFileInfo(config, decodedPath, clientIP)`：
     - `POST {ALIST_ADDRESS}/api/fs/get`，附带：
       - `Authorization: TOKEN`（或其它 VERIFY_HEADER/SECRET 组合）
       - 可选 `CF-Connecting-IP-WORKERS` 头，用于后端识别真实 client IP。
   - 从响应中提取：
     - `path` / `size` / `is_dir` / 名称等；
7. 构造下载票据：
   - 选取 download worker 地址：
    - `selectRandomWorker(controller.landing.workerAddresses)`：从 controller 下发列表中随机；
   - 生成 download worker 需要的签名：
     - `sign`：`HMAC-SHA256(path, expire)`（download worker 的 `SIGN_CHECK`）
     - `hashSign`：`HMAC-SHA256(base64(path), expire)`（`HASH_CHECK`）
     - `workerSign`：`HMAC-SHA256(JSON.stringify({path, worker_addr}), expire)`（`WORKER_CHECK`）
   - 构造 `additionalInfo`：
     - 明文字段：
       - `pathHash = sha256(path)`
       - `filesize`（来自 AList 或 size cache）
       - `expireTime`（二次用来控制 download worker 侧链接寿命）
       - `idle_timeout`（结合 `IDLE_TIMEOUT` 等，在 download worker 内做「空闲会话」判定）
     - `encrypt` 字段：使用 AES-256-GCM 对「origin snapshot」加密（包含 IP / Geo / ASN 等）：
       - 密钥由 TOKEN 派生，download worker 用同一 TOKEN 解密；
     - 对 `additionalInfo` 整体做 HMAC（`additionalInfoSign`），由 download worker 端 `ADDITION_CHECK` / `ADDITION_EXPIRETIME_CHECK` 验证。
   - 所有字段组合成最终 download URL，与 meta 一起作为 `/info` 的 JSON 返回。

### 4. 前端：landing 页面、webDownloader 与 client-decrypt

文件：`src/frontend.js` + `src/templates/landing.html.js` + `landing.css.js`

前端职责：

1. 渲染美观的下载页面（主题、Glow 动画等），提供状态栏与进度条。
2. 管理三类安全模块的 UI 状态与交互：
   - Turnstile：嵌入 CF JS，等待 token；
   - ALTCHA：执行前端 PoW；
   - Powdet：通过 pow-bot-deterrent.js 组件做 PoW；
3. 提供三种下载模式（由 `window.__WEB_DOWNLOADER_PROPS__` / `clientDecryptSupported` 决定）：
   - legacy 模式：
     - 页面只负责 `/info` 调用与展示文件信息；
     - 下载按钮直接跳转到 download worker URL（浏览器原生下载，无分段/续传）。
   - webDownloader 模式：
     - `state.mode = 'web'` 时启用。
     - 通过 `webDownloader` 内部的任务调度：
       - 使用 `/info` 返回的 `download.remote`（URL + headers）与 `meta.size` 计算分段布局；
       - 维护若干并发连接（默认 `maxConnections=16`，可通过页面「高级设置」调整）；
       - 支持 Range 请求、多段并行下载、TTFB 超时、自动重试（支持针对 429 做指数回退）；
       - 使用 Dexie（IndexedDB）将：
         - `/info` 结果（download 链接、meta）
         - 分段数据（已完成的 segment）
         - writer 句柄（OPFS 或内存）  
         持久化在 `landing-webdownloader-v2` DB 中，实现刷新后的断点续传；
       - `ensureSessionIsolation` 通过 sessionStorage 标记区分浏览器会话，在新会话开始时清空旧缓存，避免跨 Session 复用敏感状态。
     - 下载完成后根据浏览器能力：
       - 优先使用 File System Access API（OPFS）直接写入文件；
       - 无 OPFS 时在内存累计 Blob，并触发浏览器下载。
   - client-decrypt 模式：
     - 当 `webDownloaderProps.clientDecrypt === true` 且浏览器支持基本 API 时，`state.clientDecrypt.enabled=true`；
     - 页面展示「客户端解密」区域，流程为：
       1. 用户选择本地已下载的加密文件；
       2. 从 `/info` 元信息中获取加密参数（`encryption` / `fileHeaderSize` / `blockHeaderSize` / `blockDataSize` 等）；
       3. 用户输入密码 / salt（可通过内置 Scrypt keygen 功能从密码派生 32 字节 dataKey）；
       4. 前端启动 `runSegmentDecryptionTask`：
          - 使用 Web Worker（由 `tweetnacl` + 内置脚本构造 blob URL）执行分段解密；
          - 每个 Worker 按 block header + data 映射关系，将密文块解密成 plaintext segment；
          - 主线程维护有序写入（按 index 递交 `writeOrderedChunk`），并更新解密进度条。
       5. 解密完成后生成新的 Blob / 文件句柄，供用户保存。
     - client-decrypt 与 webDownloader 的职责分离：
       - webDownloader 负责把密文从 download worker 拉到本地；
       - client-decrypt 只操作本地文件，不再访问网络；两者之间通过 path/meta 中的 crypt 配置保持一致。
4. IndexedDB/Dexie 与会话隔离：
   - webDownloader 使用 `landing-webdownloader-v2` 库管理下载任务状态；
   - client-decrypt 自身不持久化密文，只依赖 `/info` 与用户选择的本地文件；
   - 所有缓存都通过 `STORAGE_SESSION_FLAG` 保证「每个浏览器标签页会话一次性」语义，避免长期残留影响安全策略。

## 三、数据库 schema 与 init.sql 集成

Landing worker 的 DB schema 由 `init.sql` 定义，仅服务 `DB_MODE="custom-pg-rest"`（旧版 D1/D1-REST 已移除）。主要表与函数：

1. IP/文件限流：
   - 表：
     - `"IP_LIMIT_TABLE"`（IP 子网）
     - `"IP_FILE_LIMIT_TABLE"`（IP+PATH）
   - 核心函数：
     - `landing_upsert_rate_limit` / `landing_upsert_file_rate_limit`
     - `landing_cleanup_expired_rate_limits` / `landing_cleanup_expired_file_rate_limits`
2. 文件大小 cache：
   - 表：`"FILESIZE_CACHE_TABLE"`
   - 函数：`landing_upsert_filesize_cache` / `landing_cleanup_expired_cache`
3. Turnstile token binding：
   - 表：`"TURNSTILE_TOKEN_BINDING"`
   - 函数：`landing_upsert_token_binding` / `landing_cleanup_expired_tokens`
4. ALTCHA：
   - 表：
     - `"ALTCHA_TOKEN_LIST"`
     - `"ALTCHA_DIFFICULTY_STATE"`
   - 函数：
     - `landing_verify_altcha_token`
     - `landing_record_altcha_token`
     - `landing_cleanup_expired_altcha_tokens`
     - `landing_get_altcha_difficulty`
     - `landing_update_altcha_difficulty`
     - `landing_cleanup_altcha_difficulty_state`
5. Powdet：
   - 表：
     - `"POW_CHALLENGE_TICKET"`（一次性挑战票据）
     - `"POWDET_DIFFICULTY_STATE"`（动态难度状态）
   - 函数：
     - `landing_consume_pow_challenge`
     - `landing_update_powdet_difficulty`
     - `landing_cleanup_expired_pow_challenges`
     - `landing_cleanup_powdet_difficulty_state`
6. Unified Check：
   - 最重要函数：`landing_unified_check(...)`，在一次 RPC 中整合：
     - 文件大小 cache 读取
     - IP/文件限流 upsert + 判断
     - Turnstile token & ALTCHA token & Powdet 状态检查/消费
     - 返回统一结构供 Worker 作决策。

## 四、关键环境变量（来自 wrangler.toml）

这里只总结与架构/模块相关的关键项，具体说明参考 `wrangler.toml` 中注释：

- 基础：
  - `TOKEN` / `SIGN_SECRET` / `controller.landing.workerAddresses` / `ALIST_ADDRESS`
- Turnstile：
  - `UNDER_ATTACK`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_TOKEN_BINDING`, `TURNSTILE_TOKEN_TTL`, `TURNSTILE_TOKEN_TABLE` 等
- ALTCHA：
  - `ALTCHA_ENABLED`, `ALTCHA_DIFFICULTY`, `ALTCHA_DYNAMIC_ENABLED`, `ALTCHA_*` 系列, `PAGE_SECRET`, `ALTCHA_TOKEN_BINDING_TABLE` 等
- Powdet：
  - `POWDET_ENABLED`, `POWDET_BASE_URL`, `POWDET_STATIC_BASE_URL`, `POWDET_API_TOKEN`, `POWDET_TABLE_NAME`, `POWDET_EXPIRE_SECONDS`, `POWDET_CLOCK_SKEW_SECONDS`, `POWDET_MAX_WINDOW_SECONDS`, `POWDET_STATIC_LEVEL`, `POWDET_DYNAMIC_*`
- DB 模式：
  - `DB_MODE`（`""` / `custom-pg-rest`）
  - `POSTGREST_URL` / `VERIFY_HEADER` / `VERIFY_SECRET`
  - `WINDOW_TIME`, `IPSUBNET_WINDOWTIME_LIMIT`, `FILE_WINDOW_TIME`, `IPSUBNET_FILE_WINDOWTIME_LIMIT`, `BLOCK_TIME`, `PG_ERROR_HANDLE`
  - `SIZE_TTL`, `FILESIZE_CACHE_TABLE`
- CF Rate Limiter：
  - `ENABLE_CF_RATELIMITER`, `CF_RATELIMITER_BINDING`, `IPV4_SUFFIX`, `IPV6_SUFFIX`
- Path 规则：
  - `BLACKLIST_*`, `WHITELIST_*`, `EXCEPT_*`, `*_INCLUDES` 全系列

## 五、小结

alist-landing-worker 的整体定位是「安全网关 + 票据发行中心」：

- 通过 Turnstile + ALTCHA + Powdet 三重 PoW/人机混合机制抵御机器人；
- 通过 CF Rate Limiter + DB 限流 + Unified Check 控制访问频率；
- 将 origin 信息与 IP/Path 牢固绑定，并将所有验证结果折叠成一个安全的 download URL，用于驱动 download worker；
- 前端则提供最小侵入的 UX（多种验证组合、自动/手动下载、多连接分段器），实现安全与体验的平衡。
