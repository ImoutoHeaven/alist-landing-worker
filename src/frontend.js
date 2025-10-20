const escapeHtml = (value = '') =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const pageScript = String.raw`
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const fileNameEl = $('fileName');
  const downloadBtn = $('downloadBtn');
  const retryBtn = $('retryBtn');
  const advancedToggleBtn = $('advancedToggle');
  const advancedPanel = $('advancedPanel');
  const advancedBackdrop = $('advancedBackdrop');
  const advancedCloseBtn = $('advancedCloseBtn');
  const clearCacheBtn = $('clearCacheBtn');
  const logEl = $('log');
  const turnstileContainer = $('turnstileContainer');
  const turnstileMessage = $('turnstileMessage');

  const log = (message) => {
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.textContent = '[' + time + '] ' + message;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  };

  const setStatus = (text) => {
    statusEl.textContent = text;
    log(text);
  };

  const state = {
    downloadURL: '',
    infoReady: false,
    security: {
      underAttack: false,
      siteKey: '',
      scriptLoaded: false,
      scriptLoading: null,
      widgetId: null,
      token: '',
      tokenIssuedAt: 0,
      tokenResolvers: [],
    },
  };

  const setTurnstileMessage = (text) => {
    if (!turnstileMessage) return;
    if (text) {
      turnstileMessage.textContent = text;
      turnstileMessage.hidden = false;
    } else {
      turnstileMessage.textContent = '';
      turnstileMessage.hidden = true;
    }
  };

  const showTurnstileContainer = () => {
    if (!turnstileContainer) return;
    turnstileContainer.hidden = false;
    turnstileContainer.classList.add('is-visible');
  };

  const hideTurnstileContainer = () => {
    if (!turnstileContainer) return;
    turnstileContainer.hidden = true;
    turnstileContainer.classList.remove('is-visible');
  };

  const shouldEnforceTurnstile = () => state.security.underAttack === true;

  const syncTurnstilePrompt = () => {
    if (!shouldEnforceTurnstile()) {
      hideTurnstileContainer();
      if (!state.security.token) {
        setTurnstileMessage('');
      }
      return;
    }
    showTurnstileContainer();
    if (!state.security.token) {
      setTurnstileMessage('请完成验证后继续下载');
    }
  };

  const fulfilTurnstileResolvers = (token) => {
    const resolvers = state.security.tokenResolvers.splice(0, state.security.tokenResolvers.length);
    resolvers.forEach((resolver) => {
      try {
        resolver(token);
      } catch (error) {
        console.error('Turnstile resolver failed', error);
      }
    });
  };

  const clearTurnstileToken = () => {
    state.security.token = '';
    state.security.tokenIssuedAt = 0;
  };

  const SECURITY_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

  const ensureTurnstileScript = () => {
    if (!shouldEnforceTurnstile()) return Promise.resolve();
    if (state.security.scriptLoaded) return Promise.resolve();
    if (state.security.scriptLoading) return state.security.scriptLoading;
    state.security.scriptLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SECURITY_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        state.security.scriptLoaded = true;
        state.security.scriptLoading = null;
        resolve();
      };
      script.onerror = () => {
        state.security.scriptLoading = null;
        reject(new Error('Turnstile 脚本加载失败'));
      };
      document.head.appendChild(script);
    });
    return state.security.scriptLoading;
  };

  const renderTurnstileWidget = async () => {
    if (!shouldEnforceTurnstile()) {
      hideTurnstileContainer();
      setTurnstileMessage('');
      return;
    }
    await ensureTurnstileScript();
    if (!turnstileContainer) {
      throw new Error('缺少 Turnstile 容器');
    }
    if (!window.turnstile || typeof window.turnstile.render !== 'function') {
      throw new Error('Turnstile 未初始化');
    }
    showTurnstileContainer();
    if (state.security.widgetId !== null) {
      return;
    }
    turnstileContainer.innerHTML = '';
    setTurnstileMessage('请完成验证后继续下载');
    state.security.widgetId = window.turnstile.render(turnstileContainer, {
      sitekey: state.security.siteKey,
      theme: 'dark',
      execution: 'render',
      callback: (token) => {
        state.security.token = token || '';
        state.security.tokenIssuedAt = Date.now();
        setTurnstileMessage('验证完成，可以继续操作');
        fulfilTurnstileResolvers(state.security.token);
      },
      'expired-callback': () => {
        clearTurnstileToken();
        setTurnstileMessage('验证已过期，请重新验证');
      },
      'error-callback': () => {
        clearTurnstileToken();
        setTurnstileMessage('验证失败，请重试');
        if (typeof window.turnstile.reset === 'function' && state.security.widgetId !== null) {
          try {
            window.turnstile.reset(state.security.widgetId);
          } catch (error) {
            console.warn('Turnstile reset 失败', error);
          }
        }
      },
    });
  };

  const waitForTurnstileToken = async () => {
    if (!shouldEnforceTurnstile()) return '';
    if (!state.security.siteKey) {
      throw new Error('缺少 Turnstile site key');
    }
    await renderTurnstileWidget();
    if (!state.security.token) {
      showTurnstileContainer();
      setTurnstileMessage('请完成验证后继续下载');
    }
    if (state.security.token) {
      return state.security.token;
    }
    return new Promise((resolve) => {
      state.security.tokenResolvers.push(resolve);
    });
  };

  const consumeTurnstileToken = ({ hide = false } = {}) => {
    if (!shouldEnforceTurnstile()) return;
    clearTurnstileToken();
    if (typeof window.turnstile?.reset === 'function' && state.security.widgetId !== null) {
      try {
        window.turnstile.reset(state.security.widgetId);
      } catch (error) {
        console.warn('Turnstile reset 失败', error);
      }
    }
    if (hide) {
      hideTurnstileContainer();
      setTurnstileMessage('');
    } else {
      showTurnstileContainer();
      setTurnstileMessage('请完成验证后继续下载');
    }
  };

  const securityConfig =
    typeof window !== 'undefined' && window.__ALIST_SECURITY__ && typeof window.__ALIST_SECURITY__ === 'object'
      ? window.__ALIST_SECURITY__
      : {};
  state.security.underAttack = securityConfig.underAttack === true;
  state.security.siteKey =
    typeof securityConfig.turnstileSiteKey === 'string' ? securityConfig.turnstileSiteKey.trim() : '';
  if (!state.security.siteKey) {
    state.security.underAttack = false;
  }
  if (!state.security.underAttack) {
    clearTurnstileToken();
  }
  syncTurnstilePrompt();

  const STORAGE_DB_NAME = 'alist-crypt-storage';
  const STORAGE_DB_VERSION = 2;
  const STORAGE_TABLE_INFO = 'infoCache';

  const openStorageDatabase = (() => {
    let promise = null;
    return () => {
      if (promise) return promise;
      promise = (async () => {
        if (typeof window === 'undefined' || !window.indexedDB || !window.Dexie) {
          console.warn('Dexie 或 IndexedDB 不可用，本地设置将无法保存');
          return null;
        }
        const DexieClass = window.Dexie;
        const db = new DexieClass(STORAGE_DB_NAME);
        db.version(1).stores({
          [STORAGE_TABLE_INFO]: '&key,timestamp',
        });
        db.version(STORAGE_DB_VERSION).stores({
          [STORAGE_TABLE_INFO]: '&key,timestamp',
        });
        return db;
      })();
      return promise;
    };
  })();

  const fetchInfo = async ({ forceRefresh = false } = {}) => {
    const url = new URL(window.location.href);
    const path = url.pathname;
    const sign = url.searchParams.get('sign') || '';

    if (!sign) {
      throw new Error('缺少签名参数 (sign)');
    }

    let turnstileToken = '';
    if (shouldEnforceTurnstile()) {
      turnstileToken = await waitForTurnstileToken();
    }

    const infoURL = new URL('/info', window.location.origin);
    infoURL.searchParams.set('path', path);
    infoURL.searchParams.set('sign', sign);

    const headers = new Headers();
    if (turnstileToken) {
      headers.set('cf-turnstile-response', turnstileToken);
    }

    setStatus('正在获取下载信息...');
    const response = await fetch(infoURL.toString(), {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      let errorMessage = '获取下载信息失败';
      try {
        const errorData = await response.json();
        errorMessage = errorData.message || errorMessage;
      } catch (e) {
        errorMessage = 'HTTP ' + response.status;
      }
      throw new Error(errorMessage);
    }

    const result = await response.json();
    if (result.code !== 200) {
      throw new Error(result.message || '获取下载信息失败');
    }

    const downloadURL = result.data?.download?.url;
    if (!downloadURL) {
      throw new Error('服务器未返回下载链接');
    }

    state.downloadURL = downloadURL;
    state.infoReady = true;

    if (shouldEnforceTurnstile()) {
      consumeTurnstileToken({ hide: true });
    }

    downloadBtn.disabled = false;
    downloadBtn.textContent = '跳转下载';
    retryBtn.disabled = false;
    clearCacheBtn.disabled = false;
    setStatus('就绪，点击按钮跳转下载');
  };

  const redirectToDownload = () => {
    if (!state.downloadURL) {
      setStatus('缺少下载地址，无法跳转。');
      return;
    }
    log('正在跳转至下载链接：' + state.downloadURL);
    setStatus('正在跳转下载...');
    downloadBtn.disabled = true;
    retryBtn.disabled = true;
    clearCacheBtn.disabled = true;
    try {
      window.location.href = state.downloadURL;
    } catch (error) {
      console.error('跳转下载失败', error);
      setStatus('跳转下载失败：' + (error && error.message ? error.message : '未知错误'));
      downloadBtn.disabled = false;
      downloadBtn.textContent = '跳转下载';
      retryBtn.disabled = false;
      clearCacheBtn.disabled = false;
    }
  };

  downloadBtn.addEventListener('click', () => {
    if (!state.infoReady) return;
    redirectToDownload();
  });

  retryBtn.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    downloadBtn.textContent = '加载中';
    retryBtn.disabled = true;
    clearCacheBtn.disabled = true;
    try {
      await fetchInfo({ forceRefresh: true });
    } catch (error) {
      console.error(error);
      setStatus('重新获取信息失败：' + error.message);
      downloadBtn.disabled = false;
      downloadBtn.textContent = '跳转下载';
      retryBtn.disabled = false;
      clearCacheBtn.disabled = false;
    }
  });

  clearCacheBtn.addEventListener('click', async () => {
    clearCacheBtn.disabled = true;
    downloadBtn.disabled = true;
    retryBtn.disabled = true;
    setStatus('正在清理缓存...');
    try {
      const db = await openStorageDatabase();
      if (db && db[STORAGE_TABLE_INFO]) {
        await db[STORAGE_TABLE_INFO].clear();
        log('缓存已清理');
      }
      setStatus('缓存已清理，正在重新获取信息...');
      await fetchInfo({ forceRefresh: true });
    } catch (error) {
      console.error(error);
      setStatus('清理缓存失败：' + (error && error.message ? error.message : '未知错误'));
      clearCacheBtn.disabled = false;
      downloadBtn.disabled = false;
      retryBtn.disabled = false;
    }
  });

  advancedToggleBtn.addEventListener('click', () => {
    if (advancedPanel.classList.contains('is-open')) {
      advancedPanel.classList.remove('is-open');
      advancedPanel.setAttribute('aria-hidden', 'true');
      advancedBackdrop.hidden = true;
    } else {
      advancedPanel.classList.add('is-open');
      advancedPanel.setAttribute('aria-hidden', 'false');
      advancedBackdrop.hidden = false;
    }
  });

  advancedCloseBtn.addEventListener('click', () => {
    advancedPanel.classList.remove('is-open');
    advancedPanel.setAttribute('aria-hidden', 'true');
    advancedBackdrop.hidden = true;
  });

  advancedBackdrop.addEventListener('click', () => {
    advancedPanel.classList.remove('is-open');
    advancedPanel.setAttribute('aria-hidden', 'true');
    advancedBackdrop.hidden = true;
  });

  const initialise = async () => {
    downloadBtn.disabled = true;
    downloadBtn.textContent = shouldEnforceTurnstile() ? '等待验证' : '加载中';
    retryBtn.disabled = true;
    clearCacheBtn.disabled = true;
    syncTurnstilePrompt();
    try {
      await fetchInfo({ forceRefresh: false });
    } catch (error) {
      console.error(error);
      setStatus('初始化失败：' + error.message);
      downloadBtn.disabled = false;
      downloadBtn.textContent = '跳转下载';
      retryBtn.disabled = false;
    }
  };

  initialise();
})();
`;

const renderLandingPageHtml = (path, options = {}) => {
  const normalizedOptions =
    options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const display = path && path !== '/' ? decodeURIComponent(path) : '文件下载';
  const title = escapeHtml(display);
  const script = pageScript.replace(/<\/script>/g, '<\\/script>');
  const securityConfig = {
    underAttack: normalizedOptions.underAttack === true,
    turnstileSiteKey:
      typeof normalizedOptions.turnstileSiteKey === 'string' ? normalizedOptions.turnstileSiteKey : '',
  };
  const securityJson = JSON.stringify(securityConfig).replace(/</g, '\\u003c');

  return `
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
    <title>${title}</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif;
      }
      body {
        margin: 0;
        background: #0b0b0f;
        color: #f4f4f8;
      }
      header {
        padding: 1.5rem 1.25rem 0.5rem;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      main {
        padding: 1.25rem;
        max-width: 720px;
        margin: 0 auto;
      }
      h1 {
        margin: 0 0 0.5rem;
        font-size: 1.5rem;
        word-break: break-all;
      }
      .status {
        margin-bottom: 1rem;
        font-size: 0.95rem;
        color: #9ca3af;
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin: 1.5rem 0;
      }
      .turnstile-section {
        margin: 1.5rem 0 0;
      }
      .turnstile-container {
        display: none;
        padding: 1rem;
        background: rgba(56,189,248,0.08);
        border-radius: 0.75rem;
      }
      .turnstile-container.is-visible {
        display: block;
      }
      .turnstile-message {
        margin-top: 0.75rem;
        font-size: 0.85rem;
        color: #fbbf24;
      }
      .turnstile-message[hidden] {
        display: none;
      }
      button {
        cursor: pointer;
        border: none;
        border-radius: 0.5rem;
        padding: 0.65rem 1.25rem;
        font-size: 0.95rem;
        font-weight: 600;
        background: rgba(56,189,248,0.18);
        color: #e0f2fe;
        transition: background 0.2s ease, transform 0.2s ease;
      }
      button:hover:not(:disabled) {
        background: rgba(56,189,248,0.28);
        transform: translateY(-1px);
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .controls button.secondary {
        background: rgba(148,163,184,0.16);
        color: #e2e8f0;
      }
      .controls button.secondary:hover:not(:disabled) {
        background: rgba(148,163,184,0.28);
      }
      .advanced-panel {
        position: fixed;
        top: 0;
        right: 0;
        transform: translateX(100%);
        width: 320px;
        max-width: 90vw;
        height: 100%;
        z-index: 30;
        background: rgba(15,23,42,0.95);
        border-left: 1px solid rgba(148,163,184,0.16);
        box-shadow: -16px 0 32px rgba(15,23,42,0.5);
        backdrop-filter: blur(6px);
        transition: transform 0.3s ease;
        display: flex;
        flex-direction: column;
        padding: 1.5rem 1.25rem;
      }
      .advanced-panel.is-open {
        transform: translateX(0);
      }
      .advanced-panel[aria-hidden="true"] {
        pointer-events: none;
      }
      .advanced-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(15,23,42,0.55);
        backdrop-filter: blur(2px);
        z-index: 20;
      }
      .advanced-backdrop[hidden] {
        display: none;
      }
      .advanced-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1rem;
      }
      .advanced-header h2 {
        margin: 0;
        font-size: 1.1rem;
        color: #f8fafc;
      }
      .advanced-close {
        background: transparent;
        border: none;
        color: #94a3b8;
        font-size: 0.9rem;
        padding: 0.35rem 0.75rem;
        border-radius: 999px;
        cursor: pointer;
        transition: color 0.2s ease, background 0.2s ease;
      }
      .advanced-close:hover {
        color: #f8fafc;
        background: rgba(148,163,184,0.14);
      }
      .advanced-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
        overflow-y: auto;
      }
      .advanced-actions {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .advanced-actions button {
        width: 100%;
      }
      .log {
        background: rgba(15,23,42,0.6);
        border-radius: 0.75rem;
        padding: 1rem;
        max-height: 260px;
        overflow-y: auto;
        font-size: 0.85rem;
        line-height: 1.5;
      }
      @media (max-width: 600px) {
        main {
          padding: 0.75rem;
        }
        header {
          padding: 1rem 0.75rem 0.5rem;
        }
        .controls {
          flex-direction: column;
        }
        button {
          width: 100%;
        }
        .advanced-panel {
          width: 100%;
          padding: 1.25rem;
        }
      }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/dexie@3.2.4/dist/dexie.min.js" crossorigin="anonymous"></script>
  </head>
  <body>
    <header>
      <h1 id="fileName">${title}</h1>
      <div class="status" id="status">准备就绪</div>
    </header>
    <main>
      <section class="turnstile-section" id="turnstileSection">
        <div id="turnstileContainer" class="turnstile-container" hidden></div>
        <div id="turnstileMessage" class="turnstile-message" hidden></div>
      </section>
      <div class="controls">
        <button id="downloadBtn" disabled>加载中</button>
        <button id="retryBtn" disabled>重试</button>
        <button id="advancedToggle" class="secondary" type="button">高级选项</button>
      </div>
      <aside id="advancedPanel" class="advanced-panel" aria-hidden="true">
        <div class="advanced-header">
          <h2>高级选项</h2>
          <button id="advancedCloseBtn" type="button" class="advanced-close">关闭</button>
        </div>
        <div class="advanced-body">
          <div class="advanced-actions">
            <button id="clearCacheBtn" disabled>清理缓存</button>
          </div>
        </div>
      </aside>
      <div id="advancedBackdrop" class="advanced-backdrop" hidden></div>
      <section>
        <div class="status">事件日志</div>
        <div class="log" id="log"></div>
      </section>
    </main>
    <script>
      window.__ALIST_SECURITY__ = ${securityJson};
    </script>
    <script type="module">
      ${script}
    </script>
  </body>
</html>`;
};

export const renderLandingPage = (path, options = {}) => {
  const normalizedOptions =
    options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const html = renderLandingPageHtml(path, normalizedOptions);
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=UTF-8',
      'cache-control': 'no-store',
    },
  });
};
