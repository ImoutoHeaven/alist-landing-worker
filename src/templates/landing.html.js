/**
 * Landing page HTML template
 * This template uses placeholder variables that will be replaced during rendering:
 * - {{TITLE}} - Page title (escaped filename)
 * - {{COMMON_CSS}} - Common layout CSS (structure)
 * - {{DEFAULT_THEME_CSS}} - Default theme visual CSS
 * - {{THEME_CSS_JSON}} - Theme CSS data (JSON)
 * - {{SECURITY_JSON}} - Security configuration JSON
 * - {{AUTO_REDIRECT}} - Auto redirect boolean
 * - {{WEB_DOWNLOADER_JSON}} - Web downloader configuration JSON
 * - {{SCRIPT}} - Page JavaScript code
 */

export const htmlTemplate = `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
    <title>{{TITLE}}</title>
    <style>{{COMMON_CSS}}</style>
    <style id="theme-css">{{DEFAULT_THEME_CSS}}</style>
    <script src="https://cdn.jsdelivr.net/npm/dexie@3.2.4/dist/dexie.min.js" crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/StreamSaver.min.js" crossorigin="anonymous"></script>
    <script>
      if (window.streamSaver && !window.streamSaver.mitm) {
        window.streamSaver.mitm = 'https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/mitm.html';
      }
    </script>
  </head>
  <body>
    <div id="visual-layer" class="visual-layer"></div>
    <header>
      <h1 id="fileName">{{TITLE}}</h1>
      <div class="status" id="status">准备就绪</div>
    </header>
    <main>
      <section class="metric web-only">
        <div class="metric-label">下载进度</div>
        <div class="metric-bar"><span id="downloadBar"></span></div>
        <div class="metric-value" id="downloadText">0%</div>
      </section>
      <section class="metric web-only">
        <div class="metric-label">解密进度</div>
        <div class="metric-bar"><span id="decryptBar"></span></div>
        <div class="metric-value" id="decryptText">0%</div>
      </section>
      <section class="turnstile-section" id="turnstileSection">
        <div id="turnstileContainer" class="turnstile-container" hidden></div>
        <div id="turnstileMessage" class="turnstile-message" hidden></div>
      </section>
      <div class="status web-only">当前速度：<span id="speedText">--</span></div>
      <div class="controls">
        <button id="downloadBtn" disabled><span class="spinner"></span>加载中</button>
        <button id="cancelBtn" class="web-only" disabled>取消</button>
        <button id="retryBtn" disabled>重试</button>
        <button id="advancedToggle" class="secondary" type="button">高级选项</button>
      </div>
      <section class="client-decrypt" id="clientDecryptSection" hidden>
        <div class="client-decrypt-header">
          <div>
            <div class="client-decrypt-title">本地解密</div>
            <p class="client-decrypt-desc">使用 IDM/aria2 等工具完成密文下载后，将文件导入此处即可完成解密。</p>
          </div>
          <div class="client-decrypt-hints">
            <div class="client-decrypt-hint hint-success">解密密钥已获取</div>
            <div class="client-decrypt-hint hint-warning" id="clientDecryptStatusHint">需要本地解密</div>
          </div>
        </div>
        <div class="client-decrypt-body">
          <div class="client-decrypt-file">
            <div class="client-file-name" id="clientDecryptFileName">尚未选择文件</div>
            <div class="client-file-size" id="clientDecryptFileSize">--</div>
            <div class="client-save-path" id="clientDecryptSavePath"></div>
          </div>
          <div class="client-decrypt-actions">
            <button id="clientDecryptSelect" type="button">选择密文文件</button>
            <button id="clientDecryptStart" type="button" disabled>开始解密</button>
            <button id="clientDecryptCancel" type="button" class="secondary" hidden>取消解密</button>
          </div>
          <input id="clientDecryptFileInput" type="file" hidden>
        </div>
      </section>
      <aside id="advancedPanel" class="advanced-panel" aria-hidden="true">
        <div class="advanced-header">
          <h2>高级选项</h2>
          <button id="advancedCloseBtn" type="button" class="advanced-close">关闭</button>
        </div>
        <div class="advanced-body">
          <div class="advanced-actions">
            <button id="clearCacheBtn" disabled>清理缓存</button>
            <button id="retryFailedSegmentsBtn" class="web-only" disabled>重试失败片段</button>
            <button id="clearEnvBtn" class="web-only" disabled>清理所有任务</button>
          </div>
          <div class="config-section web-only">
            <div class="config-section-title">下载配置</div>
            <label class="retry-label" for="connectionLimitInput">
              最大打开连接数
              <span class="retry-hint">范围 1-32，默认 16</span>
            </label>
            <input id="connectionLimitInput" class="retry-input" type="number" inputmode="numeric" autocomplete="off" min="1" max="32" value="16">
            <label class="retry-label" for="ttfbTimeoutInput">
              TTFB 超时 (秒)
              <span class="retry-hint">等待首字节超时，默认 20 秒</span>
            </label>
            <input id="ttfbTimeoutInput" class="retry-input" type="number" inputmode="numeric" autocomplete="off" min="5" max="120" value="20">
            <label class="retry-label" for="retryLimitInput">
              分段重试次数
              <span class="retry-hint">支持正整数或 inf（无限重试）</span>
            </label>
            <input id="retryLimitInput" class="retry-input" type="text" inputmode="numeric" autocomplete="off" value="30">
          </div>
          <div class="config-section mode-shared">
            <div class="config-section-title">分段配置</div>
            <label class="retry-label" for="segmentSizeInput">
              分段大小 (MB)
              <span class="retry-hint">范围 2-48 MB，默认 32 MB</span>
            </label>
            <input id="segmentSizeInput" class="retry-input" type="number" inputmode="numeric" autocomplete="off" min="2" max="48" value="32">
          </div>
          <div class="config-section client-only">
            <div class="config-section-title">解密配置</div>
            <label class="retry-label" for="parallelLimitInput">
              并行解密线程数
              <span class="retry-hint">范围 1-32，默认 6</span>
            </label>
            <input id="parallelLimitInput" class="retry-input" type="number" inputmode="numeric" autocomplete="off" min="1" max="32" value="6">
          </div>
          <div class="config-section client-only">
            <div class="config-section-title">保存方式</div>
            <label class="retry-label" for="saveModeSelect">
              保存策略
              <span class="retry-hint">自动模式会根据浏览器能力选择最优方式</span>
            </label>
            <select id="saveModeSelect" class="retry-input">
              <option value="auto">Auto（推荐）</option>
              <option value="fs">FS（文件系统访问）</option>
              <option value="opfs">OPFS（浏览器内临时文件）</option>
              <option value="stream">Stream（StreamSaver）</option>
              <option value="memstream">MemStream（内存流）</option>
              <option value="memory">Memory（纯内存）</option>
            </select>
          </div>
          <div class="keygen-panel mode-shared">
            <h3>crypt keygen</h3>
            <p class="keygen-hint">仅供开发者使用 :)</p>
            <label>
              password1
              <input id="keygenPassword" type="password" autocomplete="off" />
            </label>
            <label>
              password2 (可选)
              <input id="keygenSalt" type="text" autocomplete="off" />
            </label>
            <button id="keygenRun" type="button">生成密钥</button>
            <div class="keygen-loading" id="keygenLoading" hidden>
              <span class="spinner"></span>
              <span>计算中...</span>
            </div>
            <span id="keygenStatus" class="keygen-status"></span>
            <div class="keygen-output-group">
              <pre id="keygenOutput"></pre>
              <button id="keygenCopy" type="button">复制结果</button>
            </div>
          </div>
        </div>
      </aside>
      <div id="advancedBackdrop" class="advanced-backdrop" hidden></div>
      <section>
        <div class="label">事件日志</div>
        <div class="log" id="log"></div>
      </section>
    </main>
    <script>
      window.__ALIST_SECURITY__ = {{SECURITY_JSON}};
      window.__AUTO_REDIRECT__ = {{AUTO_REDIRECT}};
      window.__WEB_DOWNLOADER_PROPS__ = {{WEB_DOWNLOADER_JSON}};
      window.__THEME_CSS__ = {{THEME_CSS_JSON}};
    </script>
    <script type="module">
      {{SCRIPT}}
    </script>
  </body>
</html>`;
