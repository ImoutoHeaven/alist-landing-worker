# AList Landing Worker

Cloudflare Workers 版 AList 下载「落地网关」。它部署在 AList / 下载 Worker（例如 `simple-alist-cf-proxy`）前面，提供多层防爬与限流、票据签发，以及一个带有分段下载/客户端解密的落地页 UI。

## Key Features

- **多层安全防护**：Cloudflare Turnstile、ALTCHA PoW、人机混合 Pow Bot Deterrent（Argon2id）。
- **数据库限流**：支持 PostgREST 的 IP / IP+文件级限流与缓存，并通过统一检查（Unified Check）减少往返。
- **下载票据签发**：校验 AList 签名 URL，生成短效下载票据（`sign`、`hashSign`、`workerSign`、`additionalInfo`），统一驱动 download worker。
- **灵活下载模式**：快速 302 跳转模式，或带安全组件的 HTML 落地页，可选浏览器分段下载（webDownloader）与客户端解密。
- **AList 集成**：从 AList 查询文件元信息，将路径/大小/加密元信息传递给 download worker。
- **多种 DB 模式**：支持纯无状态与 `custom-pg-rest`（PostgREST）模式。
- **内置 Argon2 Powdet 后端**：`powdet/` 目录提供 Argon2id pow-bot-deterrent 后端与静态资源，可直接部署并通过 `/powdet/static` 提供前端脚本。

## Request Flow（简要）

1. 用户访问带签名的落地页 URL：  
   `GET /path/to/file?sign=...`
2. Worker 解析路径与 ACTION（黑名单/白名单/except 规则），决定：
   - 是否直接阻断访问
   - 是否要求 Turnstile / ALTCHA / Powdet 验证
   - 返回 HTML 落地页还是 302 跳转。
3. 若返回落地页，前端会渲染：
   - Turnstile（当 `UNDER_ATTACK=true`）
   - ALTCHA PoW 挑战
   - Pow Bot Deterrent 挑战（来自 Argon2 后端）
4. 验证通过后，前端调用：  
   `GET /info?path=...&sign=...`（可附带 Turnstile / ALTCHA / Powdet 结果）。
5. Worker 后端：
   - 校验签名与各类安全挑战
   - 调用统一检查（Unified Check）做 DB 限流 / Token 消费 / 文件大小缓存
   - 必要时向 AList 查询文件信息
   - 生成下载票据与附加元信息。
6. 前端随后：
   - 要么跳转到 download worker URL
   - 要么启用内置 webDownloader 分段下载（可断点续传）与可选客户端解密。

内部详细架构请参考根目录 `alist-landing-worker-architecture.md`。

## Project Layout

- `src/worker.js` – Cloudflare Worker 入口，负责路由（`/` vs `/info`）与全部后端逻辑。
- `src/frontend.js` – 落地页脚本，负责安全验证前端流程、webDownloader、客户端解密等。
- `src/templates/` – 落地页 HTML/CSS 模板。
- `init.sql` – `custom-pg-rest` 模式下使用的数据库 Schema 与函数。
- `wrangler.toml` – Worker 配置与环境变量注释说明。
- `powdet/` – Argon2id Pow Bot Deterrent 后端（`/GetChallenges`、`/Verify`）及 `/powdet/static/` 下的前端资源。
- `DEPLOYMENT.md` – 详细部署与环境变量配置指引。

## Features in Detail

### Security Layers

- **Cloudflare Turnstile**
  - 通过 `UNDER_ATTACK=true` 启用。
  - 可选 Token Binding：将 Turnstile token 与「路径 + IP」绑定，防止中继与重放。
- **ALTCHA**
  - 为 `/info` 提供 PoW 型防爬挑战。
  - 支持纯无状态模式与 DB 支持的 token 列表，防止跨路径/IP 重放。
- **Pow Bot Deterrent（Powdet）**
  - 外部 Argon2 PoW 服务（推荐使用本仓库 `powdet/`）。
  - Landing worker 通过 `POWDET_API_TOKEN` 调用 `/GetChallenges` 与 `/Verify`。
  - 前端通过 `/powdet/static` 或自定义 `POWDET_STATIC_BASE_URL` 加载 widget 与 worker 资源。

### Rate Limiting & DB Modes

- **DB 模式**
  - `DB_MODE` 为空：不使用 DB 限流/缓存，仅依赖 Cloudflare Rate Limiter/PoW。
  - `custom-pg-rest`：使用 PostgREST 与 `init.sql` 中定义的 Schema。
- **统一检查（Unified Check）**
  - 在一次 RPC 中：
    - 更新并读取 IP / 文件限流状态
    - 管理 ALTCHA / Turnstile / Powdet Token 状态
    - 读取/更新文件大小缓存。

### Download Tickets & Signatures

Landing worker 校验 URL 中的原始 `sign`，并为 download worker 生成最终下载 URL，其中包含多段签名：

1. **`sign`** – 原始 URL 签名：  
   `HMAC-SHA256(path, expire)`
2. **`hashSign`** – 基于 Base64 路径的签名：  
   `HMAC-SHA256(base64(path), expire)`
3. **`workerSign`** – 绑定路径与选中的 download worker 地址：  
   `HMAC-SHA256(JSON.stringify({path, worker_addr}), expire)`
4. **`additionalInfo` / `additionalInfoSign`** – Origin 绑定与附加元数据：
   - JSON payload 包含：
     - `pathHash` – `sha256(path)`
     - `filesize` – 文件大小（来自 AList 或缓存）
     - `expireTime` – 有效期时间戳
     - `idle_timeout` – download worker 侧空闲超时
     - `encrypt` – AES-256-GCM 加密的 origin snapshot（IP + Geo + ASN）
     - `isCrypted` – 当前路径是否作为加密文件处理
   - 序列化后 Base64 编码为 `additionalInfo`（去掉尾部 `=`）。
   - 签名：`additionalInfoSign = HMAC-SHA256(additionalInfo, expire)`。

Download worker（例如 `simple-alist-cf-proxy`）应当：

- 使用共享的 `TOKEN` / `SIGN_SECRET` 校验所有签名；
- 解密并根据配置校验 origin snapshot（`CHECK_ORIGIN`）；
- 根据 `expireTime` 与 `idle_timeout` 控制链接与会话生命周期。

### Frontend Modes

- **快速 302 跳转**
  - 当 `FAST_REDIRECT=true` 且无需额外验证时，Worker 直接返回 302 跳转到 download worker URL。
- **落地页 HTML**
  - 默认模式：渲染带 Turnstile / ALTCHA / Powdet 的动态页面，展示文件元信息与状态栏。
- **Web Downloader**
  - 通过 `WEB_DOWNLOADER_ENABLED=true` 与相关 CRYPT 参数启用。
  - 特性：
    - Range 请求、多连接分段下载
    - 自动重试与 429 退避
    - 利用 Dexie/IndexedDB 做断点续传。
- **Client-decrypt**
  - 当存在 crypt 元信息且 `CLIENT_DECRYPT_ENABLED=true` 时，页面提供「客户端解密」区域。
  - 用户可：
    - 使用任意方式下载密文文件；
    - 在页面选择本地密文文件并输入密钥；
    - 由浏览器在本地完成解密，无需再次访问上游。

## Configuration Overview

完整环境变量列表请参考 `wrangler.toml` 注释与 `DEPLOYMENT.md`。核心项包括：

- **基础：**
  - `TOKEN`, `SIGN_SECRET`, `WORKER_ADDRESS_DOWNLOAD`, `ALIST_ADDRESS`
- **安全：**
  - Turnstile：`UNDER_ATTACK`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_TOKEN_*`
  - ALTCHA：`ALTCHA_ENABLED`, `ALTCHA_*`, `PAGE_SECRET`
  - Powdet：`POWDET_ENABLED`, `POWDET_BASE_URL`, `POWDET_STATIC_BASE_URL`, `POWDET_API_TOKEN`, `POWDET_*`
- **数据库：**
  - `DB_MODE`, `POSTGREST_URL`, `VERIFY_HEADER`, `VERIFY_SECRET` 等
- **路径规则：**
  - `BLACKLIST_*`, `WHITELIST_*`, `EXCEPT_*` 及 `pass-web` / `pass-server` / `pass-asis` / `pass-web-download` / `pass-decrypt` 等动作。

具体配置样例与推荐值请参考 `DEPLOYMENT.md`。

## Development & Deployment

基础工作流：

```bash
# 安装依赖
npm install

# 本地开发（wrangler dev）
npm run dev

# 构建生产版本
npm run build

# 部署到 Cloudflare
npm run deploy
```

更详细的部署步骤与 PostgREST 配置，请参阅 `DEPLOYMENT.md`。

## Related Projects

- `simple-alist-cf-proxy` – 推荐搭配使用的 download worker，实现 AList 文件实际下载。
- `powdet/` – 本项目使用的 Argon2 Pow Bot Deterrent 后端。

## License

MIT
