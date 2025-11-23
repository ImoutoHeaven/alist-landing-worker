// Argon2id proof-of-work worker powered by hash-wasm
(() => {
  try {
    importScripts("https://cdn.jsdelivr.net/npm/hash-wasm@4/dist/argon2.umd.min.js");
  } catch (err) {
    // nothing else to try
  }
})();

let working = false;
const batchSize = 8;
let hashwasmReadyPromise = null;

function ensureHashWasmReady() {
  if (!hashwasmReadyPromise) {
    hashwasmReadyPromise = (async () => {
      if (typeof hashwasm === "undefined" || typeof hashwasm.argon2id !== "function") {
        throw new Error("hashwasm.argon2id is not available");
      }
    })();
  }
  return hashwasmReadyPromise;
}

function base64ToBytes(str) {
  const raw = atob(str);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    arr[i] = raw.charCodeAt(i);
  }
  return arr;
}

function hexToBytes(hex) {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) {
    throw new Error(`invalid hex length: ${clean.length}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

function normalizeChallenge(raw) {
  return {
    memoryKiB: raw.m,
    iterations: raw.t,
    parallelism: raw.p,
    hashLength: raw.klen,
    preimageBase64: raw.i,
    difficultyHex: raw.d,
    difficultyLevel: raw.dl,
  };
}

async function argon2idHashHex(opts) {
  const { nonceHex, preimageBytes, challenge } = opts;
  const nonceBytes = hexToBytes(nonceHex);
  return hashwasm.argon2id({
    password: nonceBytes,
    salt: preimageBytes,
    parallelism: challenge.parallelism,
    iterations: challenge.iterations,
    memorySize: challenge.memoryKiB,
    hashLength: challenge.hashLength,
    outputType: "hex",
  });
}

async function runSingleBatch(ctx) {
  const { challenge, preimageBytes, challengeBase64 } = ctx;
  let attemptsThisBatch = 0;

  while (attemptsThisBatch < batchSize && working) {
    attemptsThisBatch += 1;
    ctx.i += 1;

    let nonceHex = ctx.i.toString(16);
    if ((nonceHex.length % 2) === 1) {
      nonceHex = `0${nonceHex}`;
    }

    const hashHex = await argon2idHashHex({
      nonceHex,
      preimageBytes,
      challenge,
    });

    const difficultyLen = challenge.difficultyHex.length;
    const endOfHash = hashHex.substring(hashHex.length - difficultyLen);

    if (endOfHash < ctx.smallestHash) {
      ctx.smallestHash = endOfHash;
    }

    if (endOfHash <= challenge.difficultyHex) {
      postMessage({
        type: "success",
        challenge: challengeBase64,
        nonce: nonceHex,
        smallestHash: endOfHash,
        difficulty: challenge.difficultyHex,
      });
      working = false;
      return true;
    }
  }

  postMessage({
    type: "progress",
    challenge: challengeBase64,
    attempts: attemptsThisBatch,
    smallestHash: ctx.smallestHash,
    difficulty: challenge.difficultyHex,
    probabilityOfFailurePerAttempt: ctx.probFailPerAttempt,
  });

  return false;
}

async function runBatches(ctx) {
  if (!working) {
    return;
  }

  try {
    const found = await runSingleBatch(ctx);
    if (found || !working) {
      return;
    }
    setTimeout(() => {
      runBatches(ctx);
    }, 1);
  } catch (err) {
    postMessage({
      type: "error",
      challenge: ctx.challengeBase64,
      message: `error during batch: ${err}`,
    });
  }
}

onmessage = function (e) {
  if (e.data && e.data.stop) {
    working = false;
    return;
  }

  const challengeBase64 = e.data.challenge;
  const workerId = e.data.workerId || 0;
  if (!challengeBase64) {
    postMessage({
      type: "error",
      challenge: challengeBase64,
      message: "challenge was not provided",
    });
    return;
  }

  working = true;

  let challengeJSON;
  try {
    challengeJSON = atob(challengeBase64);
  } catch (err) {
    postMessage({
      type: "error",
      challenge: challengeBase64,
      message: `couldn't decode challenge '${challengeBase64}' as base64: ${err}`,
    });
    return;
  }

  let raw;
  try {
    raw = JSON.parse(challengeJSON);
  } catch (err) {
    postMessage({
      type: "error",
      challenge: challengeBase64,
      message: `couldn't parse challenge '${challengeJSON}' as json: ${err}`,
    });
    return;
  }

  const challenge = normalizeChallenge(raw);
  const probFailPerAttempt = 1 - 1 / Math.pow(2, challenge.difficultyLevel);

  let i = workerId * Math.pow(2, challenge.difficultyLevel) * 1000;
  const preimageBytes = base64ToBytes(challenge.preimageBase64);
  let smallestHash = challenge.difficultyHex.split("").map(() => "f").join("");

  postMessage({
    type: "progress",
    challenge: challengeBase64,
    attempts: 0,
    smallestHash,
    difficulty: challenge.difficultyHex,
    probabilityOfFailurePerAttempt: probFailPerAttempt,
  });

  const ctx = {
    i,
    preimageBytes,
    smallestHash,
    probFailPerAttempt,
    challengeBase64,
    challenge,
  };

  ensureHashWasmReady()
    .then(() => runBatches(ctx))
    .catch((err) => {
      postMessage({
        type: "error",
        challenge: challengeBase64,
        message: `argon2id init failed: ${err}`,
      });
    });
};
