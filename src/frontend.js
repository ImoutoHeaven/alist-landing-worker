import { htmlTemplate } from './templates/landing.html.js';
import { cssStyles } from './templates/landing.css.js';

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
  const clearEnvBtn = $('clearEnvBtn');
  const retryFailedSegmentsBtn = $('retryFailedSegmentsBtn');
  const cancelBtn = $('cancelBtn');
  const connectionLimitInput = $('connectionLimitInput');
  const retryLimitInput = $('retryLimitInput');
  const parallelLimitInput = $('parallelLimitInput');
  const downloadBar = $('downloadBar');
  const decryptBar = $('decryptBar');
  const downloadText = $('downloadText');
  const decryptText = $('decryptText');
  const speedText = $('speedText');
  const keygenPasswordInput = $('keygenPassword');
  const keygenSaltInput = $('keygenSalt');
  const keygenRunBtn = $('keygenRun');
  const keygenCopyBtn = $('keygenCopy');
  const keygenStatusEl = $('keygenStatus');
  const keygenOutputEl = $('keygenOutput');
  const logEl = $('log');
  const turnstileContainer = $('turnstileContainer');
  const turnstileMessage = $('turnstileMessage');
  const autoRedirectEnabled = window.__AUTO_REDIRECT__ === true;
  const webDownloaderProps = window.__WEB_DOWNLOADER_PROPS__ || {};

  const log = (message) => {
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.textContent = '[' + time + '] ' + message;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  };

  let autoRedirectWebNoticeShown = false;
  const notifyAutoRedirectForWeb = () => {
    if (!autoRedirectEnabled || autoRedirectWebNoticeShown) {
      return;
    }
    autoRedirectWebNoticeShown = true;
    // No need to log, status already shows "准备就绪"
  };

  const setStatus = (text) => {
    statusEl.textContent = text;
    log(text);
  };

  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
    return value.toFixed(digits) + ' ' + units[unitIndex];
  };

  const clamp = (value, min, max, fallback) => {
    if (!Number.isFinite(value)) return fallback;
    if (value < min) return min;
    if (value > max) return max;
    return value;
  };

  const base64ToUint8 = (value) => {
    if (!value) return new Uint8Array(0);
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  };

  const bytesToHex = (bytes) =>
    Array.from(bytes || [])
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  if (connectionLimitInput && !connectionLimitInput.value) {
    const defaultConnections = clamp(Number(webDownloaderProps?.config?.maxConnections) || 4, 1, 16, 4);
    connectionLimitInput.value = String(defaultConnections);
  }
  if (retryLimitInput && !retryLimitInput.value) {
    retryLimitInput.value = '10';
  }
  if (parallelLimitInput && !parallelLimitInput.value) {
    parallelLimitInput.value = '6';
  }

  /**
   * Set button text with optional spinner
   * @param {HTMLElement} button - The button element
   * @param {string} text - Button text
   * @param {boolean} loading - Whether to show spinner
   */
  const setButtonText = (button, text, loading = false) => {
    if (!button) return;

    // Clear existing content
    button.innerHTML = '';

    if (loading) {
      // Create spinner element
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      button.appendChild(spinner);
    }

    // Add text
    const textNode = document.createTextNode(text);
    button.appendChild(textNode);
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

  let scryptModulePromise = null;
  const ensureScryptModule = () => {
    if (!scryptModulePromise) {
      scryptModulePromise = import('https://cdn.jsdelivr.net/npm/scrypt-js@3.0.1/+esm');
    }
    return scryptModulePromise;
  };
  const textEncoder = new TextEncoder();
  const defaultKeygenSalt = new Uint8Array([
    0xa8, 0x0d, 0xf4, 0x3a, 0x8f, 0xbd, 0x03, 0x08,
    0xa7, 0xca, 0xb8, 0x3e, 0x58, 0x1f, 0x86, 0xb1,
  ]);

  const state = {
    downloadURL: '',
    infoReady: false,
    downloadBtnMode: 'download', // 'download' or 'copy'
    awaitingRetryUnlock: false,
    mode: 'legacy',
    webTask: null,
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

  const webDownloader = (() => {
    const SEGMENT_SIZE_BYTES = 32 * 1024 * 1024;
    const MIN_CONNECTIONS = 1;
    const MAX_CONNECTIONS = 16;
    const DEFAULT_CONNECTIONS = clamp(
      Number(webDownloaderProps?.config?.maxConnections) || 4,
      MIN_CONNECTIONS,
      MAX_CONNECTIONS,
      4
    );
    const DEFAULT_RETRY_LIMIT = 5;
    const NONCE_SIZE = 24;
    const SPEED_WINDOW = 1500;

    const sleep = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, ms));
      });

    const cloneUint8 = (input) => {
      if (!input) return new Uint8Array(0);
      return input.slice ? input.slice() : new Uint8Array(input);
    };

    const incrementNonce = (baseNonce, increment) => {
      const output = cloneUint8(baseNonce);
      let carry = BigInt(increment);
      let index = 0;
      while (carry > 0n && index < output.length) {
        const sum = BigInt(output[index]) + (carry & 0xffn);
        output[index] = Number(sum & 0xffn);
        carry = (carry >> 8n) + (sum >> 8n);
        index += 1;
      }
      return output;
    };

    const decryptBlock = (cipherBlock, dataKey, baseNonce, blockIndex) => {
      const nonce = incrementNonce(baseNonce, blockIndex);
      const opened = window.nacl?.secretbox?.open(cipherBlock, nonce, dataKey);
      if (!opened) return null;
      return new Uint8Array(opened);
    };

    const calculateUnderlying = (offset, limit, meta) => {
      const fallbackLimit = limit >= 0 ? limit : -1;
      if (
        !meta ||
        meta.encryption === 'plain' ||
        !Number.isFinite(meta.blockDataSize) ||
        meta.blockDataSize <= 0 ||
        !Number.isFinite(meta.blockHeaderSize) ||
        meta.blockHeaderSize <= 0 ||
        !Number.isFinite(meta.fileHeaderSize) ||
        meta.fileHeaderSize <= 0
      ) {
        return {
          underlyingOffset: offset,
          underlyingLimit: fallbackLimit,
          discard: 0,
          blocks: 0,
        };
      }

      const blockData = meta.blockDataSize;
      const blockHeader = meta.blockHeaderSize;
      const headerSize = meta.fileHeaderSize;

      const blocks = Math.floor(offset / blockData);
      const discard = offset % blockData;

      let underlyingOffset = headerSize + blocks * (blockHeader + blockData);
      let underlyingLimit = -1;
      if (limit >= 0) {
        let bytesToRead = limit - (blockData - discard);
        let blocksToRead = 1;
        if (bytesToRead > 0) {
          const extraBlocks = Math.floor(bytesToRead / blockData);
          const remainder = bytesToRead % blockData;
          blocksToRead += extraBlocks;
          if (remainder !== 0) {
            blocksToRead += 1;
          }
        }
        underlyingLimit = blocksToRead * (blockHeader + blockData);
      }

      return { underlyingOffset, underlyingLimit, discard, blocks };
    };

    const REQUESTS_PER_SECOND = 4;
    const REQUEST_INTERVAL_MS = Math.floor(1000 / REQUESTS_PER_SECOND);
    const DEFAULT_SEGMENT_RETRY_LIMIT = 10;
    const INFINITE_RETRY_TOKEN = 'inf';
    const RETRY_DELAY_MS = 20000;
    const HTTP429_BASE_DELAY_MS = 1000;
    const HTTP429_SILENT_RETRY_LIMIT = 9;
    const HTTP429_MAX_DELAY_MS = 10000;
    const MIN_PARALLEL_THREADS = 1;
    const MAX_PARALLEL_THREADS = 32;
    const DEFAULT_PARALLEL_THREADS = 6;

    const STORAGE_DB_NAME = 'landing-webdownloader-v2';
    const STORAGE_DB_VERSION = 2;
    const STORAGE_TABLE_SETTINGS = 'settings';
    const STORAGE_TABLE_INFO = 'infoCache';
    const STORAGE_TABLE_HANDLES = 'writerHandles';
    const STORAGE_TABLE_SEGMENTS = 'segments';
    const STORAGE_SESSION_FLAG = 'landing-webdownloader-session';
    const STORAGE_PREFIX = 'landing-web::';
    const STORAGE_VERSION = 1;
    const INFO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

    const openStorageDatabase = (() => {
      let promise = null;
      return () => {
        if (promise) return promise;
        promise = (async () => {
          if (typeof window === 'undefined' || !window.indexedDB || !window.Dexie) {
            return null;
          }
          const DexieClass = window.Dexie;
          const db = new DexieClass(STORAGE_DB_NAME);
          db.version(1).stores({
            [STORAGE_TABLE_SETTINGS]: '&key',
            [STORAGE_TABLE_INFO]: '&key,timestamp',
            [STORAGE_TABLE_HANDLES]: '&key',
          });
          db
            .version(STORAGE_DB_VERSION)
            .stores({
              [STORAGE_TABLE_SETTINGS]: '&key',
              [STORAGE_TABLE_INFO]: '&key,timestamp',
              [STORAGE_TABLE_HANDLES]: '&key',
              [STORAGE_TABLE_SEGMENTS]: '[key+index],key',
            })
            .upgrade(async (transaction) => {
              try {
                const table = transaction.table(STORAGE_TABLE_SEGMENTS);
                if (table) {
                  await table.clear();
                }
              } catch (upgradeError) {
                console.warn('升级 Dexie 存储结构失败', upgradeError);
              }
            });
          return db;
        })().catch((error) => {
          console.warn('初始化 webDownloader Dexie 存储失败', error);
          return null;
        });
        return promise;
      };
    })();

    const ensureSessionIsolation = (() => {
      let promise = null;
      return () => {
        if (promise) return promise;
        promise = (async () => {
          if (typeof window === 'undefined') return;
          let hasActiveSession = false;
          if (window.sessionStorage) {
            try {
              hasActiveSession = window.sessionStorage.getItem(STORAGE_SESSION_FLAG) === '1';
            } catch (error) {
              console.warn('读取 sessionStorage 状态失败', error);
            }
          }
          if (!hasActiveSession) {
            const db = await openStorageDatabase();
            if (db) {
              const tables = [
                STORAGE_TABLE_SETTINGS,
                STORAGE_TABLE_INFO,
                STORAGE_TABLE_HANDLES,
                STORAGE_TABLE_SEGMENTS,
              ];
              await Promise.all(
                tables.map(async (tableName) => {
                  try {
                    await db.table(tableName).clear();
                  } catch (error) {
                    console.warn('清理 Dexie 表 ' + tableName + ' 失败', error);
                  }
                }),
              );
            }
          }
          if (window.sessionStorage) {
            try {
              window.sessionStorage.setItem(STORAGE_SESSION_FLAG, '1');
            } catch (error) {
              console.warn('写入 sessionStorage 状态失败', error);
            }
          }
        })();
        return promise;
      };
    })();

    const useStorageTable = async (tableName, executor, { defaultValue = null } = {}) => {
      await ensureSessionIsolation();
      const db = await openStorageDatabase();
      if (!db) return defaultValue;
      try {
        return await executor(db.table(tableName));
      } catch (error) {
        console.warn('访问 webDownloader Dexie 表 ' + tableName + ' 时出错', error);
        return defaultValue;
      }
    };

    const buildCacheKey = (path, sign) => {
      if (!path) return '';
      const pathPart = encodeURIComponent(path);
      const signPart = encodeURIComponent(sign || '');
      return STORAGE_PREFIX + pathPart + '::' + signPart;
    };

    const saveInfoToCache = async (key, data) => {
      if (!key || !data) return;
      await useStorageTable(
        STORAGE_TABLE_INFO,
        (table) =>
          table.put({
            key,
            version: STORAGE_VERSION,
            timestamp: Date.now(),
            data,
          }),
        { defaultValue: undefined },
      );
    };

    const loadCachedInfo = async (key) => {
      if (!key) return null;
      const now = Date.now();
      return useStorageTable(
        STORAGE_TABLE_INFO,
        async (table) => {
          const record = await table.get(key);
          if (!record) return null;
          const version = Number(record.version) || 0;
          const timestamp = Number(record.timestamp) || 0;
          const hasData = record.data && typeof record.data === 'object';
          if (version !== STORAGE_VERSION || !hasData) {
            await table.delete(key);
            return null;
          }
          if (!Number.isFinite(timestamp) || timestamp <= 0 || now - timestamp > INFO_CACHE_TTL_MS) {
            await table.delete(key);
            return null;
          }
          return record.data;
        },
        { defaultValue: null },
      );
    };

    const removeInfoCache = async (key) => {
      if (!key) return;
      await useStorageTable(
        STORAGE_TABLE_INFO,
        (table) => table.delete(key),
        { defaultValue: undefined },
      );
    };

    const clonePersistedSegment = (value) => {
      if (!value) return null;
      if (value instanceof Uint8Array) {
        return new Uint8Array(value);
      }
      if (value instanceof ArrayBuffer) {
        return new Uint8Array(value.slice(0));
      }
      if (ArrayBuffer.isView(value) && value.buffer) {
        const { buffer, byteOffset, byteLength } = value;
        return new Uint8Array(buffer.slice(byteOffset, byteOffset + byteLength));
      }
      if (value && typeof value === 'object' && value.data) {
        return clonePersistedSegment(value.data);
      }
      return null;
    };

    const buildSegmentSignature = (meta) => {
      if (!meta) return '';
      const size = Number(meta.size) || 0;
      const blockData = Number(meta.blockDataSize) || 0;
      const blockHeader = Number(meta.blockHeaderSize) || 0;
      const fileHeader = Number(meta.fileHeaderSize) || 0;
      const encryption = meta.encryption === 'plain' ? 'plain' : 'crypt';
      return [size, blockData, blockHeader, fileHeader, encryption].join(':');
    };

    const buildCurrentMetaForSignature = () => ({
      size: Number(state.totalSize) || 0,
      blockDataSize: Number(state.blockDataSize) || 0,
      blockHeaderSize: Number(state.blockHeaderSize) || 0,
      fileHeaderSize: Number(state.fileHeaderSize) || 0,
      encryption: state.encryptionMode === 'crypt' ? 'crypt' : 'plain',
    });

    const areUint8ArraysEqual = (a, b) => {
      if (!a && !b) return true;
      if (!a || !b) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
          return false;
        }
      }
      return true;
    };

    const persistSegmentData = async (key, index, data, meta) => {
      if (!key || !Number.isInteger(index) || !data || data.length === 0) return;
      const payload = {
        key,
        index,
        signature: buildSegmentSignature(meta),
        length: data.length,
        data: data.slice(),
        timestamp: Date.now(),
      };
      await useStorageTable(
        STORAGE_TABLE_SEGMENTS,
        (table) => table.put(payload),
        { defaultValue: undefined },
      );
    };

    const loadPersistedSegmentRecords = async (key) => {
      if (!key) return [];
      const records = await useStorageTable(
        STORAGE_TABLE_SEGMENTS,
        (table) => table.where('key').equals(key).toArray(),
        { defaultValue: [] },
      );
      return Array.isArray(records) ? records : [];
    };

    const clearSegmentsForKey = async (key) => {
      if (!key) return;
      await useStorageTable(
        STORAGE_TABLE_SEGMENTS,
        (table) => table.where('key').equals(key).delete(),
        { defaultValue: undefined },
      );
    };

    const saveWriterHandle = async (key, handle) => {
      if (!key || !handle) return;
      await useStorageTable(
        STORAGE_TABLE_HANDLES,
        (table) => table.put({ key, handle }),
        { defaultValue: undefined },
      );
    };

    const loadWriterHandle = async (key) => {
      if (!key) return null;
      const record = await useStorageTable(
        STORAGE_TABLE_HANDLES,
        (table) => table.get(key),
        { defaultValue: null },
      );
      if (!record) return null;
      if (record && typeof record === 'object' && 'handle' in record) {
        return record.handle;
      }
      return record;
    };

    const deleteWriterHandle = async (key) => {
      if (!key) return;
      await useStorageTable(
        STORAGE_TABLE_HANDLES,
        (table) => table.delete(key),
        { defaultValue: undefined },
      );
    };

    const clearAllStorageForKey = async (key) => {
      await Promise.all([
        removeInfoCache(key),
        clearSegmentsForKey(key),
        deleteWriterHandle(key),
      ]);
    };

    const clearAllStorage = async () => {
      const db = await openStorageDatabase();
      if (!db) return;
      const tables = [STORAGE_TABLE_INFO, STORAGE_TABLE_SEGMENTS, STORAGE_TABLE_HANDLES];
      await Promise.all(
        tables.map(async (tableName) => {
          try {
            await db.table(tableName).clear();
          } catch (error) {
            console.warn('清理 Dexie 表 ' + tableName + ' 失败', error);
          }
        }),
      );
    };

    const loadSettingValue = async (key) => {
      const stored = await useStorageTable(
        STORAGE_TABLE_SETTINGS,
        (table) => table.get(key),
        { defaultValue: null },
      );
      if (!stored) return null;
      if (typeof stored === 'string') return stored;
      if (stored && typeof stored === 'object' && typeof stored.value === 'string') {
        return stored.value;
      }
      return null;
    };

    const persistSettingValue = (key, rawValue) => {
      useStorageTable(
        STORAGE_TABLE_SETTINGS,
        (table) => table.put({ key, value: String(rawValue || '') }),
        { defaultValue: undefined },
      );
    };

    const CONNECTION_SETTING_KEY = 'webdownloader-connections';
    const PARALLEL_SETTING_KEY = 'webdownloader-parallel';

    const loadConnectionSetting = async () => {
      const stored = await loadSettingValue(CONNECTION_SETTING_KEY);
      if (!stored) return null;
      const parsed = Number.parseInt(stored, 10);
      if (!Number.isFinite(parsed)) return null;
      if (parsed < MIN_CONNECTIONS || parsed > MAX_CONNECTIONS) return null;
      return parsed;
    };

    const loadParallelSetting = async () => {
      const stored = await loadSettingValue(PARALLEL_SETTING_KEY);
      if (!stored) return null;
      const parsed = Number.parseInt(stored, 10);
      if (!Number.isFinite(parsed)) return null;
      if (parsed < MIN_PARALLEL_THREADS || parsed > MAX_PARALLEL_THREADS) return null;
      return parsed;
    };

    const persistConnectionSetting = (value) => {
      persistSettingValue(CONNECTION_SETTING_KEY, value);
    };

    const persistParallelSetting = (value) => {
      persistSettingValue(PARALLEL_SETTING_KEY, value);
    };

    const ensureHandlePermission = async (handle) => {
      if (!handle) return false;
      const ensure = async (mode) => {
        if (typeof handle.queryPermission === 'function') {
          const status = await handle.queryPermission({ mode });
          if (status === 'granted') return true;
          if (status === 'prompt' && typeof handle.requestPermission === 'function') {
            const granted = await handle.requestPermission({ mode });
            return granted === 'granted';
          }
          if (status === 'denied' && typeof handle.requestPermission === 'function') {
            const granted = await handle.requestPermission({ mode });
            return granted === 'granted';
          }
          return status === 'granted';
        }
        if (typeof handle.requestPermission === 'function') {
          const granted = await handle.requestPermission({ mode });
          return granted === 'granted';
        }
        return true;
      };
      try {
        return await ensure('readwrite');
      } catch (error) {
        console.warn('文件权限请求失败', error);
        return false;
      }
    };

    const getPersistedWriterHandle = async (key) => {
      if (!key || typeof window === 'undefined') return null;
      if (state.writerHandle && state.writerKey === key) {
        if (await ensureHandlePermission(state.writerHandle)) {
          return state.writerHandle;
        }
      }
      const stored = await loadWriterHandle(key);
      if (!stored) return null;
      const allowed = await ensureHandlePermission(stored);
      if (!allowed) {
        await deleteWriterHandle(key);
        return null;
      }
      state.writerHandle = stored;
      state.writerKey = key;
      return stored;
    };

    const state = {
      enabled: false,
      prepared: false,
      running: false,
      cancelling: false,
      remote: null,
      meta: null,
      cacheKey: '',
      infoContext: null,
      totalSize: 0,
      totalEncrypted: 0,
      fileName: '',
      encryptionMode: 'plain',
      blockHeaderSize: 0,
      blockDataSize: 0,
      fileHeaderSize: 0,
      dataKey: null,
      baseNonce: null,
      segments: [],
      pendingSegments: [],
      failedSegments: new Set(),
      abortControllers: new Set(),
      writer: null,
      writerHandle: null,
      writerKey: '',
      downloadStartAt: 0,
      downloadedEncrypted: 0,
      bytesSinceSpeedCheck: 0,
      decryptedBytes: 0,
      speedTimer: null,
      speedSamples: [],
      connectionLimit: DEFAULT_CONNECTIONS,
      segmentRetryLimit: DEFAULT_SEGMENT_RETRY_LIMIT,
      segmentRetryRaw: String(DEFAULT_SEGMENT_RETRY_LIMIT),
      decryptParallelism: DEFAULT_PARALLEL_THREADS,
      decryptParallelRaw: String(DEFAULT_PARALLEL_THREADS),
      workflowPromise: null,
      resumedSegments: 0,
    };

    const hydrateStoredSettings = async () => {
      try {
        const [storedConnections, storedParallel] = await Promise.all([
          loadConnectionSetting(),
          loadParallelSetting(),
        ]);
        if (Number.isFinite(storedConnections)) {
          state.connectionLimit = storedConnections;
          if (connectionLimitInput) {
            connectionLimitInput.value = String(storedConnections);
          }
        }
        if (Number.isFinite(storedParallel)) {
          state.decryptParallelism = storedParallel;
          state.decryptParallelRaw = String(storedParallel);
          if (parallelLimitInput) {
            parallelLimitInput.value = String(storedParallel);
          }
        }
      } catch (error) {
        console.warn('加载 webDownloader 设置失败', error);
      }
    };

    hydrateStoredSettings();

    const resetUi = () => {
      if (downloadBar) downloadBar.style.width = '0%';
      if (decryptBar) decryptBar.style.width = '0%';
      if (downloadText) downloadText.textContent = '0%';
      if (decryptText) decryptText.textContent = '0%';
      if (speedText) speedText.textContent = '--';
      if (cancelBtn) cancelBtn.disabled = true;
      if (retryFailedSegmentsBtn) retryFailedSegmentsBtn.disabled = true;
      if (clearEnvBtn) clearEnvBtn.disabled = true;
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.textContent = '开始下载';
      }
      document.body.classList.remove('web-downloader-active');
    };

    const activateUi = () => {
      document.body.classList.add('web-downloader-active');
      if (cancelBtn) cancelBtn.disabled = true;
      if (clearEnvBtn) clearEnvBtn.disabled = false;
      syncFailedSegmentsUi();
    };

    const buildRemoteHeaders = () => {
      const headers = new Headers();
      if (state.remote?.headers && typeof state.remote.headers === 'object') {
        Object.entries(state.remote.headers).forEach(([key, value]) => {
          if (!key || value === undefined || value === null) return;
          headers.set(key, String(value));
        });
      }
      headers.set('Accept-Encoding', 'identity');
      return headers;
    };

    const applyProgress = () => {
      if (state.totalEncrypted > 0 && downloadBar && downloadText) {
        const percent = Math.min(100, (state.downloadedEncrypted / state.totalEncrypted) * 100);
        const percentText = percent.toFixed(2) + '%';
        downloadBar.style.width = percentText;
        downloadText.textContent =
          percentText +
          ' (' +
          formatBytes(state.downloadedEncrypted) +
          ' / ' +
          formatBytes(state.totalEncrypted) +
          ')';
      }
      if (state.totalSize > 0 && decryptBar && decryptText) {
        const percent = Math.min(100, (state.decryptedBytes / state.totalSize) * 100);
        const percentText = percent.toFixed(2) + '%';
        decryptBar.style.width = percentText;
        decryptText.textContent =
          percentText +
          ' (' +
          formatBytes(state.decryptedBytes) +
          ' / ' +
          formatBytes(state.totalSize) +
          ')';
      }
    };

    const updateSpeed = () => {
      if (!state.running) {
        if (speedText) speedText.textContent = '--';
        return;
      }
      const now = performance.now();
      state.speedSamples.push({ at: now, bytes: state.downloadedEncrypted });
      while (state.speedSamples.length > 0 && now - state.speedSamples[0].at > SPEED_WINDOW) {
        state.speedSamples.shift();
      }
      if (state.speedSamples.length < 2) {
        if (speedText) speedText.textContent = '--';
        return;
      }
      const first = state.speedSamples[0];
      const last = state.speedSamples[state.speedSamples.length - 1];
      const deltaBytes = last.bytes - first.bytes;
      const deltaTime = (last.at - first.at) / 1000;
      const speed = deltaTime > 0 ? deltaBytes / deltaTime : 0;
      if (speedText) {
        speedText.textContent = formatBytes(speed) + '/s';
      }
    };

    const setWriter = (writer) => {
      state.writer = writer;
    };

    const ensureWriter = async () => {
      if (state.writer) return;
      const key = state.cacheKey;
      if (key) {
        const persistedHandle = await getPersistedWriterHandle(key);
        if (persistedHandle && typeof persistedHandle.createWritable === 'function') {
          try {
            const writable = await persistedHandle.createWritable({ keepExistingData: false });
            setWriter({ type: 'fs', handle: persistedHandle, writable, fallback: [] });
            state.writerHandle = persistedHandle;
            state.writerKey = key;
            if (cancelBtn) cancelBtn.disabled = false;
            log('已复用上次的保存位置：' + (persistedHandle.name || state.fileName));
            return;
          } catch (error) {
            console.warn('复用文件句柄失败，改为重新选择', error);
            await deleteWriterHandle(key);
          }
        }
      }
      if ('showSaveFilePicker' in window) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: state.fileName || 'download.bin',
            types: [{ description: 'Binary file', accept: { 'application/octet-stream': ['.bin'] } }],
          });
          const writable = await handle.createWritable({ keepExistingData: false });
          setWriter({ type: 'fs', handle, writable, fallback: [] });
          state.writerHandle = handle;
          if (key) {
            await saveWriterHandle(key, handle);
            state.writerKey = key;
          }
          if (cancelBtn) cancelBtn.disabled = false;
          log('已选择保存位置：' + (handle.name || state.fileName));
          return;
        } catch (error) {
          log('文件系统访问不可用，改为浏览器下载。原因：' + (error && error.message ? error.message : '未知'));
        }
      }
      setWriter({ type: 'memory', chunks: [] });
      state.writerHandle = null;
      state.writerKey = '';
    };

    const writeChunk = async (chunk) => {
      if (!state.writer) {
        throw new Error('writer 未初始化');
      }
      if (state.writer.type === 'fs') {
        try {
          await state.writer.writable.write(chunk);
          return;
        } catch (error) {
          log('写入文件失败，切换为内存缓冲：' + (error && error.message ? error.message : '未知错误'));
          if (state.writer.writable) {
            try {
              await state.writer.writable.abort();
            } catch (abortError) {
              console.warn('关闭写入器失败', abortError);
            }
          }
          setWriter({ type: 'memory', chunks: [] });
        }
      }
      state.writer.chunks.push(chunk);
    };

    const finalizeWriter = async () => {
      if (!state.writer) return;
      if (state.writer.type === 'fs') {
        try {
          await state.writer.writable.close();
          log('文件已保存');
        } catch (error) {
          console.error('关闭文件写入器失败', error);
        }
        setWriter(null);
        return;
      }
      const blob = new Blob(state.writer.chunks, { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = state.fileName || 'download.bin';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (state.writer.chunks) state.writer.chunks.length = 0;
      log('已触发浏览器下载');
      setWriter(null);
    };

    const decodeDownloadUrl = (download) => {
      if (download.urlBase64) {
        try {
          return atob(download.urlBase64);
        } catch (error) {
          console.warn('download.urlBase64 解码失败，回退到 url', error);
        }
      }
      return download.url;
    };

    const fetchCryptHeader = async () => {
      if (state.encryptionMode !== 'crypt' || state.baseNonce) return;
      if (!Number.isFinite(state.fileHeaderSize) || state.fileHeaderSize <= 0) {
        throw new Error('缺少 crypt header 尺寸配置');
      }
      const headers = buildRemoteHeaders();
      headers.set('Range', 'bytes=0-' + (state.fileHeaderSize - 1));
      const response = await fetch(state.remote.url, {
        method: state.remote.method || 'GET',
        headers,
      });
      if (!(response.ok || response.status === 206)) {
        throw new Error('获取 crypt header 失败，HTTP ' + response.status);
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length < state.fileHeaderSize) {
         throw new Error('crypt header 长度不足');
      }
      const magic = [82, 67, 76, 79, 78, 69, 0, 0];
      for (let i = 0; i < magic.length; i += 1) {
        if (buffer[i] !== magic[i]) {
          throw new Error('crypt header 魔数不匹配');
        }
      }
      const nonceStart = magic.length;
      const nonceEnd = nonceStart + NONCE_SIZE;
      state.baseNonce = cloneUint8(buffer.subarray(nonceStart, nonceEnd));
      if (!state.baseNonce || state.baseNonce.length !== NONCE_SIZE) {
        throw new Error('crypt header 中 nonce 无效');
      }
    };

    const createSegments = () => {
      const fileSize = state.totalSize;
      if (!Number.isFinite(fileSize) || fileSize <= 0) {
        throw new Error('文件大小未知，无法启用 webDownloader');
      }
      const segments = [];
      let offset = 0;
      let index = 0;
      const meta = {
        encryption: state.encryptionMode,
        blockDataSize: state.blockDataSize,
        blockHeaderSize: state.blockHeaderSize,
        fileHeaderSize: state.fileHeaderSize,
        size: state.totalSize,
      };
      let encryptedTotal = 0;
      while (offset < fileSize) {
        const length = Math.min(SEGMENT_SIZE_BYTES, fileSize - offset);
        const mapping = calculateUnderlying(offset, length, meta);
        const encryptedSize = Number.isFinite(mapping.underlyingLimit) && mapping.underlyingLimit > 0
          ? mapping.underlyingLimit
          : length;
        encryptedTotal += encryptedSize;
        segments.push({
          index,
          offset,
          length,
          mapping,
          encrypted: null,
          retries: 0,
          status: 'pending',
          error: null,
        });
        offset += length;
        index += 1;
      }
      state.segments = segments;
      state.pendingSegments = segments.map((segment) => segment.index);
      state.failedSegments = new Set();
      state.totalEncrypted = encryptedTotal > 0 ? encryptedTotal : fileSize;
      state.downloadedEncrypted = 0;
      state.bytesSinceSpeedCheck = 0;
      state.decryptedBytes = 0;
      state.resumedSegments = 0;
      syncFailedSegmentsUi();
    };

    const syncFailedSegmentsUi = () => {
      if (!retryFailedSegmentsBtn) return;
      const failedCount = state.failedSegments.size;
      retryFailedSegmentsBtn.disabled = failedCount === 0;
      retryFailedSegmentsBtn.textContent =
        failedCount > 0 ? '重试失败片段 (' + failedCount + ')' : '重试失败片段';
    };

    const restoreSegmentsFromCache = async () => {
      if (!state.cacheKey || state.segments.length === 0) {
        state.pendingSegments = state.segments.map((segment) => segment.index);
        state.failedSegments.clear();
        syncFailedSegmentsUi();
        return 0;
      }
      const signature = buildSegmentSignature(buildCurrentMetaForSignature());
      const records = await loadPersistedSegmentRecords(state.cacheKey);
      const persistedMap = new Map();
      records.forEach((record) => {
        if (!record || record.signature !== signature) {
          return;
        }
        const index = Number(record.index);
        if (!Number.isInteger(index) || index < 0) {
          return;
        }
        const cloned = clonePersistedSegment(record.data);
        if (cloned && cloned.length > 0) {
          persistedMap.set(index, cloned);
        }
      });
      let reused = 0;
      let encryptedTotal = 0;
      state.pendingSegments = [];
      state.segments.forEach((segment) => {
        segment.retries = 0;
        segment.error = null;
        segment.status = 'pending';
        const buffer = persistedMap.get(segment.index);
        if (buffer && buffer.length > 0) {
          segment.encrypted = buffer;
          segment.status = 'done';
          encryptedTotal += buffer.length;
          reused += 1;
        } else {
          segment.encrypted = null;
          state.pendingSegments.push(segment.index);
        }
      });
      state.downloadedEncrypted = encryptedTotal;
      state.bytesSinceSpeedCheck = 0;
      state.failedSegments.clear();
      syncFailedSegmentsUi();
      state.resumedSegments = reused;
      applyProgress();
      return reused;
    };

    const enqueueSegment = (index, prioritize = false) => {
      if (!Number.isInteger(index)) return;
      const segment = state.segments[index];
      if (!segment || segment.status === 'done') return;
      if (segment.status !== 'pending') {
        segment.status = 'pending';
      }
      if (prioritize) {
        state.pendingSegments.unshift(index);
      } else {
        state.pendingSegments.push(index);
      }
    };

    const takeNextSegmentIndex = () => {
      while (state.pendingSegments.length > 0) {
        const index = state.pendingSegments.shift();
        if (!Number.isInteger(index)) {
          continue;
        }
        const segment = state.segments[index];
        if (!segment) {
          continue;
        }
        if (segment.encrypted && segment.status === 'done') {
          continue;
        }
        if (segment.status === 'downloading') {
          continue;
        }
        segment.status = 'downloading';
        return index;
      }
      return undefined;
    };

    const recordSegmentFailure = (segment, errorMessage) => {
      if (!segment) return;
      segment.status = 'failed';
      segment.error = errorMessage || null;
      state.failedSegments.add(segment.index);
      syncFailedSegmentsUi();
    };

    const downloadSegment = async (index) => {
      const segment = state.segments[index];
      if (!segment) return;
      let attempt = 0;
      while (true) {
        if (state.cancelling) {
          throw new Error('cancelled');
        }
        const headers = buildRemoteHeaders();
        const start = Number(segment.mapping.underlyingOffset) || 0;
        const limit = Number(segment.mapping.underlyingLimit) || segment.length;
        const end = limit > 0 ? start + limit - 1 : start + segment.length - 1;
        headers.set('Range', 'bytes=' + start + '-' + end);
        const controller = new AbortController();
        state.abortControllers.add(controller);
        try {
          const response = await fetch(state.remote.url, {
            method: state.remote.method || 'GET',
            headers,
            signal: controller.signal,
          });
          if (!(response.ok || response.status === 206)) {
            throw new Error('分段下载失败，HTTP ' + response.status);
          }
          const buffer = new Uint8Array(await response.arrayBuffer());
          state.downloadedEncrypted = Math.min(
            state.totalEncrypted,
            state.downloadedEncrypted + buffer.length,
          );
          state.bytesSinceSpeedCheck += buffer.length;
          applyProgress();
          let payload = buffer;
          if (state.encryptionMode === 'plain' && buffer.length > segment.length) {
            const excess = buffer.length - segment.length;
            payload = buffer.subarray(0, segment.length);
            state.downloadedEncrypted = Math.max(0, state.downloadedEncrypted - excess);
            state.bytesSinceSpeedCheck = Math.max(0, state.bytesSinceSpeedCheck - excess);
          }
          segment.encrypted = payload;
          segment.status = 'done';
          segment.error = null;
          state.failedSegments.delete(segment.index);
          syncFailedSegmentsUi();
          if (state.cacheKey) {
            await persistSegmentData(
              state.cacheKey,
              segment.index,
              payload,
              buildCurrentMetaForSignature()
            );
          }
          return;
        } catch (error) {
          if (state.cancelling) {
            throw error instanceof Error ? error : new Error(String(error || 'cancelled'));
          }
          const message = error instanceof Error && error.message ? error.message : String(error || '未知错误');
          attempt += 1;
          const retryLimit = state.segmentRetryLimit;
          const shouldRetry = Number.isFinite(retryLimit) ? attempt <= retryLimit : true;
          if (shouldRetry) {
            const isHttp429 = typeof message === 'string' && message.includes('HTTP 429');
            let retryDelayMs = RETRY_DELAY_MS;
            let shouldLogRetry = true;
            if (isHttp429) {
              if (attempt <= HTTP429_SILENT_RETRY_LIMIT) {
                retryDelayMs = HTTP429_BASE_DELAY_MS;
                shouldLogRetry = false;
              } else {
                const exponent = attempt - HTTP429_SILENT_RETRY_LIMIT;
                const exponentialDelay = HTTP429_BASE_DELAY_MS * Math.pow(2, Math.max(0, exponent - 1));
                retryDelayMs = Math.min(HTTP429_MAX_DELAY_MS, exponentialDelay);
              }
            }
            if (shouldLogRetry) {
              log(
                '分段 #' +
                  (segment.index + 1) +
                  ' 下载失败：' +
                  message +
                  '，将在 ' +
                  (retryDelayMs / 1000).toFixed(0) +
                  ' 秒后重试（第 ' +
                  attempt +
                  ' 次）'
              );
            }
            await sleep(retryDelayMs);
            continue;
          }
          recordSegmentFailure(segment, message);
          throw error instanceof Error ? error : new Error(message);
        } finally {
          state.abortControllers.delete(controller);
          try {
            controller.abort();
          } catch (abortError) {
            console.warn('中止分段请求失败', abortError);
          }
        }
      }
    };

    const decryptSegmentData = async (segment) => {
      if (!segment || !segment.encrypted) {
        throw new Error('缺少分段数据');
      }
      if (state.encryptionMode === 'plain') {
        return segment.encrypted.subarray(0, segment.length);
      }
      const buffer = segment.encrypted;
      const output = new Uint8Array(segment.length);
      let produced = 0;
      let blockIndex = segment.mapping.blocks;
      let discard = segment.mapping.discard;
      let offset = 0;
      while (offset < buffer.length && produced < segment.length) {
        if (offset + state.blockHeaderSize > buffer.length) break;
        let end = offset + state.blockHeaderSize + state.blockDataSize;
        if (end > buffer.length) {
          end = buffer.length;
        }
        const cipherBlock = buffer.subarray(offset, end);
        offset = end;
        const plainBlock = decryptBlock(cipherBlock, state.dataKey, state.baseNonce, blockIndex);
        if (!plainBlock) {
          throw new Error('解密失败，请重试');
        }
        let chunk = plainBlock;
        if (blockIndex === segment.mapping.blocks && discard > 0) {
          if (chunk.length <= discard) {
            discard -= chunk.length;
            blockIndex += 1;
            continue;
          }
          chunk = chunk.subarray(discard);
          discard = 0;
        }
        const remaining = segment.length - produced;
        if (chunk.length > remaining) {
          output.set(chunk.subarray(0, remaining), produced);
          produced += remaining;
          break;
        }
        output.set(chunk, produced);
        produced += chunk.length;
        blockIndex += 1;
      }
      if (produced !== segment.length) {
        throw new Error('解密输出长度不匹配');
      }
      return output;
    };

    const clampParallelThreads = (value) => {
      if (!Number.isFinite(value)) {
        return DEFAULT_PARALLEL_THREADS;
      }
      const rounded = Math.floor(value);
      if (rounded < MIN_PARALLEL_THREADS) return MIN_PARALLEL_THREADS;
      if (rounded > MAX_PARALLEL_THREADS) return MAX_PARALLEL_THREADS;
      return rounded;
    };

    const resolveParallelism = () => {
      const configured = clampParallelThreads(state.decryptParallelism);
      if (typeof navigator !== 'undefined' && navigator && Number.isFinite(navigator.hardwareConcurrency)) {
        const hardwareClamped = clampParallelThreads(navigator.hardwareConcurrency);
        return Math.max(MIN_PARALLEL_THREADS, Math.min(configured, hardwareClamped));
      }
      return configured;
    };

    const decryptAllSegments = async () => {
      if (state.segments.length === 0) return;
      setStatus('下载完成，准备解密');
      const totalSegments = state.segments.length;
      const parallelism = Math.min(resolveParallelism(), totalSegments);
      let nextToAssign = 0;
      let nextToWrite = 0;
      const pendingResults = new Map();
      let flushError = null;
      let flushChain = Promise.resolve();

      const scheduleFlush = () => {
        flushChain = flushChain
          .then(async () => {
            while (pendingResults.has(nextToWrite)) {
              const chunk = pendingResults.get(nextToWrite);
              pendingResults.delete(nextToWrite);
              if (state.cancelling) {
                throw new Error('cancelled');
              }
              await writeChunk(chunk);
              state.decryptedBytes = Math.min(state.totalSize, state.decryptedBytes + chunk.length);
              const finishedSegment = state.segments[nextToWrite];
              if (finishedSegment) {
                finishedSegment.encrypted = null;
              }
              nextToWrite += 1;
              applyProgress();
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
          })
          .catch((error) => {
            flushError = error instanceof Error ? error : new Error(String(error));
            throw flushError;
          });
      };

      const worker = async () => {
        while (true) {
          if (flushError) {
            throw flushError;
          }
          if (state.cancelling) {
            throw new Error('cancelled');
          }
          const currentIndex = nextToAssign;
          if (currentIndex >= totalSegments) {
            break;
          }
          nextToAssign += 1;
          const segment = state.segments[currentIndex];
          const plain = await decryptSegmentData(segment);
          pendingResults.set(currentIndex, plain);
          scheduleFlush();
        }
      };

      const workers = [];
      for (let i = 0; i < parallelism; i += 1) {
        workers.push(worker());
      }
      await Promise.all(workers);
      await flushChain;
      if (flushError) {
        throw flushError;
      }
      if (nextToWrite !== totalSegments) {
        throw new Error('仍有分段未完成解密');
      }
    };

    const writePlainSegments = async () => {
      for (let i = 0; i < state.segments.length; i += 1) {
        if (state.cancelling) {
          throw new Error('cancelled');
        }
        const segment = state.segments[i];
        if (!segment || !segment.encrypted) {
          throw new Error('缺少分段数据');
        }
        const payload = segment.encrypted.subarray(0, segment.length);
        await writeChunk(payload);
        state.decryptedBytes = Math.min(state.totalSize, state.decryptedBytes + payload.length);
        segment.encrypted = null;
        applyProgress();
        if (state.decryptedBytes < state.totalSize) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    };

    const downloadAllSegments = async () => {
      if (state.segments.length === 0) {
        return;
      }
      const connectionLimit = clamp(state.connectionLimit, MIN_CONNECTIONS, MAX_CONNECTIONS, DEFAULT_CONNECTIONS);
      const inFlight = new Set();
      let lastDispatchAt = 0;
      const rateDelay = async () => {
        const now = performance.now();
        const elapsed = now - lastDispatchAt;
        if (elapsed < REQUEST_INTERVAL_MS) {
          await sleep(REQUEST_INTERVAL_MS - elapsed);
        }
        lastDispatchAt = performance.now();
      };
      const launchDownload = (index) => {
        const task = (async () => {
          await downloadSegment(index);
        })().finally(() => {
          inFlight.delete(task);
        });
        inFlight.add(task);
        return task;
      };
      while (true) {
        if (state.cancelling) {
          throw new Error('cancelled');
        }
        if (inFlight.size >= connectionLimit) {
          await Promise.race(inFlight);
          continue;
        }
        const nextIndex = takeNextSegmentIndex();
        if (nextIndex === undefined) {
          if (inFlight.size === 0) {
            break;
          }
          await Promise.race(inFlight);
          continue;
        }
        launchDownload(nextIndex);
        await rateDelay();
      }
      await Promise.all(inFlight);
      const unfinished = state.segments.find((segment) => !segment.encrypted);
      if (unfinished) {
        throw new Error('仍有分段未完成下载');
      }
    };

    const startWorkflow = async () => {
      if (state.workflowPromise) return state.workflowPromise;
      if (!state.prepared) {
        throw new Error('webDownloader 未准备就绪');
      }
      state.workflowPromise = (async () => {
        state.running = true;
        state.cancelling = false;
        state.abortControllers = new Set();
        state.downloadedEncrypted = state.downloadedEncrypted || 0;
        state.decryptedBytes = state.decryptedBytes || 0;
        applyProgress();
        if (downloadBtn) {
          downloadBtn.disabled = true;
          downloadBtn.textContent = '下载中...';
        }
        if (cancelBtn) cancelBtn.disabled = false;
        if (clearEnvBtn) clearEnvBtn.disabled = true;
        setStatus('开始下载，准备文件...');
        try {
          const autoRequeued = requeueFailedSegments({ silent: true });
          if (autoRequeued) {
            log('已自动重新排队之前失败的分段');
          }
          if (state.encryptionMode === 'crypt') {
            if (!window.nacl || !window.nacl.secretbox || !window.nacl.secretbox.open) {
              throw new Error('TweetNaCl 初始化失败，请刷新页面重试');
            }
          }
          await ensureWriter();
          if (state.encryptionMode === 'crypt' && !state.baseNonce) {
            await fetchCryptHeader();
          }
          state.downloadStartAt = performance.now();
          if (state.speedTimer) clearInterval(state.speedTimer);
          state.speedTimer = setInterval(updateSpeed, 1000);
          await downloadAllSegments();
          if (state.encryptionMode === 'crypt') {
            await decryptAllSegments();
          } else {
            await writePlainSegments();
          }
          await finalizeWriter();
          if (speedText) speedText.textContent = '--';
          setStatus('下载完成');
        } catch (error) {
          if (speedText) speedText.textContent = '--';
          if (state.cancelling) {
            setStatus('下载已取消');
          } else {
            const message = error instanceof Error && error.message ? error.message : String(error || '未知错误');
            setStatus('下载失败：' + message);
            console.error(error);
          }
          throw error;
        } finally {
          state.running = false;
          if (state.speedTimer) {
            clearInterval(state.speedTimer);
            state.speedTimer = null;
          }
          if (cancelBtn) cancelBtn.disabled = true;
          if (clearEnvBtn) clearEnvBtn.disabled = false;
          syncFailedSegmentsUi();
          if (downloadBtn) {
            downloadBtn.disabled = false;
            downloadBtn.textContent = '重新下载';
          }
          state.workflowPromise = null;
        }
      })();
      return state.workflowPromise;
    };

    const cancelDownload = async () => {
      if (!state.running) return;
      state.cancelling = true;
      state.pendingSegments.length = 0;
      state.abortControllers?.forEach((controller) => {
        try {
          controller.abort();
        } catch (error) {
          console.warn('取消请求失败', error);
        }
      });
      state.abortControllers = new Set();
      setStatus('正在取消下载...');
    };

    const normalizeDownloadInfo = (info) => {
      if (!info || !info.download) {
        throw new Error('缺少下载信息');
      }
      const remote = {
        url: decodeDownloadUrl(info.download),
        method: info.download.remote?.method || 'GET',
        headers: info.download.remote?.headers || {},
      };
      const remoteLength = Number(info.download.remote?.length);
      const metaSize = Number(info.meta?.size);
      let totalSize = 0;
      if (Number.isFinite(remoteLength) && remoteLength > 0) {
        totalSize = remoteLength;
      } else if (Number.isFinite(metaSize) && metaSize > 0) {
        totalSize = metaSize;
      }
      const downloadMeta = info.download.meta || {};
      const encryptionMode = downloadMeta.encryption === 'crypt' ? 'crypt' : 'plain';
      const blockHeaderSize = Number(downloadMeta.blockHeaderSize) || 0;
      const blockDataSize = Number(downloadMeta.blockDataSize) || 0;
      const fileHeaderSize = Number(downloadMeta.fileHeaderSize) || 0;
      const dataKey = downloadMeta.dataKey ? base64ToUint8(downloadMeta.dataKey) : null;
      const meta = info.meta && typeof info.meta === 'object' ? { ...info.meta } : {};
      meta.size = totalSize;
      const fileNameCandidate =
        typeof meta.fileName === 'string' && meta.fileName.trim().length > 0 ? meta.fileName.trim() : '';
      let fallbackName = '';
      if (!fileNameCandidate && typeof meta.path === 'string' && meta.path) {
        const parts = meta.path.split('/').filter(Boolean);
        fallbackName = parts.length > 0 ? parts[parts.length - 1] : '';
      }
      const fileName = fileNameCandidate || fallbackName || 'download.bin';
      return {
        remote,
        totalSize,
        meta,
        encryptionMode,
        blockHeaderSize,
        blockDataSize,
        fileHeaderSize,
        dataKey,
        fileName,
      };
    };

    const prepareFromInfo = async (info, { autoStart = false, path = '', sign = '' } = {}) => {
      const normalized = normalizeDownloadInfo(info);
      state.enabled = true;
      state.prepared = false;
      state.running = false;
      state.cancelling = false;
      state.remote = normalized.remote;
      state.meta = normalized.meta;
      state.fileName = normalized.fileName;
      state.totalSize =
        Number.isFinite(normalized.totalSize) && normalized.totalSize > 0 ? normalized.totalSize : 0;
      state.encryptionMode = normalized.encryptionMode;
      state.blockHeaderSize = Number(normalized.blockHeaderSize) || 0;
      state.blockDataSize = Number(normalized.blockDataSize) || 0;
      state.fileHeaderSize = Number(normalized.fileHeaderSize) || 0;
      state.dataKey = normalized.dataKey;
      state.baseNonce = null;
      if (state.encryptionMode === 'crypt' && (!state.dataKey || state.dataKey.length === 0)) {
        throw new Error('缺少 CRYPT_DATA_KEY，无法解密文件');
      }
      state.infoContext = { path, sign };
      state.cacheKey = path ? buildCacheKey(path, sign) : '';
      if (state.cacheKey && info) {
        await saveInfoToCache(state.cacheKey, info);
      }
      state.connectionLimit = clamp(
        Number(connectionLimitInput?.value) || state.connectionLimit || DEFAULT_CONNECTIONS,
        MIN_CONNECTIONS,
        MAX_CONNECTIONS,
        DEFAULT_CONNECTIONS
      );
      if (connectionLimitInput) {
        connectionLimitInput.value = String(state.connectionLimit);
      }
      const rawRetry = (retryLimitInput && retryLimitInput.value || '').trim().toLowerCase();
      if (rawRetry === INFINITE_RETRY_TOKEN) {
        state.segmentRetryLimit = Infinity;
        state.segmentRetryRaw = INFINITE_RETRY_TOKEN;
      } else if (rawRetry) {
        const parsedRetry = Number.parseInt(rawRetry, 10);
        state.segmentRetryLimit = Number.isFinite(parsedRetry) && parsedRetry >= 0 ? parsedRetry : DEFAULT_SEGMENT_RETRY_LIMIT;
        state.segmentRetryRaw = String(state.segmentRetryLimit);
      } else {
        state.segmentRetryLimit = DEFAULT_SEGMENT_RETRY_LIMIT;
        state.segmentRetryRaw = String(DEFAULT_SEGMENT_RETRY_LIMIT);
      }
      if (retryLimitInput) {
        retryLimitInput.value = state.segmentRetryRaw;
      }
      const rawParallel = (parallelLimitInput && parallelLimitInput.value) || state.decryptParallelRaw;
      if (rawParallel) {
        const parsedParallel = Number.parseInt(rawParallel, 10);
        if (Number.isFinite(parsedParallel)) {
          state.decryptParallelism = clampParallelThreads(parsedParallel);
          state.decryptParallelRaw = String(state.decryptParallelism);
          if (parallelLimitInput) {
            parallelLimitInput.value = state.decryptParallelRaw;
          }
        }
      }
      state.downloadedEncrypted = 0;
      state.decryptedBytes = 0;
      state.failedSegments.clear();
      syncFailedSegmentsUi();
      createSegments();
      const reused = await restoreSegmentsFromCache();
      activateUi();
      applyProgress();
      if (reused > 0) {
        log('已复用 ' + reused + ' 个已下载分段，可继续下载剩余部分。');
        setStatus('准备就绪，保留了 ' + reused + ' 个已完成分段。');
      } else {
        setStatus('准备就绪，点击开始下载');
      }
      state.prepared = true;
      if (downloadBtn) {
        downloadBtn.textContent = '开始下载';
        downloadBtn.disabled = false;
      }
      if (autoStart) {
        startWorkflow().catch((error) => console.error(error));
      }
    };

    const prepareFromCache = async ({ path = '', sign = '', autoStart = false } = {}) => {
      if (!path) return null;
      const key = buildCacheKey(path, sign);
      if (!key) return null;
      const cached = await loadCachedInfo(key);
      if (!cached || !cached.download) {
        return null;
      }
      await prepareFromInfo(cached, { autoStart, path, sign });
      return cached;
    };

    const refreshFromInfo = async (info, { autoStart = false, path = '', sign = '' } = {}) => {
      if (!info || !info.download) {
        throw new Error('缺少下载信息');
      }
      if (!state.prepared) {
        await prepareFromInfo(info, { autoStart, path, sign });
        return;
      }
      const normalized = normalizeDownloadInfo(info);
      const nextMetaSignature = buildSegmentSignature({
        size: normalized.totalSize,
        blockDataSize: normalized.blockDataSize,
        blockHeaderSize: normalized.blockHeaderSize,
        fileHeaderSize: normalized.fileHeaderSize,
        encryption: normalized.encryptionMode,
      });
      const currentSignature = buildSegmentSignature(buildCurrentMetaForSignature());
      const dataKeyEqual = areUint8ArraysEqual(normalized.dataKey, state.dataKey);
      const compatible = nextMetaSignature === currentSignature && dataKeyEqual;
      if (!compatible) {
        if (state.running) {
          log('检测到下载配置变化，当前任务需取消后重新开始。');
          setStatus('下载配置已更新，请取消后重新开始。');
          return;
        }
        await prepareFromInfo(info, { autoStart, path, sign });
        return;
      }
      state.remote = normalized.remote;
      state.meta = normalized.meta;
      state.fileName = normalized.fileName;
      state.totalSize = normalized.totalSize;
      state.blockHeaderSize = Number(normalized.blockHeaderSize) || 0;
      state.blockDataSize = Number(normalized.blockDataSize) || 0;
      state.fileHeaderSize = Number(normalized.fileHeaderSize) || 0;
      if (normalized.dataKey && normalized.dataKey.length > 0) {
        state.dataKey = normalized.dataKey;
      }
      state.infoContext = { path, sign };
      if (!state.cacheKey && path) {
        state.cacheKey = buildCacheKey(path, sign);
      }
      if (state.cacheKey) {
        await saveInfoToCache(state.cacheKey, info);
      }
      log('已刷新下载链接，可继续当前任务。');
    };

    const handlePrimaryAction = () => {
      if (!state.prepared) return;
      if (state.running) {
        return;
      }
      startWorkflow().catch((error) => {
        console.error(error);
        setStatus('下载失败：' + (error && error.message ? error.message : '未知错误'));
      });
    };

    const reset = () => {
      state.enabled = false;
      state.prepared = false;
      state.running = false;
      state.remote = null;
      state.meta = null;
      state.dataKey = null;
      state.baseNonce = null;
      state.infoContext = null;
      state.cacheKey = '';
      state.totalSize = 0;
      state.totalEncrypted = 0;
      state.fileName = '';
      state.encryptionMode = 'plain';
      state.blockHeaderSize = 0;
      state.blockDataSize = 0;
      state.fileHeaderSize = 0;
      state.segments = [];
      state.pendingSegments = [];
      state.failedSegments.clear();
      state.writer = null;
      state.writerHandle = null;
      state.writerKey = '';
      state.downloadedEncrypted = 0;
      state.decryptedBytes = 0;
      state.bytesSinceSpeedCheck = 0;
      state.downloadStartAt = 0;
      state.speedSamples = [];
      state.workflowPromise = null;
      state.abortControllers = new Set();
      if (state.speedTimer) {
        clearInterval(state.speedTimer);
        state.speedTimer = null;
      }
      resetUi();
    };

    const requeueFailedSegments = ({ silent = false } = {}) => {
      if (state.failedSegments.size === 0) return false;
      state.failedSegments.forEach((index) => {
        const segment = state.segments[index];
        if (!segment) return;
        segment.encrypted = null;
        segment.retries = 0;
        segment.status = 'pending';
        segment.error = null;
        enqueueSegment(index, true);
      });
      state.failedSegments.clear();
      syncFailedSegmentsUi();
      if (!silent) {
        setStatus('失败分段已重新排队，点击开始下载继续。');
      }
      return true;
    };

    const retryFailedSegments = () => {
      requeueFailedSegments({ silent: false });
    };

    const clearStoredTasks = async () => {
      if (state.cacheKey) {
        await clearAllStorageForKey(state.cacheKey);
      } else {
        await clearAllStorage();
      }
      state.failedSegments.clear();
      syncFailedSegmentsUi();
      reset();
      setStatus('已清理所有已保存的任务数据。');
    };

    const updateConnectionLimit = (value) => {
      state.connectionLimit = clamp(Number(value), MIN_CONNECTIONS, MAX_CONNECTIONS, DEFAULT_CONNECTIONS);
      if (connectionLimitInput) {
        connectionLimitInput.value = String(state.connectionLimit);
      }
      persistConnectionSetting(state.connectionLimit);
    };

    const updateRetryLimit = (value) => {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (!raw) {
        state.segmentRetryLimit = DEFAULT_SEGMENT_RETRY_LIMIT;
        state.segmentRetryRaw = String(DEFAULT_SEGMENT_RETRY_LIMIT);
        if (retryLimitInput) {
          retryLimitInput.value = state.segmentRetryRaw;
        }
        return;
      }
      if (raw === INFINITE_RETRY_TOKEN) {
        state.segmentRetryLimit = Infinity;
        state.segmentRetryRaw = INFINITE_RETRY_TOKEN;
        if (retryLimitInput) {
          retryLimitInput.value = state.segmentRetryRaw;
        }
        return;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        state.segmentRetryLimit = DEFAULT_SEGMENT_RETRY_LIMIT;
        state.segmentRetryRaw = String(DEFAULT_SEGMENT_RETRY_LIMIT);
        if (retryLimitInput) {
          retryLimitInput.value = state.segmentRetryRaw;
        }
        return;
      }
      state.segmentRetryLimit = parsed;
      state.segmentRetryRaw = String(parsed);
      if (retryLimitInput) {
        retryLimitInput.value = state.segmentRetryRaw;
      }
    };

    const updateParallelLimit = (value) => {
      const raw = typeof value === 'string' ? value.trim() : '';
      if (!raw) {
        state.decryptParallelism = DEFAULT_PARALLEL_THREADS;
        state.decryptParallelRaw = String(DEFAULT_PARALLEL_THREADS);
        if (parallelLimitInput) {
          parallelLimitInput.value = state.decryptParallelRaw;
        }
        persistParallelSetting(state.decryptParallelism);
        return;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) {
        return;
      }
      state.decryptParallelism = clampParallelThreads(parsed);
      state.decryptParallelRaw = String(state.decryptParallelism);
      if (parallelLimitInput) {
        parallelLimitInput.value = state.decryptParallelRaw;
      }
      persistParallelSetting(state.decryptParallelism);
    };

    return {
      isEnabled: () => state.enabled,
      isRunning: () => state.running,
      prepareFromInfo,
      prepareFromCache,
      refreshFromInfo,
      handlePrimaryAction,
      cancelDownload,
      reset,
      updateConnectionLimit,
      updateRetryLimit,
      updateParallelLimit,
      retryFailedSegments,
      clearStoredTasks,
    };
  })();

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
      setButtonText(downloadBtn, '开始下载', false);
    } else {
      downloadBtn.disabled = true;
      setButtonText(downloadBtn, '身份验证中', true);
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
        const secondsUntilExpiry = Math.max(
          0,
          Math.floor(challenge.bindingExpiresAt - Date.now() / 1000)
        );
        log('PoW计算完成，' + secondsUntilExpiry + '秒后失效');
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

    if (state.mode === 'web') {
      webDownloader.reset();
    }
    state.mode = 'legacy';
    state.infoReady = false;
    updateButtonState();

    let warmedFromCache = false;
    if (!forceRefresh) {
      try {
        const cached = await webDownloader.prepareFromCache({
          path,
          sign,
          autoStart: false,
        });
        if (cached) {
          warmedFromCache = true;
          state.mode = 'web';
          state.infoReady = true;
          setStatus('已从缓存恢复下载任务，正在刷新最新信息...');
          notifyAutoRedirectForWeb();
        }
      } catch (cacheError) {
        console.warn('从缓存恢复 webDownloader 失败', cacheError);
        webDownloader.reset();
        state.mode = 'legacy';
        state.infoReady = false;
      }
    }

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

    const infoData = result.data;
    if (!infoData?.download) {
      throw new Error('服务器未返回下载信息');
    }

    if (infoData.settings?.webDownloader) {
      const shouldAutoStart = false; // webDownloader requires an explicit user gesture
      await webDownloader.refreshFromInfo(infoData, {
        autoStart: shouldAutoStart,
        path,
        sign,
      });
      state.mode = 'web';
      state.infoReady = true;
      notifyAutoRedirectForWeb();
      return;
    }

    if (webDownloader.isEnabled()) {
      webDownloader.reset();
    }
    state.mode = 'legacy';
    state.infoReady = false;

    const downloadURL = infoData.download.url;
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

    if (state.mode === 'web' && webDownloader.isEnabled()) {
      webDownloader.handlePrimaryAction();
      return;
    }

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
    setButtonText(downloadBtn, '身份验证中', true);
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
    if (state.mode === 'web') {
      webDownloader.reset();
    }
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

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      webDownloader.cancelDownload().catch((error) => {
        if (error) {
          console.error('取消下载失败', error);
        }
      });
    });
  }

  if (clearEnvBtn) {
    clearEnvBtn.addEventListener('click', async () => {
      try {
        await webDownloader.clearStoredTasks();
        state.infoReady = false;
        state.mode = 'legacy';
        state.downloadBtnMode = 'download';
        if (downloadBtn) {
          downloadBtn.textContent = '开始下载';
          downloadBtn.disabled = false;
        }
        updateButtonState();
      } catch (error) {
        console.error('清理任务失败', error);
        setStatus('清理任务失败：' + (error && error.message ? error.message : '未知错误'));
      }
    });
  }

  if (connectionLimitInput) {
    connectionLimitInput.addEventListener('change', (event) => {
      webDownloader.updateConnectionLimit(event.target.value);
    });
  }

  if (retryLimitInput) {
    retryLimitInput.addEventListener('change', (event) => {
      webDownloader.updateRetryLimit(event.target.value);
    });
  }

  if (parallelLimitInput) {
    parallelLimitInput.addEventListener('change', (event) => {
      webDownloader.updateParallelLimit(event.target.value);
    });
  }

  if (retryFailedSegmentsBtn) {
    retryFailedSegmentsBtn.addEventListener('click', () => {
      webDownloader.retryFailedSegments();
    });
  }

  const runKeygen = async () => {
    if (!keygenPasswordInput || !keygenOutputEl || !keygenStatusEl) return;
    const password = keygenPasswordInput.value.trim();
    if (!password) {
      keygenStatusEl.textContent = '请输入 password1';
      return;
    }
    if (keygenRunBtn) keygenRunBtn.disabled = true;
    keygenStatusEl.textContent = '计算中...';
    try {
      const { scrypt } = await ensureScryptModule();
      const saltRaw = keygenSaltInput?.value || '';
      const saltBytes = saltRaw.trim() ? textEncoder.encode(saltRaw.trim()) : defaultKeygenSalt;
      const derived = await scrypt(textEncoder.encode(password), saltBytes, 16384, 8, 1, 80);
      const dataKey = derived.slice(0, 32);
      const nameKey = derived.slice(32, 64);
      const nameTweak = derived.slice(64, 80);
      const output = [
        'CRYPT_DATA_KEY=' + bytesToHex(dataKey),
        'CRYPT_NAME_KEY=' + bytesToHex(nameKey),
        'CRYPT_NAME_TWEAK=' + bytesToHex(nameTweak),
      ].join('\\n');
      keygenOutputEl.textContent = output;
      keygenStatusEl.textContent = '完成';
    } catch (error) {
      console.error('keygen 失败', error);
      keygenStatusEl.textContent = '生成失败';
    } finally {
      if (keygenRunBtn) keygenRunBtn.disabled = false;
    }
  };

  if (keygenRunBtn) {
    keygenRunBtn.addEventListener('click', runKeygen);
  }

  if (keygenCopyBtn && keygenOutputEl) {
    keygenCopyBtn.addEventListener('click', () => {
      const text = keygenOutputEl.textContent || '';
      if (!text) return;
      copyToClipboard(text, keygenCopyBtn);
    });
  }

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
  const rawWebConfig =
    normalizedOptions.webDownloaderConfig && typeof normalizedOptions.webDownloaderConfig === 'object'
      ? normalizedOptions.webDownloaderConfig
      : null;
  const maxConnectionsValue = rawWebConfig && Number.isFinite(rawWebConfig.maxConnections)
    ? Number(rawWebConfig.maxConnections)
    : null;
  const normalizedWebDownloaderConfig = {
    maxConnections: Number.isFinite(maxConnectionsValue) ? maxConnectionsValue : null,
  };
  const webDownloaderPayload = {
    enabled: normalizedOptions.webDownloader === true,
    isCryptPath: normalizedOptions.isCryptPath === true,
    config: normalizedWebDownloaderConfig,
  };
  const webDownloaderJson = JSON.stringify(webDownloaderPayload).replace(/</g, '\\u003c');

  // Use template and replace placeholders
  return htmlTemplate
    .replace(/\{\{TITLE\}\}/g, title)
    .replace(/\{\{STYLES\}\}/g, cssStyles)
    .replace(/\{\{SECURITY_JSON\}\}/g, securityJson)
    .replace(/\{\{AUTO_REDIRECT\}\}/g, autoRedirectLiteral)
    .replace(/\{\{WEB_DOWNLOADER_JSON\}\}/g, webDownloaderJson)
    .replace(/\{\{SCRIPT\}\}/g, script);
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
