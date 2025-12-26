const encoder = new TextEncoder();

const sha256 = async (value) => {
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

const normalizeOptions = (options) => {
  const opts = options && typeof options === "object" ? options : {};
  const maxMs = Number(opts.maxMs);
  const yieldEveryRaw = Number(opts.yieldEvery);
  const prefix = typeof opts.prefix === "string" ? opts.prefix : "";
  return {
    maxMs: Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 0,
    yieldEvery: Number.isFinite(yieldEveryRaw) && yieldEveryRaw > 0 ? Math.floor(yieldEveryRaw) : 500,
    prefix,
    signal: opts.signal,
  };
};

export async function solvePow(bindingString, difficulty, options = {}) {
  if (typeof bindingString !== "string" || bindingString.length === 0) {
    throw new Error("bindingString required");
  }
  const target = normalizeDifficulty(difficulty);
  const opts = normalizeOptions(options);
  const base = `pow|${bindingString}|`;
  const startTime = Date.now();
  let counter = 0;

  for (;;) {
    if (opts.signal && opts.signal.aborted) {
      throw new Error("pow aborted");
    }
    const nonce = opts.prefix + counter.toString(36);
    const digest = await sha256(base + nonce);
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
}
