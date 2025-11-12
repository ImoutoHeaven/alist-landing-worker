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
  </head>
  <body>
    <header>
      <h1 id="fileName">{{TITLE}}</h1>
      <div class="status" id="status">准备就绪</div>
    </header>
    <main>
      <section class="turnstile-section" id="turnstileSection">
        <div id="turnstileContainer" class="turnstile-container" hidden></div>
        <div id="turnstileMessage" class="turnstile-message" hidden></div>
      </section>
      <div class="controls">
        <button id="downloadBtn" disabled><span class="spinner"></span>加载中</button>
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
      window.__ALIST_SECURITY__ = {{SECURITY_JSON}};
      window.__AUTO_REDIRECT__ = {{AUTO_REDIRECT}};
    </script>
    <script type="module">
      {{SCRIPT}}
    </script>
  </body>
</html>`;
