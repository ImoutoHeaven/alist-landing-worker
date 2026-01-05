const decodeB64Url = (str) => {
  try {
    let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
};

const normalizeApiPrefix = (prefix) => {
  if (!prefix || typeof prefix !== "string") return "/__pow";
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
};

const postJson = async (url, body, retries = 3) => {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      if (res.status === 403) throw new Error("403");
      if (!res.ok) {
        if (res.status >= 500 && i < retries) throw new Error("retry");
        throw new Error("Request Failed");
      }
      try {
        return await res.json();
      } catch {
        return {};
      }
    } catch (err) {
      if (err && err.message === "403") throw err;
      if (i === retries) throw err;
      const delay = 500 * Math.pow(2, i);
      log("Connection error. Retrying in " + delay + "ms...");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return {};
};

const initUi = () => {
  const style = document.createElement("style");
  style.textContent = [
    ":root{--bg:#050505;--card-bg:rgba(28,28,28,0.6);--text:#fff;--sub:#888;--accent:#3291ff;--success:#25ae88;--error:#d75a4a;--mono:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;}",
    "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;position:fixed;top:0;left:0;right:0;bottom:0;}",
    "body{background:radial-gradient(circle at 50% 10%,#1f1f1f,#000);color:var(--text);font-family:var(--sans);display:flex;justify-content:center;align-items:center;box-sizing:border-box;padding:20px;-webkit-font-smoothing:antialiased;}",
    ".card{background:var(--card-bg);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);padding:40px;border-radius:24px;box-shadow:0 24px 48px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.08);max-width:360px;width:100%;text-align:center;border:1px solid rgba(255,255,255,0.04);animation:pow-in .6s cubic-bezier(0.16,1,0.3,1) both;}",
    "h1{margin:0 0 24px;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:var(--text);}",
    ".spinner-wrap{margin:32px auto;height:48px;width:48px;position:relative;}",
    ".spinner{width:100%;height:100%;border:3px solid rgba(255,255,255,0.1);border-left-color:var(--accent);border-radius:50%;animation:s .8s linear infinite;box-sizing:border-box;}",
    "@keyframes s{100%{transform:rotate(360deg);}}",
    "@keyframes pow-in{0%{opacity:0;transform:scale(0.96) translateY(12px)}100%{opacity:1;transform:none}}",
    "#log{font-family:var(--mono);font-size:11px;margin-top:32px;text-align:left;background:rgba(0,0,0,0.4);padding:16px;border-radius:12px;height:84px;overflow:hidden;position:relative;border:1px solid rgba(255,255,255,0.03);color:var(--sub);box-shadow:inset 0 2px 6px rgba(0,0,0,0.2);}",
    ".log-line{transition:opacity 0.3s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.6;letter-spacing:-0.01em;}",
    ".icon{width:56px;height:56px;margin:28px auto;display:none;}",
    ".icon svg{width:100%;height:100%;display:block;}"
  ].join("");
  (document.head || document.documentElement).appendChild(style);
  const body = document.body;
  body.innerHTML =
    '<div class="card">' +
    '<h1 id="t">Verifying...</h1>' +
    '<div id="s" class="spinner-wrap"><div class="spinner"></div></div>' +
    '<div id="i" class="icon"></div>' +
    '<div id="log"></div>' +
    "</div>";
  return {
    logEl: document.getElementById("log"),
    tEl: document.getElementById("t"),
    sEl: document.getElementById("s"),
    iEl: document.getElementById("i"),
  };
};

const ui = initUi();
const lines = [];
const MAX_VISIBLE_LINES = 4;
document.title = "Verifying...";

const render = () => {
  const total = lines.length;
  const start = Math.max(0, total - MAX_VISIBLE_LINES);
  const visible = lines.slice(start);
  ui.logEl.innerHTML = visible
    .map((msg, idx) => {
      const position = idx;
      const opacity =
        position === visible.length - 1 ? 1 :
        position === visible.length - 2 ? 0.7 :
        position === visible.length - 3 ? 0.45 :
        0.25;
      return (
        '<div class="log-line" style="opacity:' +
        opacity +
        ";color:rgba(238,238,238," +
        opacity +
        ')">' +
        msg +
        "</div>"
      );
    })
    .join("");
};

const log = (msg) => {
  lines.push(msg);
  render();
  return lines.length - 1;
};

const update = (idx, msg) => {
  if (idx < 0 || idx >= lines.length) return;
  lines[idx] = msg;
  render();
};

const setStatus = (ok) => {
  ui.sEl.style.display = "none";
  ui.iEl.style.display = "block";
  if (ok) {
    ui.tEl.textContent = "Redirecting...";
    ui.iEl.style.color = "var(--success)";
    ui.iEl.innerHTML =
      '<svg viewBox="0 0 52 52" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><circle cx="26" cy="26" r="24" stroke-opacity="0.2"/><path d="M14.1 27.2l7.1 7.2 16.7-16.8"/></svg>';
  } else {
    ui.tEl.textContent = "Failed!";
    ui.iEl.style.color = "var(--error)";
    ui.iEl.innerHTML =
      '<svg viewBox="0 0 52 52" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><circle cx="26" cy="26" r="24" stroke-opacity="0.2"/><path d="M16 16 36 36 M36 16 16 36"/></svg>';
  }
};

log("Initializing...");

export default async function runPow(
  bindingB64,
  steps,
  ticketB64,
  pathHash,
  hashcashBits,
  segmentLen,
  reloadUrlB64,
  apiPrefixB64,
  esmUrlB64
) {
  try {
    log("Loading solver...");
    const esmUrl = decodeB64Url(String(esmUrlB64 || ""));
    const module = await import(esmUrl);
    const computePoswCommit = module.computePoswCommit;
    if (typeof computePoswCommit !== "function") {
      throw new Error("Solver Missing");
    }
    const binding = decodeB64Url(String(bindingB64 || ""));
    const spinIndex = log("Computing hash chain...");
    const spinChars = "|/-\\\\";
    let spinFrame = 0;
    const spinTimer = setInterval(() => {
      update(spinIndex, "Computing hash chain... " + spinChars[spinFrame++ % spinChars.length]);
    }, 120);
    const commit = await computePoswCommit(binding, steps, {
      hashcashBits,
      segmentLen,
    });
    clearInterval(spinTimer);
    update(spinIndex, "Computing hash chain... done");
    const apiPrefix = normalizeApiPrefix(decodeB64Url(String(apiPrefixB64 || "")));
    log("Submitting commit...");
    await postJson(apiPrefix + "/commit", {
      ticketB64,
      rootB64: commit.rootB64,
      pathHash,
      nonce: commit.nonce,
    });
    log("Requesting challenge...");
    let state = await postJson(apiPrefix + "/challenge", {});
    if (
      !state ||
      !Array.isArray(state.indices) ||
      typeof state.sid !== "string" ||
      typeof state.cursor !== "number" ||
      typeof state.token !== "string"
    ) {
      throw new Error("Challenge Failed");
    }
    while (state && state.done !== true) {
      if (!Array.isArray(state.indices) || state.indices.length === 0) {
        throw new Error("Challenge Failed");
      }
      log("Opening proofs (" + state.indices.length + ")...");
      const indices = state.indices;
      const segs =
        Array.isArray(state.segs) && state.segs.length === indices.length
          ? state.segs
          : null;
      const spinePos = Array.isArray(state.spinePos) ? state.spinePos : null;
      if (!segs || !spinePos) {
        throw new Error("Challenge Failed");
      }
      const segLens = segs.map((v) => Number(v));
      const opens = await commit.open(indices, { segLens, spinePos });
      state = await postJson(apiPrefix + "/open", {
        sid: state.sid,
        cursor: state.cursor,
        token: state.token,
        spinePos,
        opens,
      });
      if (state && state.done === true) break;
      if (
        !state ||
        !Array.isArray(state.indices) ||
        typeof state.sid !== "string" ||
        typeof state.cursor !== "number" ||
        typeof state.token !== "string"
      ) {
        throw new Error("Challenge Failed");
      }
    }
    log("Access granted. Redirecting...");
    setStatus(true);
    document.title = "Redirecting";
    const target = decodeB64Url(String(reloadUrlB64 || ""));
    window.location.replace(target);
  } catch (e) {
    if (e && e.message === "403") {
      log("Session expired. Reloading...");
      setTimeout(() => window.location.reload(), 1000);
      return;
    }
    log("ERROR: " + (e && e.message ? e.message : String(e)));
    setStatus(false);
  }
}
