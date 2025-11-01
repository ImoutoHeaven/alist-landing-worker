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

  /**
   * Base64url 编码（URL 安全 base64）
   * @param {string} str
   * @returns {string}
   */
  function base64urlEncode(str) {
    const base64 = btoa(str);
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

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
  const autoRedirectEnabled = window.__AUTO_REDIRECT__ === true;

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

  const createLinkSnippet = (url) => {
    const snippet = document.createElement('div');
    snippet.className = 'log-link-snippet';
    snippet.title = '点击复制链接';

    const label = document.createElement('div');
    label.className = 'log-link-snippet-label';
    label.textContent = '下载链接（点击复制）';

    const urlText = document.createElement('div');
    urlText.className = 'log-link-snippet-url';
    urlText.textContent = url;

    snippet.appendChild(label);
    snippet.appendChild(urlText);

    snippet.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        const originalText = label.textContent;
        label.textContent = '✓ 已复制到剪贴板';
        setTimeout(() => {
          label.textContent = originalText;
        }, 1500);
      } catch (error) {
        console.error('复制失败', error);
        label.textContent = '复制失败，请手动复制';
        setTimeout(() => {
          label.textContent = '下载链接（点击复制）';
        }, 2000);
      }
    });

    return snippet;
  };

  const copyToClipboard = async (text, button) => {
    if (!text || !button) return;
    try {
      await navigator.clipboard.writeText(text);
      const originalText = button.textContent;
      button.textContent = '已复制✓';
      setTimeout(() => {
        button.textContent = originalText;
      }, 1500);
    } catch (error) {
      console.error('复制失败', error);
      const originalText = button.textContent;
      button.textContent = '复制失败';
      setTimeout(() => {
        button.textContent = originalText;
      }, 2000);
    }
  };

  const state = {
    downloadURL: '',
    infoReady: false,
    downloadBtnMode: 'download', // 'download' or 'copy'
    awaitingRetryUnlock: false,
    security: {
      underAttack: false,
      siteKey: '',
      turnstileAction: 'download',
      altchaChallenge: null,
      turnstileBinding: null,
      scriptLoaded: false,
      scriptLoading: null,
      widgetId: null,
    },
    verification: {
      needAltcha: false,
      needTurnstile: false,
      altchaReady: false,
      turnstileReady: false,
      altchaSolution: null,
      turnstileToken: null,
      altchaIssuedAt: 0,
      turnstileIssuedAt: 0,
      tokenResolvers: [],
    },
  };

  const updateButtonState = () => {
    if (!downloadBtn) return;
    if (state.infoReady) {
      return;
    }
    if (shouldEnforceTurnstile()) {
      const { valid, reason } = getTurnstileBindingStatus();
      if (!valid) {
        downloadBtn.disabled = true;
        downloadBtn.textContent = reason === 'expired' ? '验证已过期' : '验证不可用';
        return;
      }
    }
    const {
      needAltcha,
      needTurnstile,
      altchaReady,
      turnstileReady,
    } = state.verification;
    const canCallInfo = (!needAltcha || altchaReady) && (!needTurnstile || turnstileReady);
    if (canCallInfo) {
      downloadBtn.disabled = false;
      downloadBtn.textContent = '开始下载';
    } else {
      downloadBtn.disabled = true;
      downloadBtn.textContent = '身份验证中';
    }
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

  const shouldEnforceTurnstile = () => state.verification.needTurnstile === true;

  const getTurnstileBindingStatus = () => {
    const binding = state.security.turnstileBinding;
    if (!shouldEnforceTurnstile()) {
      return { valid: true, binding: null, reason: null };
    }
    if (!binding || typeof binding !== 'object') {
      return { valid: false, binding: null, reason: 'missing' };
    }
    const expiresAt = Number.isFinite(binding.bindingExpiresAt)
      ? binding.bindingExpiresAt
      : Number.parseInt(binding.bindingExpiresAt, 10);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      return { valid: false, binding, reason: 'invalid' };
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (expiresAt <= nowSeconds) {
      return { valid: false, binding, reason: 'expired' };
    }
    const nonce = typeof binding.nonce === 'string' ? binding.nonce.replace(/=+$/u, '') : '';
    const cdata = typeof binding.cdata === 'string' ? binding.cdata.replace(/=+$/u, '') : '';
    if (!nonce || !cdata) {
      return { valid: false, binding, reason: 'invalid' };
    }
    return {
      valid: true,
      binding: { ...binding, bindingExpiresAt: expiresAt, nonce, cdata },
      reason: null,
    };
  };

  const ensureTurnstileBinding = () => {
    const status = getTurnstileBindingStatus();
    if (status.valid && status.binding) {
      return status.binding;
    }
    if (!status.valid) {
      if (status.reason === 'expired') {
        throw new Error('Turnstile 绑定已过期，请刷新页面后重试');
      }
      throw new Error('缺少 Turnstile 绑定信息，请刷新页面后重试');
    }
    return null;
  };

  const syncTurnstilePrompt = () => {
    if (!shouldEnforceTurnstile()) {
      hideTurnstileContainer();
      if (!state.verification.turnstileToken) {
        setTurnstileMessage('');
      }
      return;
    }
    showTurnstileContainer();
    const status = getTurnstileBindingStatus();
    if (!status.valid) {
      if (status.reason === 'expired') {
        setTurnstileMessage('验证已过期，请刷新页面');
      } else {
        setTurnstileMessage('验证信息缺失，请刷新页面');
      }
      return;
    }
    if (!state.verification.turnstileToken) {
      setTurnstileMessage('请完成验证后继续下载');
    }
  };

  const fulfilTurnstileResolvers = (token) => {
    const resolvers = state.verification.tokenResolvers.splice(0, state.verification.tokenResolvers.length);
    resolvers.forEach((resolver) => {
      try {
        resolver(token);
      } catch (error) {
        console.error('Turnstile resolver failed', error);
      }
    });
  };

  const clearTurnstileToken = () => {
    state.verification.turnstileToken = null;
    state.verification.turnstileIssuedAt = 0;
    state.verification.turnstileReady = false;
    updateButtonState();
  };

  const SECURITY_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  const ALTCHA_MODULE_URL = 'https://cdn.jsdelivr.net/npm/altcha-lib@1.3.0/+esm';

  let altchaModulePromise = null;
  const loadAltchaModule = () => {
    if (!altchaModulePromise) {
      altchaModulePromise = import(ALTCHA_MODULE_URL);
    }
    return altchaModulePromise;
  };

  let altchaComputationPromise = null;
  const startAltchaComputation = () => {
    if (!state.verification.needAltcha) {
      state.verification.altchaReady = true;
      state.verification.altchaSolution = null;
      updateButtonState();
      return Promise.resolve(null);
    }
    if (state.verification.altchaReady && state.verification.altchaSolution) {
      return Promise.resolve(state.verification.altchaSolution);
    }
    if (altchaComputationPromise) {
      return altchaComputationPromise;
    }
    const challenge = state.security.altchaChallenge;
    if (!challenge) {
      state.verification.altchaReady = false;
      updateButtonState();
      return Promise.reject(new Error('缺少 ALTCHA 挑战'));
    }
    if (
      typeof challenge.binding !== 'string' ||
      challenge.binding.length === 0 ||
      typeof challenge.pathHash !== 'string' ||
      challenge.pathHash.length === 0 ||
      !Number.isFinite(challenge.bindingExpiresAt)
    ) {
      state.verification.altchaReady = false;
      updateButtonState();
      return Promise.reject(new Error('ALTCHA 挑战缺少绑定信息'));
    }

    const computePromise = (async () => {
      try {
        setStatus('正在进行身份验证（PoW 计算）...');
        const module = await loadAltchaModule();
        const { solveChallenge } = module || {};
        if (typeof solveChallenge !== 'function') {
          throw new Error('ALTCHA 求解函数不可用');
        }
        const { promise } = solveChallenge(
          challenge.challenge,
          challenge.salt,
          challenge.algorithm,
          challenge.maxnumber
        );
        const solutionResult = await promise;
        if (!solutionResult || typeof solutionResult.number !== 'number') {
          throw new Error('ALTCHA PoW 计算未返回有效结果');
        }
        const solution = {
          algorithm: challenge.algorithm,
          challenge: challenge.challenge,
          number: solutionResult.number,
          salt: challenge.salt,
          signature: challenge.signature,
          pathHash: challenge.pathHash,
          ipHash: typeof challenge.ipHash === 'string' ? challenge.ipHash : '',
          binding: challenge.binding,
          bindingExpiresAt: challenge.bindingExpiresAt,
        };
        state.verification.altchaSolution = solution;
        state.verification.altchaIssuedAt = Date.now();
        state.verification.altchaReady = true;
        updateButtonState();
        return solution;
      } catch (error) {
        state.verification.altchaSolution = null;
        state.verification.altchaIssuedAt = 0;
        state.verification.altchaReady = false;
        updateButtonState();
        throw error;
      } finally {
        altchaComputationPromise = null;
      }
    })();

    altchaComputationPromise = computePromise;
    return computePromise;
  };

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
    const bindingStatus = getTurnstileBindingStatus();
    if (!bindingStatus.valid) {
      if (bindingStatus.reason === 'expired') {
        setTurnstileMessage('验证已过期，请刷新页面');
      } else {
        setTurnstileMessage('验证信息缺失，请刷新页面');
      }
      return;
    }
    const activeBinding = bindingStatus.binding;
    turnstileContainer.innerHTML = '';
    setTurnstileMessage('请完成验证后继续下载');
    state.security.widgetId = window.turnstile.render(turnstileContainer, {
      sitekey: state.security.siteKey,
      theme: 'dark',
      execution: 'render',
      action: state.security.turnstileAction || 'download',
      cData: activeBinding.cdata,
      callback: (token) => {
        state.verification.turnstileToken = token || '';
        state.verification.turnstileIssuedAt = Date.now();
        state.verification.turnstileReady = true;
        hideTurnstileContainer();
        setTurnstileMessage('');
        fulfilTurnstileResolvers(state.verification.turnstileToken);
        updateButtonState();
        if (state.awaitingRetryUnlock) {
          state.awaitingRetryUnlock = false;
          retryBtn.disabled = false;
        }
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
    if (!state.verification.turnstileToken) {
      showTurnstileContainer();
      setTurnstileMessage('请完成验证后继续下载');
    }
    if (state.verification.turnstileToken) {
      return state.verification.turnstileToken;
    }
    return new Promise((resolve) => {
      state.verification.tokenResolvers.push(resolve);
    });
  };

  const consumeTurnstileToken = () => {
    if (!shouldEnforceTurnstile()) return;
    clearTurnstileToken();
    if (typeof window.turnstile?.reset === 'function' && state.security.widgetId !== null) {
      try {
        window.turnstile.reset(state.security.widgetId);
      } catch (error) {
        console.warn('Turnstile reset 失败', error);
      }
    }
  };

  const applySecurityConfig = (security = {}) => {
    state.security.underAttack = security.underAttack === true;
    state.security.siteKey =
      typeof security.turnstileSiteKey === 'string' ? security.turnstileSiteKey.trim() : '';
    state.security.turnstileAction =
      typeof security.turnstileAction === 'string' && security.turnstileAction.trim().length > 0
        ? security.turnstileAction.trim()
        : 'download';
    state.security.altchaChallenge =
      security.altchaChallenge && typeof security.altchaChallenge === 'object'
        ? security.altchaChallenge
        : null;
    const rawTurnstileBinding =
      security.turnstileBinding && typeof security.turnstileBinding === 'object'
        ? security.turnstileBinding
        : null;
    if (rawTurnstileBinding) {
      const bindingExpiresAt =
        typeof rawTurnstileBinding.bindingExpiresAt === 'number'
          ? rawTurnstileBinding.bindingExpiresAt
          : typeof rawTurnstileBinding.bindingExpiresAt === 'string'
            ? Number.parseInt(rawTurnstileBinding.bindingExpiresAt, 10)
            : typeof rawTurnstileBinding.expiresAt === 'number'
              ? rawTurnstileBinding.expiresAt
              : typeof rawTurnstileBinding.expiresAt === 'string'
                ? Number.parseInt(rawTurnstileBinding.expiresAt, 10)
                : 0;
      const bindingValue =
        typeof rawTurnstileBinding.binding === 'string'
          ? rawTurnstileBinding.binding
          : typeof rawTurnstileBinding.bindingMac === 'string'
            ? rawTurnstileBinding.bindingMac
            : '';
      const pathHash =
        typeof rawTurnstileBinding.pathHash === 'string' ? rawTurnstileBinding.pathHash : '';
      const ipHash =
        typeof rawTurnstileBinding.ipHash === 'string' ? rawTurnstileBinding.ipHash : '';
      const nonce =
        typeof rawTurnstileBinding.nonce === 'string'
          ? rawTurnstileBinding.nonce.replace(/=+$/u, '')
          : '';
      const cdata =
        typeof rawTurnstileBinding.cdata === 'string'
          ? rawTurnstileBinding.cdata.replace(/=+$/u, '')
          : '';
      if (bindingValue && bindingExpiresAt > 0 && pathHash && nonce && cdata) {
        state.security.turnstileBinding = {
          pathHash,
          ipHash,
          binding: bindingValue,
          bindingExpiresAt,
          nonce,
          cdata,
        };
      } else {
        state.security.turnstileBinding = null;
      }
    } else {
      state.security.turnstileBinding = null;
    }
    state.verification.needAltcha = !!state.security.altchaChallenge;
    state.verification.needTurnstile =
      state.security.underAttack && typeof state.security.siteKey === 'string' && state.security.siteKey.length > 0;
    if (!state.verification.needTurnstile) {
      state.security.underAttack = false;
    }
    state.verification.altchaSolution = null;
    state.verification.altchaIssuedAt = 0;
    state.verification.altchaReady = !state.verification.needAltcha;
    state.verification.turnstileToken = null;
    state.verification.turnstileIssuedAt = 0;
    state.verification.turnstileReady = !state.verification.needTurnstile;
    state.verification.tokenResolvers = [];
    syncTurnstilePrompt();
    updateButtonState();
    if (state.verification.needAltcha) {
      startAltchaComputation().catch((error) => {
        console.error('ALTCHA 初始化失败:', error && error.message ? error.message : error);
      });
    }
  };

  const securityConfig =
    typeof window !== 'undefined' && window.__ALIST_SECURITY__ && typeof window.__ALIST_SECURITY__ === 'object'
      ? window.__ALIST_SECURITY__
      : {};
  applySecurityConfig(securityConfig);

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

  const handleInfoError = (error, context) => {
    const rawMessage =
      (error && typeof error.message === 'string' && error.message) || String(error || '未知错误');
    const normalizedMessage = rawMessage.toLowerCase();
    if (normalizedMessage.includes('altcha')) {
      state.verification.altchaSolution = null;
      state.verification.altchaIssuedAt = 0;
      state.verification.altchaReady = false;
      if (state.verification.needAltcha) {
        startAltchaComputation().catch((altchaError) => {
          console.error('ALTCHA 重新计算失败:', altchaError && altchaError.message ? altchaError.message : altchaError);
        });
      }
    }
    const needsWidgetRefresh =
      normalizedMessage.includes('429') ||
      normalizedMessage.includes('461') ||
      normalizedMessage.includes('462') ||
      normalizedMessage.includes('463') ||
      normalizedMessage.includes('binding') ||
      normalizedMessage.includes('rate limit') ||
      normalizedMessage.includes('turnstile');

    const enforceTurnstile = shouldEnforceTurnstile();
    const requiresTurnstileReset = needsWidgetRefresh && enforceTurnstile;
    state.awaitingRetryUnlock = false;
    if (requiresTurnstileReset) {
      consumeTurnstileToken();
      syncTurnstilePrompt();
      state.awaitingRetryUnlock = true;
    }

    let errorPrefix = '';
    if (context === 'init') {
      errorPrefix = '初始化失败：';
    } else if (context === 'retry') {
      errorPrefix = '重新获取信息失败：';
    } else if (context === 'clearCache') {
      errorPrefix = '缓存已清理，但重新获取信息失败：';
    }
    setStatus(errorPrefix + rawMessage);

    if (normalizedMessage.includes('binding')) {
      state.security.turnstileBinding = null;
      syncTurnstilePrompt();
    }

    state.downloadBtnMode = 'download';
    state.infoReady = false;
    downloadBtn.textContent = requiresTurnstileReset ? '等待验证' : '获取失败';
    downloadBtn.disabled = true;

    retryBtn.disabled = requiresTurnstileReset;
    clearCacheBtn.disabled = false;
    if (normalizedMessage.includes('binding')) {
      downloadBtn.textContent = '验证已过期';
      retryBtn.disabled = true;
      state.awaitingRetryUnlock = true;
    }
  };

  const fetchInfo = async ({ forceRefresh = false } = {}) => {
    const url = new URL(window.location.href);
    const path = url.pathname;
    const sign = url.searchParams.get('sign') || '';

    if (!sign) {
      throw new Error('缺少签名参数 (sign)');
    }

    state.infoReady = false;
    updateButtonState();

    const altchaPromise = state.verification.needAltcha
      ? startAltchaComputation()
      : Promise.resolve(null);

    let turnstileBindingEncoded = '';
    let turnstileBindingExpiresAt = 0;
    if (shouldEnforceTurnstile()) {
      const binding = ensureTurnstileBinding();
      if (binding) {
        turnstileBindingExpiresAt = Number(binding.bindingExpiresAt) || 0;
        const sanitizedNonce = typeof binding.nonce === 'string' ? binding.nonce.replace(/=+$/u, '') : '';
        const sanitizedCData = typeof binding.cdata === 'string' ? binding.cdata.replace(/=+$/u, '') : '';
        const payload = {
          pathHash: binding.pathHash,
          ipHash: binding.ipHash,
          binding: binding.binding || '',
          bindingExpiresAt: binding.bindingExpiresAt,
          nonce: sanitizedNonce,
          cdata: sanitizedCData,
        };
        turnstileBindingEncoded = base64urlEncode(JSON.stringify(payload));
      }
    }

    let turnstileToken = '';
    if (shouldEnforceTurnstile()) {
      turnstileToken = await waitForTurnstileToken();
      if (turnstileBindingExpiresAt > 0) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (nowSeconds >= turnstileBindingExpiresAt) {
          throw new Error('Turnstile 绑定已过期，请刷新页面后重试');
        }
      }
    }

    let altchaSolution = null;
    if (state.verification.needAltcha) {
      try {
        const solution = await altchaPromise;
        if (!solution || typeof solution !== 'object') {
          throw new Error('ALTCHA PoW 计算未返回有效结果');
        }
        altchaSolution = solution;
      } catch (error) {
        throw new Error('ALTCHA PoW 计算失败：' + (error && error.message ? error.message : String(error || '未知错误')));
      }
    }

    const infoURL = new URL('/info', window.location.origin);
    infoURL.searchParams.set('path', path);
    infoURL.searchParams.set('sign', sign);
    if (altchaSolution) {
      const solutionJson = JSON.stringify(altchaSolution);
      const base64urlToken = base64urlEncode(solutionJson);
      infoURL.searchParams.set('altChallengeResult', base64urlToken);
    }

    const headers = new Headers();
    if (turnstileToken) {
      headers.set('cf-turnstile-response', turnstileToken);
    }
    if (turnstileBindingEncoded) {
      headers.set('x-turnstile-binding', turnstileBindingEncoded);
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

    // Update page title to filename after verification
    try {
      const pathSegments = path.split('/').filter(Boolean);
      if (pathSegments.length > 0) {
        const fileName = decodeURIComponent(pathSegments[pathSegments.length - 1]);
        document.title = fileName;
      }
    } catch (e) {
      // Ignore title update errors
    }

    if (shouldEnforceTurnstile()) {
      consumeTurnstileToken();
    }
    if (state.verification.needAltcha) {
      state.verification.altchaReady = false;
      state.verification.altchaSolution = null;
      state.verification.altchaIssuedAt = 0;
    }

    downloadBtn.disabled = false;
    downloadBtn.textContent = '跳转下载';
    state.downloadBtnMode = 'download';
    retryBtn.disabled = false;
    clearCacheBtn.disabled = false;
    if (autoRedirectEnabled) {
      redirectToDownload();
      return;
    }
    setStatus('就绪，点击按钮跳转下载');
  };

  const retryDownload = async () => {
    try {
      const response = await fetch(window.location.href);
      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const scriptNodes = Array.from(doc.querySelectorAll('script'));
      let newSecurityConfig = null;
      for (const node of scriptNodes) {
        const content = node.textContent || '';
        const match = content.match(/window\.__ALIST_SECURITY__\s*=\s*({.*?});/s);
        if (match && match[1]) {
          try {
            newSecurityConfig = JSON.parse(match[1]);
          } catch (parseError) {
            console.warn('解析新的安全配置失败', parseError);
          }
          break;
        }
      }
      if (newSecurityConfig) {
        window.__ALIST_SECURITY__ = newSecurityConfig;
        applySecurityConfig(newSecurityConfig);
        if (state.verification.needTurnstile && window.turnstile && typeof window.turnstile.reset === 'function' && state.security.widgetId !== null) {
          try {
            window.turnstile.reset(state.security.widgetId);
          } catch (resetError) {
            console.warn('Turnstile reset 失败', resetError);
          }
        }
      }
      state.infoReady = false;
      state.downloadURL = '';
      state.downloadBtnMode = 'download';
      updateButtonState();
      await fetchInfo({ forceRefresh: true });
    } catch (error) {
      console.error('Retry failed:', error);
      const rawMessage =
        (error && typeof error.message === 'string' && error.message) || String(error || '未知错误');
      log('重试失败：' + rawMessage);
      throw error;
    }
  };

  const redirectToDownload = () => {
    if (!state.downloadURL) {
      setStatus('缺少下载地址，无法跳转。');
      return;
    }

    // Add clickable link snippet to log
    const snippet = createLinkSnippet(state.downloadURL);
    logEl.appendChild(snippet);
    logEl.scrollTop = logEl.scrollHeight;

    setStatus('正在跳转下载...');
    retryBtn.disabled = true;
    clearCacheBtn.disabled = true;
    try {
      window.location.href = state.downloadURL;
      // Change button to copy mode after redirect attempt
      state.downloadBtnMode = 'copy';
      downloadBtn.textContent = '复制链接';
    } catch (error) {
      console.error('跳转下载失败', error);
      setStatus('跳转下载失败：' + (error && error.message ? error.message : '未知错误'));
      state.downloadBtnMode = 'download';
      downloadBtn.disabled = false;
      downloadBtn.textContent = '跳转下载';
      retryBtn.disabled = false;
      clearCacheBtn.disabled = false;
    }
  };

  downloadBtn.addEventListener('click', () => {
    if (!state.infoReady) return;

    if (state.downloadBtnMode === 'copy') {
      // Copy mode: copy the download URL to clipboard
      copyToClipboard(state.downloadURL, downloadBtn);
    } else {
      // Download mode: redirect to download
      redirectToDownload();
    }
  });

  retryBtn.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    downloadBtn.textContent = '身份验证中';
    retryBtn.disabled = true;
    clearCacheBtn.disabled = true;
    try {
      await retryDownload();
    } catch (error) {
      console.error(error);
      handleInfoError(error, 'retry');
    }
  });

  clearCacheBtn.addEventListener('click', async () => {
    clearCacheBtn.disabled = true;
    downloadBtn.disabled = true;
    retryBtn.disabled = true;
    setStatus('正在清理缓存...');
    state.infoReady = false;
    updateButtonState();
    let fetchAttempted = false;
    try {
      const db = await openStorageDatabase();
      if (db && db[STORAGE_TABLE_INFO]) {
        await db[STORAGE_TABLE_INFO].clear();
        log('缓存已清理');
      }
      setStatus('缓存已清理，正在重新获取信息...');
      fetchAttempted = true;
      await fetchInfo({ forceRefresh: true });
    } catch (error) {
      console.error(error);
      if (fetchAttempted) {
        handleInfoError(error, 'clearCache');
      } else {
        const rawMessage =
          (error && typeof error.message === 'string' && error.message) || String(error || '未知错误');
        setStatus('清理缓存失败：' + rawMessage);
        state.downloadBtnMode = 'download';
        downloadBtn.textContent = '跳转下载';
        downloadBtn.disabled = false;
        retryBtn.disabled = false;
        clearCacheBtn.disabled = false;
      }
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
    state.infoReady = false;
    updateButtonState();
    retryBtn.disabled = true;
    clearCacheBtn.disabled = true;
    syncTurnstilePrompt();
    try {
      await fetchInfo({ forceRefresh: false });
    } catch (error) {
      console.error(error);
      handleInfoError(error, 'init');
    }
  };

  initialise();
})();
`;

const renderLandingPageHtml = (path, options = {}) => {
  const normalizedOptions =
    options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  // Extract filename from path (last segment after /)
  let display = '文件下载';
  if (path && path !== '/') {
    try {
      const decodedPath = decodeURIComponent(path);
      const segments = decodedPath.split('/').filter(Boolean);
      display = segments.length > 0 ? segments[segments.length - 1] : '文件下载';
    } catch (error) {
      display = '文件下载';
    }
  }
  const title = escapeHtml(display);
  const script = pageScript.replace(/<\/script>/g, '<\\/script>');
  const rawAltchaChallenge =
    normalizedOptions.altchaChallenge && typeof normalizedOptions.altchaChallenge === 'object'
      ? normalizedOptions.altchaChallenge
      : null;
  const normalizedAltchaChallenge = rawAltchaChallenge
    ? {
        algorithm: rawAltchaChallenge.algorithm,
        challenge: rawAltchaChallenge.challenge,
        salt: rawAltchaChallenge.salt,
        signature: rawAltchaChallenge.signature,
        maxnumber: rawAltchaChallenge.maxnumber,
        pathHash:
          typeof rawAltchaChallenge.pathHash === 'string' ? rawAltchaChallenge.pathHash : '',
        ipHash: typeof rawAltchaChallenge.ipHash === 'string' ? rawAltchaChallenge.ipHash : '',
        binding: typeof rawAltchaChallenge.binding === 'string' ? rawAltchaChallenge.binding : '',
        bindingExpiresAt:
          typeof rawAltchaChallenge.bindingExpiresAt === 'number'
            ? rawAltchaChallenge.bindingExpiresAt
            : typeof rawAltchaChallenge.bindingExpiresAt === 'string'
            ? Number.parseInt(rawAltchaChallenge.bindingExpiresAt, 10)
            : 0,
      }
    : null;
  const rawTurnstileBinding =
    normalizedOptions.turnstileBinding && typeof normalizedOptions.turnstileBinding === 'object'
      ? normalizedOptions.turnstileBinding
      : null;
  const normalizedTurnstileBinding = rawTurnstileBinding
    ? {
        pathHash:
          typeof rawTurnstileBinding.pathHash === 'string' ? rawTurnstileBinding.pathHash : '',
        ipHash: typeof rawTurnstileBinding.ipHash === 'string' ? rawTurnstileBinding.ipHash : '',
        binding:
          typeof rawTurnstileBinding.binding === 'string'
            ? rawTurnstileBinding.binding
            : typeof rawTurnstileBinding.bindingMac === 'string'
            ? rawTurnstileBinding.bindingMac
            : '',
        bindingExpiresAt:
          typeof rawTurnstileBinding.bindingExpiresAt === 'number'
            ? rawTurnstileBinding.bindingExpiresAt
            : typeof rawTurnstileBinding.bindingExpiresAt === 'string'
            ? Number.parseInt(rawTurnstileBinding.bindingExpiresAt, 10)
            : typeof rawTurnstileBinding.expiresAt === 'number'
            ? rawTurnstileBinding.expiresAt
            : typeof rawTurnstileBinding.expiresAt === 'string'
            ? Number.parseInt(rawTurnstileBinding.expiresAt, 10)
            : 0,
        nonce:
          typeof rawTurnstileBinding.nonce === 'string' ? rawTurnstileBinding.nonce : '',
        cdata:
          typeof rawTurnstileBinding.cdata === 'string' ? rawTurnstileBinding.cdata : '',
      }
    : null;
  const turnstileAction =
    typeof normalizedOptions.turnstileAction === 'string' && normalizedOptions.turnstileAction.trim().length > 0
      ? normalizedOptions.turnstileAction.trim()
      : 'download';
  const securityConfig = {
    underAttack: normalizedOptions.underAttack === true,
    turnstileSiteKey:
      typeof normalizedOptions.turnstileSiteKey === 'string' ? normalizedOptions.turnstileSiteKey : '',
    turnstileAction,
    altchaChallenge: normalizedAltchaChallenge,
    turnstileBinding: normalizedTurnstileBinding,
  };
  const securityJson = JSON.stringify(securityConfig).replace(/</g, '\\u003c');
  const autoRedirectEnabled = normalizedOptions.autoRedirect === true;
  const autoRedirectLiteral = autoRedirectEnabled ? 'true' : 'false';

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
        white-space: nowrap;
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
      .log-link-snippet {
        background: rgba(56,189,248,0.12);
        border: 1px solid rgba(56,189,248,0.3);
        border-radius: 0.5rem;
        padding: 0.75rem;
        margin: 0.5rem 0;
        cursor: pointer;
        transition: all 0.2s ease;
        word-break: break-all;
        display: inline-block;
        width: calc(100% - 6rem);
      }
      .log-link-snippet:hover {
        background: rgba(56,189,248,0.18);
        border-color: rgba(56,189,248,0.5);
        transform: translateY(-1px);
      }
      .log-link-snippet-label {
        font-size: 0.75rem;
        color: #9ca3af;
        margin-bottom: 0.35rem;
        font-weight: 600;
      }
      .log-link-snippet-url {
        color: #38bdf8;
        font-family: monospace;
        font-size: 0.8rem;
        line-height: 1.4;
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
      window.__AUTO_REDIRECT__ = ${autoRedirectLiteral};
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
