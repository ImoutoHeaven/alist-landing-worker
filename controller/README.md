# Controller (Go)

简要说明当前 controller 骨架与使用方式，便于后续 codex 接手。

- **入口**：`cmd/controller/main.go`。默认读取 `CONTROLLER_CONFIG_PATH`，未设置时使用 `config.yaml`。
- **HTTP 路由**：`/api/v0/bootstrap`、`/api/v0/decision`、`/api/v0/metrics`、`/api/v0/admin/reload`、`/api/v0/debug/decision`，均由 `AuthMiddleware` 使用 `apiToken` 保护。
- **配置**：示例位于 `config.yaml`，覆盖 `common/landing/download`，含 pathRules、fairQueue、throttleProfiles、originBindingDefault 等。实际部署需替换 token、上游地址等敏感字段。
- **决策逻辑**：`internal/policy/engine.go` v0 仅做 PATH 规则匹配，后续可扩展 FQ/Throttle/验证链。
- **运行**：
  - `cd alist-landing-worker/controller`
  - `CONTROLLER_CONFIG_PATH=config.yaml go run ./cmd/controller` 或 `go build ./cmd/controller`
- **测试**：`go test ./...`

更多细节见根目录文档：`controller-overall-plan.md`、`controller-playbook.md`、`envs-migrate-and-cleanup-tutorial.md`、`usr-requirement.txt`。
