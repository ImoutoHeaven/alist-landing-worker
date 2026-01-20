# Cloudflare Snippet：`sign.js`（URL 签名校验）

本目录提供 Cloudflare Snippets 使用的 `sign.js`，用于在边缘校验 URL 签名（`?sign=`），并支持：

- `/info?path=...` 语义（用 `path` 参数作为签名输入）
- `/d/...`、`/p/...` 前缀归一化（可选）

无状态 PoW/Turnstile snippet 与其前端资源已迁移至：

- `git@github.com:ImoutoHeaven/snippet-posw.git`

## 文件说明

- `sign.js`：核心逻辑（路由匹配、签名校验、/info 语义）。
- `build.mjs`：构建 `dist/snippet.js`，用于粘贴到 Cloudflare Snippets。
- `dist/snippet.js`：构建产物。

## Snippets 顺序

如果同时部署 PoW/Turnstile + 签名校验，请确保顺序：

1. PoW/Turnstile snippet（来自 `snippet-posw`）
2. `sign.js`

## 配置

在 `sign.js` 中编辑 `CONFIG`：

```js
const CONFIG = [
  // /info?path=...：启用 info 语义
  { pattern: "alist-landing-*.example.com/info", config: { HMAC_SECRET: "replace-me", enableInfoEndpoint: true } },

  // 其余路径：校验 ?sign=（可选 /d 或 /p 前缀归一化）
  { pattern: "alist-landing-*.example.com/**", config: { HMAC_SECRET: "replace-me", stripDownloadPrefix: true } },
];
```

### pattern 规则

- 形式为 `host/path`，例如 `alist-landing-*.example.com/**`。
- `host` 中的 `*` 只匹配单段子域名（不跨 `.`）。
- `path` 支持 `*`（单段）与 `**`（任意层级）。
- 不写 `path` 则匹配该 host 的所有路径。
- **按数组顺序匹配，先匹配到的规则生效**，建议将 `/info` 规则放在更前面。

### 支持的配置字段

- `HMAC_SECRET`（string）：签名密钥；为空则不校验 `?sign=`，直接放行。
- `enableInfoEndpoint`（boolean）：当请求路径为 `/info` 时生效，使用 `path` 查询参数作为签名输入，并基于该路径重新匹配规则。
- `stripDownloadPrefix`（boolean）：仅对非 `/info` 请求生效，将 `/d/...`、`/p/...` 归一化后再参与签名计算；路径匹配仍使用原始路径。

### `sign` 格式

```
sign = base64url(HMAC_SHA256(secret, authPath + ":" + expire)) + ":" + expire
```

其中 `expire` 为 Unix 秒级时间戳。  
本实现的 base64url 仅将 `+`→`-`、`/`→`_`，**保留 `=` 填充**，签名生成端需保持一致。

### 行为说明

- 未匹配到配置时返回 `500 misconfigured`。
- `OPTIONS` 返回 204（包含 CORS 头）。
- 签名无效/过期/不匹配返回 401。

## 构建

```bash
node build.mjs
```

输出：`dist/snippet.js`（含大小检查，超 32KB 会返回非 0 码）。
