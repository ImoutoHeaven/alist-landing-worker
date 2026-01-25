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

路径规则以 `paths.*` 为准（`paths.global`、`paths.pathProfiles`、`paths.pathRules`）。
`landing.pathRules` 与 `download.pathRules` 仍保留在结构里，但当前决策只读取 `paths.*`，避免混用。

Powdet 相关：`landing.powdet.algorithms` 控制可用算法（argon2id/argon2d/randomx），`captchaCombo` 可用 `verify-powdet-argon2id`/`verify-powdet-argon2d`/`verify-powdet-randomx` 指定实际启用算法。

## 决策逻辑（v0）

- `role=landing`：产出 `captchaCombo/fastRedirect/autoRedirect` 等。
- `role=download`：产出 `pathAction/checkOriginMode/fairQueueProfile/throttleProfile` 等。
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
