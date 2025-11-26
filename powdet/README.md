# Pow Bot Deterrent (Argon2id) for alist-landing-worker

This folder hosts the Argon2id version of the pow-bot-deterrent backend and its worker assets, co-located with `alist-landing-worker` for easier deployment.

## Contents

- `main.go` – Argon2id HTTP service exposing `/GetChallenges` and `/Verify`.
- `static/` – Browser assets (`pow-bot-deterrent.js`, workers, and `hash-wasm-argon2.umd.min.js`).
- `config.json` – Sample configuration (see below).
- `proofOfWorkerStub.js` – Source for the worker build (already baked into `static/proofOfWorker*.js`).
- `readme/` – Legacy diagrams/media kept for reference.

Removed legacy scrypt build artifacts (`scrypt.wasm`, `wasm_build/`, docker build scripts) because the worker now uses hash-wasm Argon2id.

## Configure

See `config.json` for defaults:

```json
{
  "listen_port": 2370,
  "batch_size": 1000,
  "deprecate_after_batches": 10,
  "argon2_memory_kib": 16384,
  "argon2_iterations": 2,
  "argon2_parallelism": 1,
  "admin_api_token": "REPLACE_WITH_ADMIN_TOKEN"
}
```

Environment variable prefixes remain `POW_BOT_DETERRENT_*` (e.g., `POW_BOT_DETERRENT_ARGON2_MEMORY_KIB`).

### Controller integration & control API

- If `CONTROLLER_URL`, `CONTROLLER_API_TOKEN`, and `ENV` are set (optionally `ROLE`/`INSTANCE_ID`/`APP_*`), the service fetches config from controller `/api/v0/bootstrap` with `role=powdet`. Incomplete controller settings will fail fast instead of falling back.
- Without controller settings, config still comes from `config.json` + `POW_BOT_DETERRENT_*` env overrides.
- Metrics: when controller is configured, a snapshot is sent every 60s to controller `/api/v0/metrics` (challenge batch/verify counters, challenge cache size, token count, configVersion). `/api/v0/flush` also pushes a snapshot first and returns 502 if the push fails.
- Internal control endpoints (protected by `Authorization: Bearer $INTERNAL_API_TOKEN`, unmatched → 404):
  - `GET /api/v0/health` → 204 with `X-App-*`/`X-Config-Version`.
  - `POST /api/v0/refresh` → reload config (controller or local), reload API tokens, clear cached challenges.
  - `POST /api/v0/flush` → push metrics snapshot → clear cached challenges → reload API tokens.

## Build / Run

```bash
go build ./...
./powdet             # or go run main.go
```

The static files can be served from `/pow-bot-deterrent-static/` (or any path you host them at). The landing worker now references this Argon2id build.
