# Controller（Go）

本目录是 alist-landing-worker 的控制面，用于向各角色下发配置、执行路径决策并收集指标。

## 主要职责

- `POST /api/v0/bootstrap`：按 role/env 返回完整配置（含 paths 规则与 landing/download/powdet/slot-handler 配置）。
- `POST /api/v0/decision`：基于请求上下文输出路径决策结果。
- `POST /api/v0/metrics`：接收组件指标批次。
- `POST /api/v0/admin/reload`：重新加载 `config.yaml` 并刷新规则。
- `POST /api/v0/debug/decision`：与 decision 相同，用于调试。

所有接口使用 `Authorization: Bearer <apiToken>` 认证，未授权会直接返回 404。

## 配置说明

默认读取 `config.yaml`，可用 `-c` / `-config` 指定路径。顶层字段：

- `apiToken`、`bootstrapVersion`、`rulesVersion`、`listenAddr`
- `envs.<env>`：包含 `common/landing/download/powdet/slotHandler`

路径规则只使用 `paths.*`（`paths.global`、`paths.pathProfiles`、`paths.pathRules`）。

download breaker 相关：

- `download.throttleProfiles.default` 是下载 breaker 的必填 profile key。
- `download.paths.pathProfiles[].actions.throttleProfile` 若填写，必须命中真实的 `download.throttleProfiles.<name>`；controller 会在配置加载阶段直接拒绝未知 selector。
- bootstrap 下发的 breaker profile 只包含最小字段：`hostPatterns`、`openCapSeconds`、`openThresholdPercent`、`ewmaSpan`、`consecutiveThreshold`、`protectHttpCodes`。
- controller 只下发 breaker profile 配置和 `throttleProfile` selector，不下发任何运行时 breaker 状态；运行时状态固定由数据库 `THROTTLE_PROTECTION` 维护。

Powdet 相关：`landing.powdet.algorithms` 控制可用算法（argon2id/argon2d/randomx），`captchaCombo` 可用 `verify-powdet-argon2id`/`verify-powdet-argon2d`/`verify-powdet-randomx` 指定实际启用算法。

slot-handler 相关：

- `download.fairQueue.slotHandlerAuthHeader`：download bootstrap 下发给 worker 的 slot-handler 认证请求头名；默认 `X-FQ-Auth`，启用 Fair Queue 时必须与 `slotHandler.auth.header` 保持一致。
- `slotHandler.fairQueue.minSlotHoldMs`：最小持有时间，避免刚授予就释放。
- `slotHandler.fairQueue.smoothReleaseIntervalMs`：平滑释放间隔，`null` 表示禁用。
- `slotHandler.fairQueue.graceMs`：授予后宽限窗口，用于延迟利用率计算。
- `slotHandler.fairQueue.utilWindowSec`：利用率统计窗口长度；来源：simple-alist-cf-proxy@845175d/slot-handler/main.go utilWindowSeconds()（当前实现将 >30 裁剪到 30）。
- `slotHandler.fairQueue.maxBatch`：batch tryAcquire 每批最多条目数。
- `slotHandler.fairQueue.maxProbeParallel`：每 host 并行 probe 上限。
- `slotHandler.fairQueue.maxProbeQpsPerHost`：每 host probe QPS 上限。
- `slotHandler.fairQueue.globalMaxInFlightFlow` / `hostMaxInFlightFlow` / `siteMaxInFlightFlow` / `ipBucketMaxInFlightFlow`：in-flight acquire 上限（0 表示禁用该层限制，超限返回 `overloaded`；若字段缺省，controller 下发默认值与 slot-handler 内部默认一致：global/host/site/ip=300/100/50/10）。
- `slotHandler.fairQueue.rpc.tryAcquireFunc`：默认 `fq_try_acquire_batch`，批量尝试获取 slot。
- `slotHandler.fairQueue.rpc.releaseFunc`：释放 slot 的 RPC。

行为说明（非配置字段）：`overloaded` 表示 slot-handler 拒绝/繁忙；调用方在自身超时预算内退避重试，可能由 in-flight 限制或其他保护触发。

## 决策逻辑（v0）

- `role=landing`：产出 `captchaCombo/fastRedirect/autoRedirect` 等。
- `role=download`：产出 `pathAction/checkOriginMode/throttleProfile` 等。
- 规则版本取自 `rulesVersion`，默认 TTL 为 60 秒。

## 运行

```bash
cd controller
go run ./cmd/controller
# 指定配置文件
go run ./cmd/controller -c config.yaml
```

## 测试

```bash
go test ./...
```
