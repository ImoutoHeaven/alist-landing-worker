# AList Landing Worker

Cloudflare Workers 版 AList 下载落地网关。它位于 AList 与 download worker 之间，负责安全验证、限流、票据签发，并渲染落地页/辅助下载体验。当前版本完全由 controller 下发配置与决策。

## 核心能力

- 控制面驱动配置与路径决策（bootstrap + 动态 decision）。
- Turnstile / ALTCHA / Powdet 多层验证（Powdet 支持 argon2id/argon2d/randomx 多算法），支持 token binding 与跨验证 link 绑定。
- CF Rate Limiter + PostgREST 统一检查（限流 + token 消费 + 文件大小缓存）。
- 生成 download worker 票据：`payload` / `payloadSign`（含 bindingStr）。
- 快速 302、落地页模式、webDownloader 分段下载与客户端解密。
- 下载 worker 选择支持随机或 HRW（小文件稳定分配）。

## 请求流程（简版）

1. 入口请求先处理内部控制 API（`/api/v0/*`）与可选 `INNER_AUTH`。
2. 拉取 controller bootstrap + decision（内存/D1 缓存），并校验来源域名是否在允许列表。
3. `/info`：验证链 → 统一检查/限流 → 查询 AList 元信息 → 生成下载 URL → 返回 JSON（含 webDownloader/解密信息）。
4. 普通路径：校验签名 → 根据决策选择快速 302 或渲染落地页并下发挑战。

详细流程见 `alist-landing-worker-architecture.md`。

## 配置来源

### Controller 下发

- `common`：`tokenHmacKey`、`signSecret`、`workerAddresses`、`landingWorkerAddresses`、`binding`、`alistBaseUrl`、`alistAuthHeaders`
- `landing`：`pageSecret`、`frontend.*`、`turnstile/altcha/powdet`、`paths.*`、`db`、`crypt`、`webDownloader` 等

### Worker 环境变量（wrangler/Cloudflare）

- **控制面连接**：`CONTROLLER_URL`、`CONTROLLER_API_PREFIX`、`CONTROLLER_API_TOKEN`、`ENV`、`ROLE`、`INSTANCE_ID`
- **Bootstrap 缓存**：`BOOTSTRAP_CACHE_MODE`（`direct`/`d1`）、`CACHE_D1`（仅 d1 模式）、`INIT_TABLES`
- **内部控制 API**：`INTERNAL_API_TOKEN`
- **入口内网鉴权（可选）**：`INNER_AUTH_SECRET`、`INNER_AUTH_HEADER`（默认 `X-Inner-Auth`）
- **CF Rate Limiter（可选）**：`ENABLE_CF_RATELIMITER`、`CF_RATELIMITER_BINDING`

业务策略与验证链参数全部由 controller 下发，wrangler 不再配置这些策略变量。

## 目录结构

- `src/worker.js`：Worker 入口与核心逻辑
- `src/frontend.js`：落地页脚本（验证流程、webDownloader、客户端解密）
- `src/templates/`：落地页模板
- `controller/`：控制面服务（bootstrap/decision/metrics）
- `powdet/`：Powdet 多算法（argon2id/argon2d/randomx）后端与静态资源
- `snippets/`：Cloudflare Snippet（`sign.js`）
- `init.sql`：PostgREST 所需表/函数
- `wrangler.toml`：部署与绑定说明
- `pages_entrance/`：Pages Functions 透明入口（Service Binding → Worker）

## 开发与部署

```bash
npm install
npm run dev
npm run build
npm run deploy
```

前端静态资源需单独托管，并在 controller 的 `landing.frontend.*` 指向相应 URL。

### Pages 透明入口

用于自定义域名入口，保持请求透明转发到 Worker（Service Binding）。入口构建与部署位于 `pages_entrance/`：

```bash
node pages_entrance/build.mjs
wrangler pages deploy --config pages_entrance/wrangler.toml
```

## 升级注意

- 现已将随机 `link` 纳入 Turnstile/ALTCHA/POWDET 的签名与校验，旧版前端若不透传 `link` 会直接 403。
- 多验证同时启用时要求 `link` 一致，否则返回 463；若启用 Turnstile，需开启 binding（`turnstileCookieExpireSeconds > 0`）。
- Powdet 为多算法时，前端需提交 `powdetSolutions` 数组并覆盖所有要求的算法（由 `verify-powdet-argon2id` / `verify-powdet-argon2d` / `verify-powdet-randomx` 决定）。

## 相关项目

- `simple-alist-cf-proxy` – download worker
- `powdet/` – Powdet 后端
