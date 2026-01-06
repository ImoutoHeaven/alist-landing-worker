# Snippets（Cloudflare）无状态 PoW 前置防火墙

本目录提供一套可直接部署在 Cloudflare **Snippets / Workers** 上的“前置鉴权 + PoW（工作量证明）”脚本，用于在不引入 KV/DO/数据库的前提下，为全站或特定路径提供可控的访问门槛。

核心目标：

- **无状态（Snippets 自身不记忆）**：不依赖任何持久化存储；仅使用 HMAC 派生与短期 Cookie 完成验证闭环。
- **可计价的访问资格**：把“通过验证”铸造成可验证的 token（Cookie），并可与 Cloudflare WAF 的 Rate Limit 规则换算成“配额货币”。
- **上限由物理定律决定**：协议强制多轮串行网络往返（RTT-LOCK），即使算力极强也无法绕过网络串行瓶颈。

---

## 目录结构

- `src.js`：Worker/Snippet 主逻辑（签名校验 + PoW API + 挑战页响应 + 配置匹配）。
- `template.html`：挑战页模板（内联加载 `glue.js` 并启动求解流程）。
- `glue.js`：浏览器端胶水层（UI + 调用 PoW API + 成功后跳转）。
- `esm/esm.js`：PoSW 求解器（生成 hash chain + Merkle root + opens 证明）。
- `build.mjs`：构建脚本（压缩 HTML 模板并打包 `src.js` 到 `dist/snippet.js`）。
- `dist/snippet.js`：打包产物（通常用于粘贴到 Cloudflare Snippet）。

---

## 工作原理（高层）

1. **规则匹配**：按 `CONFIG`（域名/路径模式）选出一条规则并合并到 `DEFAULTS`。
2. **可选签名校验**：若配置了 `HMAC_SECRET`，则对 `?sign=...` 做 HMAC 校验（含过期时间），不通过直接拒绝。
3. **PoW 前置**：当 `powcheck: true` 时，未通过 PoW 的访问：
   - 对“导航/HTML 请求”返回挑战页（内联参数，拉起 `glue.js` + 求解器）。
   - 对非导航请求返回 `403 { code: "pow_required" }`。
4. **无状态 PoW API**：`POST /__pow/commit` → `POST /__pow/challenge` → 多次 `POST /__pow/open`，通过后写入 `__Host-pow_sol` Cookie。

无状态要点：

- 服务端不保存会话；`ticket/commit/state token` 全由 HMAC 绑定生成与校验。
- 临时状态放在短期 Cookie（`__Host-pow_commit` / `__Host-pow_sol`）中，过期自动失效。
- 默认绑定项（路径/IP 段/TLS 指纹等）用于降低跨客户端复用与重放。

---

## CCR 机制（Commit → Challenge → Response/Open）

本实现的 PoW 交互是典型的 **CCR**（也可理解为“先承诺、再出题、再作答”）：

1. **Commit（承诺）**：浏览器先完成 PoSW 计算得到 `rootB64 + nonce`，调用 `POST /__pow/commit`。服务端校验 `ticket.mac` 等绑定后，签发短期 `__Host-pow_commit`（其中包含 `ticketB64/rootB64/pathHash/nonce/exp/spineSeed/mac`）。
2. **Challenge（出题）**：浏览器调用 `POST /__pow/challenge`，服务端基于 `powSecret` + `commit.mac` 通过确定性 RNG 生成抽样 `indices`、每个索引的 `segLen`、以及本批需额外提供“中点证明”的 `spinePos`，并返回 `token`（绑定 `cursor/spinePos`）。
3. **Response/Open（作答）**：浏览器对本批 `indices` 生成 `opens`（见下节），调用 `POST /__pow/open`。服务端验证通过则推进 `cursor` 并返回下一批 challenge；全部批次通过后签发 `__Host-pow_sol` 通行证 Cookie。

CCR 的关键收益：

- **先承诺 root，再抽样验证**：避免服务端保存大状态，同时让客户端无法“见题再改题”。
- **串行推进（RTT-LOCK）**：每批 `/open` 必须携带与 `cursor/spinePos` 绑定的 `token`，无法并行/乱序。

---

## PoSW + Merkle：为什么能抽样验证

### PoSW 链（顺序工作量）

浏览器按严格顺序构造长度为 `L` 的哈希链（示意）：

- `chain[0] = SHA256("posw|seed|" + binding + "|" + nonce)`
- `chain[i] = SHA256("posw|step|" + i + chain[i-1])`（`i=1..L`）

该结构的目的不是阻止攻击者并行算更多会话，而是确保“单条链的生成具有强顺序性”，并能与抽样段验证配合形成概率约束。

### Merkle 承诺（一次承诺、任意抽样开示）

将所有 `chain[i]` 做叶子哈希并构建 Merkle 树，得到 `rootB64` 作为承诺：

- 叶子：`leaf[i] = SHA256("leaf|" + i + chain[i])`
- 节点：`node = SHA256("node|" + left + right)`

抽样时，浏览器对每个被要求的索引 `i` 给出：

- `hPrev = chain[i-segLen]` 与其 Merkle 证明 `proofPrev`
- `hCurr = chain[i]` 与其 Merkle 证明 `proofCurr`
- 若该位置被选中为 `spinePos`，还需提供段内某个“中点” `hMid` 与 `proofMid`

服务端验证分两层：

- **段内顺序推导**：从 `hPrev` 连续推导 `segLen` 次，检查是否等于 `hCurr`（必要时同时校验中点）。
- **Merkle 证明**：验证 `hPrev/hCurr(/hMid)` 都确实包含在承诺的 `rootB64` 中。

因此，攻击者若试图“漏步/稀疏计算/随便编造”，就必须赌抽样段恰好不覆盖其坏步/坏区间；默认参数会使该赌局在期望上变为负收益。

---

## 协议串行（RTT-LOCK）与吞吐上限

PoW 通过过程是**严格串行**的：每一批 `/open` 都依赖上一次返回的 `cursor`/`token`（`token` 绑定了 `cursor` 与 `spinePos`），因此无法并行、无法乱序。

在默认参数下：

- 抽样总数 `S = 2 + POW_SAMPLE_K * POW_CHAL_ROUNDS = 182`
- 每批 `POW_OPEN_BATCH = 15`，需要 `/open` 次数 `m = ceil(S / 15) = 13`
- 仅 PoW API 的串行请求数 `M_api = 1(/commit) + 1(/challenge) + m(/open) = 15`

因此每个 IP 的 token 铸造吞吐天然受限于：

- `tokens/s ≤ 1 / (M_api * RTT)`

该上限来自网络往返延迟（物理/链路约束），与本地算力强弱无关。

---

## 与 Cloudflare WAF Rate Limit 的“汇率换算”

推荐在全站前置一条 WAF Rate Limit（例如：`50 req / 10s / per IP`），并确保 PoW API 与受保护路径都计入同一预算。

由于默认铸造一次 token 至少消耗 `M_api=15` 次串行请求，可视为：

- `1 个 pow_sol ≈ 15 个 RateLimit 配额单位`
- 在 `50/10s/IP` 下，理论上每 IP 每 10 秒最多铸造 `floor(50/15)=3` 个 token

这样可把 Cloudflare 免费提供的 RateLimit 计数器当作“有状态配额管控器”（状态在 WAF，不在 Snippets），而 Snippets 自身仍保持无状态。

---

## 并行攻击与“链式断裂”对抗（抽样验证的经济学）

PoSW 链本身不是“抗并行”的密码学原语：攻击者可以尝试在某个断点 `b` 前后并行计算两段链，并赌服务端抽样恰好不跨过该断点。

脚本通过两点让该类并行在期望上无利可图：

- **抽样段顺序推导**：服务端验证区间 `(i-segLen, i]` 的连续性；只要任一抽样段跨过断点，立刻失败。
- **确定性分桶抽样**：抽样索引覆盖更均匀，降低“赌漏检”的成功率。

默认参数下（`L=8192`、`segLen≈48..64`、`S=182`）：

- 攻击者即使选择最有利的断点位置，漏检概率仍会被压到一个较低水平；
- 失败需要重试，导致**总算力/总时间期望被失败率成倍放大**，从经济博弈角度变成负期望行为。

---

## “偷懒作弊”变种（减少总工作量）的结果

本实现的作弊面主要来自“抽样验证”这一普遍形态。典型偷懒包括：漏步、稀疏计算、随机编造、只在验证点即时计算等。

总体结论：

- **随机编造**（伪造 opens/证明）几乎必定失败：需要同时满足段内顺序推导与 Merkle 证明一致性。
- **漏步/稀疏计算**本质上引入“坏步/坏区间”，只要被任何抽样段覆盖就会失败；想省的越多，漏检概率越低、期望重试越高。
- **计算 on 验证 / 流式计算**多属于“省内存/换实现”，不等价于省算力；在多数实现里反而更慢。

---

## 默认参数的意图（`DEFAULTS`）

`src.js` 内置一组默认值作为“安全基线”，每条规则最终配置为：`{ ...DEFAULTS, ...rule.config }`。

> 约束提示：脚本会对部分数值做裁剪/取整。例如 `POW_OPEN_BATCH` 运行时会被夹在 `1..32`，`POW_SEGMENT_LEN` 会被夹在 `1..64`（区间模式同样裁剪），步数 `L` 会被 `POW_MIN_STEPS/POW_MAX_STEPS` 限制。

| 参数 | 默认值 | 意图 / 作用 |
|---|---:|---|
| `powcheck` | `false` | 是否启用 PoW 前置；生产需在 `CONFIG` 显式开启。 |
| `enableInfoEndpoint` | `false` | 是否启用 `/info?path=...` 的“路径代入”特殊逻辑；默认关闭（`/info` 被当作普通路径）。 |
| `stripDownloadPrefix` | `false` | 是否把 `/d/...`、`/p/...` 统一映射为真实路径参与鉴权/绑定（减少下载前缀带来的路径差异）。 |
| `POW_VERSION` | `3` | PoW 协议版本号；用于票据/验证兼容。 |
| `POW_API_PREFIX` | `"/__pow"` | PoW API 前缀（`/commit`、`/challenge`、`/open`）。 |
| `POW_DIFFICULTY_BASE` | `8192` | PoSW 链长度的基础值（主要成本旋钮）。 |
| `POW_DIFFICULTY_COEFF` | `1.0` | 难度系数；与 `BASE` 相乘后再被 `MIN/MAX` 夹住。 |
| `POW_MIN_STEPS` | `512` | 最小链长度下限（避免过低难度）。 |
| `POW_MAX_STEPS` | `8192` | 最大链长度上限（避免过高难度导致体验/资源问题）。 |
| `POW_HASHCASH_BITS` | `3` | Hashcash 前导 0 位要求；作为总体成本的指数级倍率放大器（期望倍率约 `2^bits`）。 |
| `POW_SEGMENT_LEN` | `"48-64"` | 抽样段长度规格；支持固定值（如 `56`）或区间（如 `"48-64"`）；越大越不易漏检“坏步/坏区间”，但单次验证更重。 |
| `POW_SAMPLE_K` | `15` | 每轮抽样的额外样本数；总样本约 `2 + POW_SAMPLE_K*POW_CHAL_ROUNDS`。 |
| `POW_SPINE_K` | `2` | 每批额外要求携带“中点证明”的位置数（对段内一致性与作弊的约束加强）。 |
| `POW_CHAL_ROUNDS` | `12` | 抽样轮数；主要影响样本总量与协议往返次数（RTT-LOCK 强度）。 |
| `POW_OPEN_BATCH` | `15` | 每次 `/open` 验证的样本数量（用于 Snippets CPU 分片；也决定需要多少轮网络往返）。 |
| `POW_FORCE_EDGE_1` | `true` | 强制抽样包含索引 `1`（覆盖链起点附近的连续性）。 |
| `POW_FORCE_EDGE_LAST` | `true` | 强制抽样包含索引 `L`（覆盖链终点；`POW_HASHCASH_BITS>0` 时也用于强制校验 hashcash）。 |
| `POW_COMMIT_TTL_SEC` | `120` | `__Host-pow_commit` 有效期（提交 root 后的短期窗口）。 |
| `POW_TICKET_TTL_SEC` | `600` | challenge `ticket` 有效期（允许用户在一定时间内完成挑战）。 |
| `POW_SOL_TTL_SEC` | `600` | `__Host-pow_sol` 有效期上限（通行证窗口；实际还会受 `ticket` 剩余时间限制）。 |
| `POW_BIND_PATH` | `true` | 是否绑定到路径哈希；开启后 token 难以跨路径复用，适合抑制枚举/爆破。 |
| `POW_BIND_IPRANGE` | `true` | 是否绑定到 IP 段（IPv4/IPv6 前缀由下两项决定）；降低跨 IP 复用。 |
| `POW_BIND_COUNTRY` | `false` | 是否绑定到国家；可加强约束，但更容易误伤/漂移。 |
| `POW_BIND_ASN` | `false` | 是否绑定到 ASN；同上，增强约束但可能增加漂移风险。 |
| `POW_BIND_TLS` | `true` | 是否绑定到 TLS 指纹哈希（CF 提供的指纹信息）；降低跨客户端重放。 |
| `IPV4_PREFIX` | `32` | IP 段绑定使用的 IPv4 CIDR 前缀（`/32` 表示精确到单 IP）。 |
| `IPV6_PREFIX` | `64` | IP 段绑定使用的 IPv6 CIDR 前缀（默认 `/64`）。 |
| `POW_COMMIT_COOKIE` | `"__Host-pow_commit"` | 提交阶段 Cookie 名；以 `__Host-` 前缀强化作用域约束。 |
| `POW_SOL_COOKIE` | `"__Host-pow_sol"` | 通过后的通行证 Cookie 名。 |
| `POW_ESM_URL` | （见源码） | 浏览器端求解器 ESM 地址（`esm/esm.js`）；可替换为自托管/固定 commit 的 CDN 地址。 |
| `POW_GLUE_URL` | （见源码） | 浏览器端胶水脚本地址（`glue.js`）；同上。 |

---

## 配置（`CONFIG`）编写指南

在 `src.js` 顶部的 `CONFIG` 数组中添加规则：

```js
const CONFIG = [
  {
    pattern: "alist-landing-*.example.com/**",
    config: {
      powcheck: true,
      HMAC_SECRET: "与你的后端签名一致的密钥", // 可留空以关闭 sign 校验
      POW_TOKEN: "用于 PoW 的密钥（推荐独立于 HMAC_SECRET）",
      stripDownloadPrefix: true,
    },
  },
];
```

关键建议：

- **生产环境推荐设置 `POW_TOKEN`**。当 `HMAC_SECRET` 为空时，仍需 `POW_TOKEN` 才能开启 PoW；否则会返回 `misconfigured`。
- `HMAC_SECRET` 用于校验 `?sign=...`（如果你们已有签名链路）；不需要签名校验可留空。
- 只覆写你确实需要调整的字段；其余保持默认以获得既定的约束力与协议特性。

---

## `sign` 参数生成规范（HMAC 签名）

当且仅当配置了非空 `HMAC_SECRET` 时，脚本会强制校验查询参数 `?sign=...`。其生成规则为：

- 计算：`mac = HMAC_SHA256(HMAC_SECRET, authPath + ":" + expire)`
- 编码：`b64 = base64url(mac)`（URL-safe Base64，`+`→`-`、`/`→`_`，**保留** `=` padding）
- 拼接：`sign = b64 + ":" + expire`

其中：

- `expire` 为 Unix 时间戳（秒，十进制整数）。服务端判断过期条件为 `expire > 0 && expire < nowSeconds`，建议只签发短期过期值并由后端做上限控制。
- `authPath` 是参与签名的“规范化路径”，必须与脚本一致：
  - 普通请求：`authPath = decodeURIComponent(pathname)`，保证以 `/` 开头；若 `stripDownloadPrefix: true` 则签名的是剥离 `/d`、`/p` 前缀后的路径。
  - `/info` 请求：仅当 `enableInfoEndpoint: true` 时，`authPath` 才来自 `path` 参数（见下节），且 **不会**执行 `stripDownloadPrefix`；否则 `/info` 与普通路径一致。

> 实践建议：将 `sign` 作为 URL 参数传输时，请对其做 URL 编码（尤其在包含 `=` padding 时）。

---

## `/info` 端点说明（路径代入）

`/info` 的“路径代入”逻辑存在一定风险，因此本功能**默认关闭**。仅当规则配置 `enableInfoEndpoint: true` 时，脚本才会把 `/info` 当作特殊路径处理。

- 请求格式：`/info?path=%2Fsome%2Fpath[&sign=...]`
- 行为：当访问 `/info` 时，脚本会把 `path` 参数解析为 `canonicalPath`，并用它替代 `url.pathname` 参与：
  - `CONFIG` 的规则匹配（`matchPath`）
  - `sign` 校验输入（`authPath`）
  - PoW 绑定与校验（路径哈希等）
- 失败返回：缺少/非法 `path` 会返回 `400`（如 `path is required`、`invalid path encoding`、`invalid path`）。

注意事项：

- `/info` **不会**应用 `stripDownloadPrefix`（避免对 `path` 参数做二次语义变换）。
- 通过校验后的“回源请求”仍然是对 `/info` 本身的 `fetch(request)`；因此你们的源站/应用需要自行实现 `/info` 的响应逻辑（通常用于查询/诊断/元信息接口），否则会回源 404。
- 若不需要该能力，建议在源站侧移除/拒绝 `/info`，并在 WAF/RL 中对 `/info` 单独限流。

---

## 规则匹配与顺序（非常重要）

匹配由 `pickConfigWithId(hostname, path)` 完成，规则行为如下：

- **按 `CONFIG` 数组从前到后扫描，命中第一条即停止**（先匹配先得）。
- `pattern` 支持三种粒度：
  - 仅主机：`example.com`
  - 主机 + 路径：`example.com/*`、`example.com/**`
  - 主机通配：`alist-landing-*.example.com/**`

通配语义（简述）：

- 主机 `*`：匹配单个子域段（不跨 `.`）。
- 路径 `*`：匹配单段（不跨 `/`）。
- 路径 `**`：匹配任意深度（可跨 `/`）。

由于“第一条命中即生效”，请把更具体的规则放在更前面。

---

## 部署与构建

- 推荐使用 `build.mjs` 打包得到 `dist/snippet.js`（包含压缩后的 HTML 模板与 ESM 打包产物）。
- `POW_ESM_URL` 与 `POW_GLUE_URL` 默认指向 CDN；如需自托管，请替换为你们自己的地址并确保可被挑战页访问。

---

## 运维建议（强烈推荐）

- 在 Cloudflare WAF 配置全站前置 Rate Limit（例如 `50 req / 10s / per IP`），把 PoW 铸币过程视为固定“汇率”消耗，形成无状态配额管控。
- 关注 `POW_OPEN_BATCH` 与 Rate Limit 的配合：批次越多（越串行），“每枚 token 消耗的请求预算”越高，越能把吞吐压到可控范围。
- 对高风险路径提高 `POW_DIFFICULTY_COEFF` 或降低 `POW_OPEN_BATCH`（增强 RTT-LOCK），而不是盲目提高 `POW_SAMPLE_K/POW_CHAL_ROUNDS`。

---

## 与 Managed Challenge 的正交防护（推荐叠加）

你们可以在 WAF Rate Limit 之外，再叠加 Cloudflare **Managed Challenge**（其发放 `cf_clearance` Cookie）。这与本 Snippets 的 `__Host-pow_*` Cookie 体系是正交的：

- **两套通行证互不依赖**：Managed Challenge 只关心 `cf_clearance`；本脚本只关心 `__Host-pow_sol`（以及短期 `__Host-pow_commit`）。浏览器会自动携带这两类 Cookie，因此可自然叠加。
- **对 `/__pow/*` 的影响更小**：只要 Managed Challenge 在用户首次进入站点时就完成并写入 `cf_clearance`，后续调用 `/__pow/*` API 也会携带 `cf_clearance`，不会额外增加 PoW 协议摩擦（通常无需专门“放开” `/__pow`）。
- **TLS 指纹的同源绑定增益**：Managed Challenge 必然依赖 Cloudflare 的 TLS/浏览器指纹体系发放 `cf_clearance`；而本脚本默认 `POW_BIND_TLS=true` 将 TLS 指纹哈希纳入 PoW 绑定。两者叠加能显著降低“搬运/中转/分工”攻击（例如一端过 Challenge、另一端刷接口）的可行性。
- **同一请求链路的原子性**：TLS 指纹采集、WAF 判定与 Snippets/Worker 逻辑发生在 Cloudflare 边缘的同一处理流水线上，对攻击者而言在物理上难以拆分成两个互相独立的阶段来绕过绑定。

实践建议：

- 让 Managed Challenge 尽量发生在“入口/导航请求”阶段，避免首次 `/__pow/*` 调用就被挑战页打断导致 PoW 交互不稳定。
- Rate Limit 仍建议覆盖 `/__pow/*` 与受保护路径，使 token 铸造可按固定“汇率”消耗配额，形成确定的吞吐上限。
