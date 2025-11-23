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

## Build / Run

```bash
go build ./...
./powdet             # or go run main.go
```

The static files can be served from `/pow-bot-deterrent-static/` (or any path you host them at). The landing worker now references this Argon2id build.
