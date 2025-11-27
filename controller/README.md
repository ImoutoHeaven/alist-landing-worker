# Controller (Go)

简要说明当前 controller 骨架与使用方式，便于后续 codex 接手。

- **入口**：`cmd/controller/main.go`。默认读取 `CONTROLLER_CONFIG_PATH`，未设置时使用 `config.yaml`。
- **HTTP 路由**：`/api/v0/bootstrap`、`/api/v0/decision`、`/api/v0/metrics`、`/api/v0/admin/reload`、`/api/v0/debug/decision`，均由 `AuthMiddleware` 使用 `apiToken` 保护。
- **配置**：示例位于 `config.yaml`（每个字段已标注用途、枚举/默认值/取值范围，动作与 originBinding token 与 wrangler 注释保持一致），顶层包含 `apiToken/bootstrapVersion/rulesVersion`，`envs.<env>` 下依次是 `common/landing/download/powdet/slotHandler`。staging/prod 结构一致，实际部署需按环境替换 token、上游地址等敏感字段。
- **决策逻辑**：`internal/policy/engine.go` v0 仅做 PATH 规则匹配，后续可扩展 FQ/Throttle/验证链。
- **运行**：
  - `cd alist-landing-worker/controller`
  - `CONTROLLER_CONFIG_PATH=config.yaml go run ./cmd/controller` 或 `go build ./cmd/controller`
- **测试**：`go test ./...`

## 配置修改提示

- 依据 `config.yaml` 内联注释更新各字段；staging 样例已解释每个键的含义与合法值（含 pathRules 动作枚举、originBinding token 列表、-except 语义），prod 保持同结构并替换真实值。
- `common` 覆盖 AList/签名密钥，`landing` 管理验证链与 pathRules，`download` 管理 auth/db/fairQueue/throttle/pathRules，`powdet`/`slotHandler` 部分用于被控服务。
- 变更后可通过 `POST /api/v0/admin/reload` 重新加载配置；返回的 `bootstrapVersion/rulesVersion` 应与文件保持一致，方便 Worker/slot-handler 缓存刷新。

更多细节见根目录文档：`controller-overall-plan.md`、`controller-playbook.md`、`envs-migrate-and-cleanup-tutorial.md`、`usr-requirement.txt`。
