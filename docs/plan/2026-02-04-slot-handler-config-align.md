# Slot-Handler Config Alignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 对齐 controller 配置与模板，匹配 slot-handler 新架构字段，删除废弃字段并补充注释。

**Architecture:** 以 controller 配置层为中心，先改 schema/默认值，再同步 config.yaml/README，最后修正 metrics 测试样例。

**Tech Stack:** Go（controller 配置与测试）、YAML（config.yaml）、Markdown（README）

---

### Task 1: 更新 slot-handler 配置 schema 与默认值

**Files:**
- Modify: `controller/internal/config/config.go`
- Modify: `controller/internal/config/config_yaml_alignment_test.go`

**Step 1: 写失败测试（新增字段断言）**

在 `controller/internal/config/config_yaml_alignment_test.go` 增加对 slot-handler 新 fairQueue 字段的断言（例如 `GraceMs/UtilWindowSec/MaxBatch/MaxProbeParallel/MaxProbeQpsPerHost`），并移除对废弃字段的期望。

**Step 2: 运行测试确认失败**

Run: `go test ./...`
Expected: 编译失败（旧结构无新字段）或断言失败。

**Step 3: 更新配置结构与默认值**

在 `controller/internal/config/config.go`：
- 删除废弃字段：`QueueWaitTimeoutMs`、`GlobalMaxWaiters`、`SessionIdleSeconds`、`MaxWaitMs`、`MaxWaiters*`、`WeightedScheduler`、`ThrottleCheckFunc/RegisterWaiterFunc/ReleaseWaiterFunc`、`QueueDepthZombieTtlSeconds`、`DefaultGrantedCleanupDelay`。
- 添加新字段：`GraceMs`、`UtilWindowSec`、`MaxBatch`、`MaxProbeParallel`、`MaxProbeQpsPerHost`。
- 更新默认常量与 `ensureDefaults()` 逻辑，RPC 默认值改为 `fq_try_acquire_batch`/`fq_release_dual`。

**Step 4: 运行测试确认通过**

Run: `go test ./...`
Expected: PASS。

**Step 5: Commit（用户要求时执行）**

```bash
git add controller/internal/config/config.go controller/internal/config/config_yaml_alignment_test.go
git commit -m "chore: align slot-handler config schema"
```

---

### Task 2: 对齐 config.yaml 与 README 模板说明

**Files:**
- Modify: `controller/config.yaml`
- Modify: `controller/README.md`

**Step 1: 更新模板字段与注释**

在 `controller/config.yaml`：
- 移除废弃字段（同 Task 1 列表）。
- 新增 `graceMs/utilWindowSec/maxBatch/maxProbeParallel/maxProbeQpsPerHost` 并补充注释。
- 更新 `rpc` 仅保留 `tryAcquireFunc/releaseFunc`，默认 `fq_try_acquire_batch`。
- 移除 `queueWaitTimeoutMs`，保留并解释 `slotHandlerTimeoutMs` 作为总等待上限。

在 `controller/README.md`：
- 更新 slot-handler 配置描述为新字段集合，强调 batch RPC。

**Step 2: 运行测试确认通过**

Run: `go test ./...`
Expected: PASS。

**Step 3: Commit（用户要求时执行）**

```bash
git add controller/config.yaml controller/README.md
git commit -m "docs: update slot-handler config template"
```

---

### Task 3: 更新 slot-handler 指标样例（sessions -> flows）

**Files:**
- Modify: `controller/internal/http/handlers_test.go`

**Step 1: 更新测试样例字段**

将测试 payload 中的 `sessions` 改为 `flows`，并断言 `flows.total/inflight/detached/grace`。

**Step 2: 运行测试确认通过**

Run: `go test ./...`
Expected: PASS。

**Step 3: Commit（用户要求时执行）**

```bash
git add controller/internal/http/handlers_test.go
git commit -m "test: align slot-handler metrics payload"
```
