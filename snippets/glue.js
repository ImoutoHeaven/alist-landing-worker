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
    ":root{--bg-1:#0f2027;--bg-2:#203a43;--bg-3:#2c5364;--card-bg:rgba(255,255,255,0.03);--card-border:rgba(255,255,255,0.08);--text:#fff;--sub:#a0a0a0;--accent:#00d2ff;--success:#25ae88;--error:#d75a4a;--mono:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;}",
    "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;position:fixed;top:0;left:0;right:0;bottom:0;}",
    "body{background:linear-gradient(-45deg,var(--bg-1),var(--bg-2),var(--bg-3),#1a1a2e);background-size:400% 400%;animation:gradientBG 15s ease infinite;color:var(--text);font-family:var(--sans);display:flex;justify-content:center;align-items:center;-webkit-font-smoothing:antialiased;}",
    "@keyframes gradientBG{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}",
    ".card{background:var(--card-bg);backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);padding:48px;border-radius:32px;box-shadow:0 30px 60px rgba(0,0,0,0.5),inset 0 0 0 1px var(--card-border);max-width:380px;width:90%;text-align:center;animation:pow-in 0.8s cubic-bezier(0.2,0.8,0.2,1) both;}",
    "h1{margin:0 0 24px;font-size:24px;font-weight:600;letter-spacing:-0.01em;text-shadow:0 2px 10px rgba(0,0,0,0.3);color:var(--text);}",
    ".spinner-wrap{margin:40px auto;height:56px;width:56px;position:relative;}",
    ".spinner{width:100%;height:100%;border:3px solid rgba(255,255,255,0.05);border-top-color:var(--accent);border-radius:50%;animation:s 1s linear infinite;box-sizing:border-box;}",
    "@keyframes s{100%{transform:rotate(360deg);}}",
    "@keyframes pow-in{0%{opacity:0;transform:scale(0.92) translateY(20px)}100%{opacity:1;transform:none}}",
    "#log{font-family:var(--mono);font-size:12px;margin-top:32px;text-align:left;background:rgba(0,0,0,0.2);padding:16px 20px;border-radius:16px;height:90px;overflow:hidden;position:relative;border:1px solid rgba(255,255,255,0.05);color:var(--sub);box-shadow:inset 0 2px 6px rgba(0,0,0,0.1);}",
    ".log-line{transition:opacity 0.4s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.8;letter-spacing:-0.01em;}",
    ".icon{width:64px;height:64px;margin:36px auto;display:none;}",
    ".icon svg{width:100%;height:100%;display:block;filter:drop-shadow(0 0 10px rgba(37,174,136,0.4));}",
    ".c-path{stroke-dasharray:60;stroke-dashoffset:60;animation:draw 0.6s 0.1s cubic-bezier(0.65,0,0.45,1) forwards;}",
    ".c-circ{stroke-dasharray:160;stroke-dashoffset:160;animation:draw 0.8s cubic-bezier(0.65,0,0.45,1) forwards;}",
    "@keyframes draw{to{stroke-dashoffset:0;}}"
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
      '<svg viewBox="0 0 52 52" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><circle class="c-circ" cx="26" cy="26" r="24" stroke-opacity="0.2"/><path class="c-path" d="M14.1 27.2l7.1 7.2 16.7-16.8"/></svg>';
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
    let attemptCount = 0;
    const spinTimer = setInterval(() => {
      let msg = "Computing hash chain...";
      if (attemptCount > 0) {
        msg = "Screening hash (attempt " + attemptCount + ")...";
      }
      update(spinIndex, msg + " " + spinChars[spinFrame++ % spinChars.length]);
    }, 120);
    const commit = await computePoswCommit(binding, steps, {
      hashcashBits,
      segmentLen,
      onStatus: (type, val) => {
        if (type === "retry") attemptCount = val;
      },
    });
    clearInterval(spinTimer);
    update(spinIndex, (attemptCount > 0 ? "Screening hash... done" : "Computing hash chain... done"));
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
    let round = 0;
    while (state && state.done !== true) {
      round++;
      if (!Array.isArray(state.indices) || state.indices.length === 0) {
        throw new Error("Challenge Failed");
      }
      log("Verifying #" + round + " (" + state.indices.length + ")...");
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
