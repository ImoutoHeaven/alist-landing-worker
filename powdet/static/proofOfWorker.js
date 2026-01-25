// Argon2id/argon2d proof-of-work worker powered by hash-wasm
(() => {
  try {
    importScripts("https://cdn.jsdelivr.net/npm/hash-wasm@4/dist/argon2.umd.min.js");
  } catch (err) {
    // nothing else to try
  }
})();

const POWDET_ALGO_ARGON2ID = "argon2id";
const POWDET_ALGO_ARGON2D = "argon2d";

let working = false;
const batchSize = 8;
const hashwasmReadyPromises = {};

function ensureHashWasmReady(alg) {
  const normalizedAlg = typeof alg === "string" ? alg.toLowerCase() : POWDET_ALGO_ARGON2ID;
  const key = normalizedAlg === POWDET_ALGO_ARGON2D ? POWDET_ALGO_ARGON2D : POWDET_ALGO_ARGON2ID;
  if (!hashwasmReadyPromises[key]) {
    hashwasmReadyPromises[key] = (async () => {
      const fnName = key === POWDET_ALGO_ARGON2D ? "argon2d" : "argon2id";
      if (typeof hashwasm === "undefined" || typeof hashwasm[fnName] !== "function") {
        throw new Error(`hashwasm.${fnName} is not available`);
      }
    })();
  }
  return hashwasmReadyPromises[key];
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
  const alg = typeof raw.alg === "string" ? raw.alg.toLowerCase() : POWDET_ALGO_ARGON2ID;
  return {
    alg,
    memoryKiB: raw.m,
    iterations: raw.t,
    parallelism: raw.p,
    hashLength: raw.klen,
    preimageBase64: raw.i,
    difficultyHex: raw.d,
    difficultyLevel: raw.dl,
  };
}

function getArgon2Hasher(alg) {
  if (alg === POWDET_ALGO_ARGON2D) {
    return hashwasm.argon2d;
  }
  return hashwasm.argon2id;
}

async function argon2HashHex(opts) {
  const { nonceHex, preimageBytes, challenge } = opts;
  const nonceBytes = hexToBytes(nonceHex);
  const hasher = getArgon2Hasher(challenge.alg);
  return hasher({
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

    const hashHex = await argon2HashHex({
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

  ensureHashWasmReady(challenge.alg)
    .then(() => runBatches(ctx))
    .catch((err) => {
      postMessage({
        type: "error",
        challenge: challengeBase64,
        message: `${challenge.alg || "argon2"} init failed: ${err}`,
      });
    });
};
