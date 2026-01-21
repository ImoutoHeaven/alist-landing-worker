# Pow Bot Deterrent（多算法）后端

本目录提供多算法 pow-bot-deterrent 后端及前端静态资源，用于 alist-landing-worker 的 PoW 验证（argon2id + randomx）。

## 目录内容

- `main.go`：多算法 HTTP 服务，提供 `/GetChallenges` 与 `/Verify`。
- `static/`：浏览器端资源（`pow-bot-deterrent.js`、`randomx.esm.js` 等）。
- `config.json`：运行配置与 controller 接入信息。
- `readme/`：历史资料/图片。

## 关键接口

- `POST /GetChallenges?algo=argon2id|randomx&difficultyLevel=...`  
  生成挑战批次，需要 `Authorization: Bearer <token>`。
- `POST /Verify?algo=argon2id|randomx&challenge=...&nonce=...`  
  校验并消费挑战，需要 `Authorization: Bearer <token>`。

`token` 必须是 32 位十六进制字符串，并存在于 `PoW_Bot_Deterrent_API_Tokens` 目录。

## 静态资源路径

服务内置静态资源路由：

- `/powdet/static/pow-bot-deterrent.js`
- `/powdet/static/pow-bot-deterrent.css`
- `/powdet/static/*`


## 管理与内部接口

管理员 token 使用 `adminApiToken`：

- `GET /Tokens`：列出 token 文件
- `POST /Tokens/Create?name=...`：创建 token
- `POST /Tokens/Revoke?token=...`：吊销 token

内部控制接口使用 `internal_api_token`（未配置则返回 404）：

- `GET /api/v0/health`
- `POST /api/v0/refresh`：重新加载配置并清空挑战缓存
- `POST /api/v0/flush`：先上报 metrics，再清空挑战并重载 tokens（失败返回 502）

运行前需在工作目录或可执行文件目录创建 `PoW_Bot_Deterrent_API_Tokens` 文件夹，否则服务会直接退出。

## Controller 集成与指标

`config.json` 的 `controller` 字段填写完整后：

- 启动时从 controller `/api/v0/bootstrap` 拉取 powdet 配置
- 每 60 秒向 `/api/v0/metrics` 上报 `powdet.snapshot`

配置不完整时则使用本地 `config.json`。

## 配置示例

```json
{
  "controller": {
    "url": "",
    "api_prefix": "/api/v0",
    "api_token": "",
    "env": "",
    "role": "powdet",
    "instance_id": "",
    "app_name": "powdet",
    "app_version": ""
  },
  "internal_api_token": "REPLACE_WITH_INTERNAL_TOKEN",
  "enabled": true,
  "listenPort": 2370,
  "batchSize": 1000,
  "deprecateAfterBatches": 10,
  "algorithms": {
    "argon2id": {
      "enabled": true,
      "memoryKiB": 16384,
      "iterations": 2,
      "parallelism": 1,
      "keyLength": 16
    },
    "randomx": {
      "enabled": false,
      "v2": false,
      "jit": true,
      "hardAes": true,
      "largePages": false,
      "seedLen": 32,
      "cacheLRUSize": 128,
      "cacheTTL": 600
    }
  },
  "adminApiToken": "REPLACE_WITH_ADMIN_TOKEN"
}
```

## 构建与运行

```bash
cd powdet
go build ./...
./powdet   # 或 go run main.go
```
