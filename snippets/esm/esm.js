const encoder = new TextEncoder();

const HASH_WASM_ESM_URL =
  "https://cdn.jsdelivr.net/npm/hash-wasm@4.9.0/dist/index.esm.min.js";
const HASH_WASM_UMD_URL =
  "https://cdn.jsdelivr.net/npm/hash-wasm@4.9.0/dist/index.umd.min.js";

const sha256Async = async (value) => {
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
};

const leadingZeroBits = (bytes) => {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    for (let bit = 7; bit >= 0; bit--) {
      if (byte & (1 << bit)) {
        return count + (7 - bit);
      }
    }
  }
  return count;
};

const normalizeDifficulty = (difficulty) => {
  const value = Number(difficulty);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.floor(value));
};

const getDefaultConcurrency = () => {
  const raw =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? Number(navigator.hardwareConcurrency)
      : 1;
  if (!Number.isFinite(raw) || raw <= 1) return 1;
  return Math.max(1, Math.min(4, Math.floor(raw)));
};

const normalizeOptions = (options) => {
  const opts = options && typeof options === "object" ? options : {};
  const maxMs = Number(opts.maxMs);
  const yieldEveryRaw = Number(opts.yieldEvery);
  const prefix = typeof opts.prefix === "string" ? opts.prefix : "";
  const concurrencyRaw = Number(opts.concurrency);
  const concurrency = Number.isFinite(concurrencyRaw)
    ? Math.max(1, Math.floor(concurrencyRaw))
    : getDefaultConcurrency();
  const hashWasmUrl =
    typeof opts.hashWasmUrl === "string" && opts.hashWasmUrl
      ? opts.hashWasmUrl
      : HASH_WASM_ESM_URL;
  const hashWasmWorkerUrl =
    typeof opts.hashWasmWorkerUrl === "string" && opts.hashWasmWorkerUrl
      ? opts.hashWasmWorkerUrl
      : HASH_WASM_UMD_URL;
  const useWasm = opts.useWasm !== false;
  const useWorkers = opts.useWorkers !== false;
  return {
    maxMs: Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 0,
    yieldEvery: Number.isFinite(yieldEveryRaw) && yieldEveryRaw > 0 ? Math.floor(yieldEveryRaw) : 500,
    prefix,
    signal: opts.signal,
    concurrency,
    hashWasmUrl,
    hashWasmWorkerUrl,
    useWasm,
    useWorkers,
  };
};

const supportsWorkers = () =>
  typeof Worker === "function" && typeof Blob === "function" && typeof URL !== "undefined";

const hashWasmCache = new Map();
const loadHashWasm = (url) => {
  const key = url || HASH_WASM_ESM_URL;
  if (hashWasmCache.has(key)) return hashWasmCache.get(key);
  const promise = (async () => {
    if (!key) return null;
    try {
      const mod = await import(key);
      const createSHA256 =
        (mod && mod.createSHA256) ||
        (mod && mod.default && mod.default.createSHA256);
      if (typeof createSHA256 !== "function") {
        return null;
      }
      return createSHA256;
    } catch {
      return null;
    }
  })();
  hashWasmCache.set(key, promise);
  return promise;
};

const createWasmHasher = async (opts) => {
  if (!opts.useWasm) return null;
  const createSHA256 = await loadHashWasm(opts.hashWasmUrl);
  if (typeof createSHA256 !== "function") return null;
  const hasher = await createSHA256();
  if (!hasher || typeof hasher.init !== "function") return null;
  return hasher;
};

let workerScriptUrl = null;
const getWorkerScriptUrl = (hashWasmWorkerUrl) => {
  if (workerScriptUrl) return workerScriptUrl;
  const script = `
const encoder = new TextEncoder();
const HASH_WASM_URL = ${JSON.stringify(HASH_WASM_UMD_URL)};
let wasmHasherPromise = null;
const loadHashWasm = async (url) => {
  const target = typeof url === "string" && url ? url : HASH_WASM_URL;
  if (!target) return null;
  if (!wasmHasherPromise) {
    wasmHasherPromise = (async () => {
      try {
        importScripts(target);
        if (!self.hashwasm || typeof self.hashwasm.createSHA256 !== "function") {
          return null;
        }
        return await self.hashwasm.createSHA256();
      } catch {
        return null;
      }
    })();
  }
  return wasmHasherPromise;
};
const leadingZeroBits = (bytes) => {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    for (let bit = 7; bit >= 0; bit--) {
      if (byte & (1 << bit)) {
        return count + (7 - bit);
      }
    }
  }
  return count;
};
const sha256Async = async (value) => {
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
};
self.onmessage = async (event) => {
  const data = event.data || {};
  const base = String(data.base || "");
  const baseBytes = encoder.encode(base);
  const difficulty = Math.max(1, Math.floor(Number(data.difficulty) || 1));
  const start = Math.max(0, Math.floor(Number(data.start) || 0));
  const step = Math.max(1, Math.floor(Number(data.step) || 1));
  const prefix = typeof data.prefix === "string" ? data.prefix : "";
  const maxMs = Number(data.maxMs) || 0;
  const useWasm = data.useWasm !== false;
  const wasmUrl = typeof data.hashWasmWorkerUrl === "string" ? data.hashWasmWorkerUrl : "";
  const hasher = useWasm ? await loadHashWasm(wasmUrl) : null;
  const startTime = Date.now();
  let counter = start;
  if (hasher && typeof hasher.init === "function") {
    for (;;) {
      if (maxMs && Date.now() - startTime > maxMs) {
        self.postMessage({ timeout: true });
        return;
      }
      const nonce = prefix + counter.toString(36);
      const nonceBytes = encoder.encode(nonce);
      hasher.init();
      hasher.update(baseBytes);
      hasher.update(nonceBytes);
      const digest = hasher.digest("binary");
      if (leadingZeroBits(digest) >= difficulty) {
        self.postMessage({ nonce });
        return;
      }
      counter += step;
    }
  }
  for (;;) {
    if (maxMs && Date.now() - startTime > maxMs) {
      self.postMessage({ timeout: true });
      return;
    }
    const nonce = prefix + counter.toString(36);
    const digest = await sha256Async(base + nonce);
    if (leadingZeroBits(digest) >= difficulty) {
      self.postMessage({ nonce });
      return;
    }
    counter += step;
  }
};
`;
  const blob = new Blob([script], { type: "text/javascript" });
  workerScriptUrl = URL.createObjectURL(blob);
  return workerScriptUrl;
};

const solvePowSingleSync = async (baseBytes, target, opts, hasher) => {
  const startTime = Date.now();
  let counter = 0;
  for (;;) {
    if (opts.signal && opts.signal.aborted) {
      throw new Error("pow aborted");
    }
    const nonce = opts.prefix + counter.toString(36);
    const nonceBytes = encoder.encode(nonce);
    hasher.init();
    hasher.update(baseBytes);
    hasher.update(nonceBytes);
    const digest = hasher.digest("binary");
    if (leadingZeroBits(digest) >= target) {
      return nonce;
    }
    counter += 1;
    if (counter % opts.yieldEvery === 0) {
      if (opts.maxMs && Date.now() - startTime > opts.maxMs) {
        throw new Error("pow timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
};

const solvePowSingleAsync = async (base, target, opts) => {
  const startTime = Date.now();
  let counter = 0;
  for (;;) {
    if (opts.signal && opts.signal.aborted) {
      throw new Error("pow aborted");
    }
    const nonce = opts.prefix + counter.toString(36);
    const digest = await sha256Async(base + nonce);
    if (leadingZeroBits(digest) >= target) {
      return nonce;
    }
    counter += 1;
    if (counter % opts.yieldEvery === 0) {
      if (opts.maxMs && Date.now() - startTime > opts.maxMs) {
        throw new Error("pow timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
};

const solvePowWorkers = (base, target, opts) => {
  const concurrency = Math.max(1, Math.min(8, opts.concurrency));
  if (!opts.useWorkers || concurrency <= 1 || !supportsWorkers()) {
    return null;
  }
  return new Promise((resolve, reject) => {
    const workers = [];
    let settled = false;
    let completed = 0;
    const maxMs = opts.maxMs || 0;
    const startTime = Date.now();

    const cleanup = (nonce, error) => {
      if (settled) return;
      settled = true;
      workers.forEach((worker) => {
        try {
          worker.terminate();
        } catch {
          // ignore
        }
      });
      if (error) {
        reject(error);
      } else {
        resolve(nonce || null);
      }
    };

    const handleDone = (nonce) => {
      if (nonce) {
        cleanup(nonce);
        return;
      }
      completed += 1;
      if (completed >= concurrency) {
        cleanup(null);
      }
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        cleanup(null, new Error("pow aborted"));
        return;
      }
      opts.signal.addEventListener(
        "abort",
        () => {
          cleanup(null, new Error("pow aborted"));
        },
        { once: true }
      );
    }

    const workerUrl = getWorkerScriptUrl(opts.hashWasmWorkerUrl);
    for (let i = 0; i < concurrency; i++) {
      let worker = null;
      try {
        worker = new Worker(workerUrl);
      } catch (error) {
        cleanup(null, error);
        return;
      }
      worker.onmessage = (event) => {
        const data = event.data || {};
        if (data && data.nonce) {
          handleDone(String(data.nonce));
        } else {
          handleDone(null);
        }
      };
      worker.onerror = () => {
        handleDone(null);
      };
      worker.postMessage({
        base,
        difficulty: target,
        start: i,
        step: concurrency,
        prefix: opts.prefix,
        maxMs,
        useWasm: opts.useWasm,
        hashWasmWorkerUrl: opts.hashWasmWorkerUrl,
      });
      workers.push(worker);
    }

    if (maxMs) {
      const timeout = Math.max(1, maxMs - (Date.now() - startTime));
      setTimeout(() => {
        if (!settled) {
          cleanup(null, new Error("pow timeout"));
        }
      }, timeout);
    }
  });
};

export async function solvePow(bindingString, difficulty, options = {}) {
  if (typeof bindingString !== "string" || bindingString.length === 0) {
    throw new Error("bindingString required");
  }
  const target = normalizeDifficulty(difficulty);
  const opts = normalizeOptions(options);
  const base = `pow|${bindingString}|`;
  const workerResult = await solvePowWorkers(base, target, opts);
  if (workerResult) {
    return workerResult;
  }
  const hasher = await createWasmHasher(opts);
  if (hasher) {
    const baseBytes = encoder.encode(base);
    return solvePowSingleSync(baseBytes, target, opts, hasher);
  }
  return solvePowSingleAsync(base, target, opts);
}
