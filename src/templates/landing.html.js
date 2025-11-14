/**
 * Landing page HTML template
 * This template uses placeholder variables that will be replaced during rendering:
 * - {{TITLE}} - Page title (escaped filename)
 * - {{STYLES}} - CSS styles
 * - {{SECURITY_JSON}} - Security configuration JSON
 * - {{AUTO_REDIRECT}} - Auto redirect boolean
 * - {{SCRIPT}} - Page JavaScript code
 */

export const htmlTemplate = `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
    <title>{{TITLE}}</title>
    <style>{{STYLES}}</style>
    <script src="https://cdn.jsdelivr.net/npm/dexie@3.2.4/dist/dexie.min.js" crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js" crossorigin="anonymous"></script>
  </head>
  <body>
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
          <label class="retry-label web-only" for="retryLimitInput">
            分段重试次数
            <span class="retry-hint">支持正整数或 inf（无限重试）</span>
          </label>
          <input id="retryLimitInput" class="retry-input web-only" type="text" inputmode="numeric" autocomplete="off" value="10">
          <label class="retry-label web-only" for="parallelLimitInput">
            并行解密线程数
            <span class="retry-hint">范围 1-32，默认 6</span>
          </label>
          <input id="parallelLimitInput" class="retry-input web-only" type="number" inputmode="numeric" autocomplete="off" min="1" max="32" value="6">
          <label class="retry-label web-only" for="connectionLimitInput">
            最大打开连接数
            <span class="retry-hint">范围 1-16，默认 4</span>
          </label>
          <input id="connectionLimitInput" class="retry-input web-only" type="number" inputmode="numeric" autocomplete="off" min="1" max="16" value="4">
          <div class="keygen-panel web-only">
            <h3>crypt keygen</h3>
            <label>
              password1
              <input id="keygenPassword" type="password" autocomplete="off" />
            </label>
            <label>
              password2 (可选)
              <input id="keygenSalt" type="text" autocomplete="off" />
            </label>
            <button id="keygenRun" type="button">生成密钥</button>
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
    </script>
    <script type="module">
      {{SCRIPT}}
    </script>
  </body>
</html>`;
