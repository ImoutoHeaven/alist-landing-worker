/**
 * Landing page HTML template
 * This template uses placeholder variables that will be replaced during rendering:
 * - {{TITLE}} - Page title (escaped filename)
 * - {{SECURITY_JSON}} - Security configuration JSON
 * - {{AUTO_REDIRECT}} - Auto redirect boolean
 * - {{WEB_DOWNLOADER_JSON}} - Web downloader configuration JSON
 * - {{THEME_CSS_JSON}} - Theme CSS data (JSON)
 * - {{COMMON_CSS_JSON}} - Common CSS data (JSON)
 * - {{HTML_URL_JSON}} - Landing HTML URL (JSON)
 * - {{PAGE_TITLE_JSON}} - Page title for JS (JSON)
 * - {{GLUE_URL}} - Frontend module URL
 */

export const htmlTemplate = `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
    <title>{{TITLE}}</title>
    <script src="https://cdn.jsdelivr.net/npm/dexie@3.2.4/dist/dexie.min.js" crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/StreamSaver.min.js" crossorigin="anonymous"></script>
    <script>
      if (window.streamSaver && !window.streamSaver.mitm) {
        window.streamSaver.mitm = 'https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/mitm.html';
      }
    </script>
  </head>
  <body>
    <script>
      window.__ALIST_SECURITY__ = {{SECURITY_JSON}};
      window.__AUTO_REDIRECT__ = {{AUTO_REDIRECT}};
      window.__WEB_DOWNLOADER_PROPS__ = {{WEB_DOWNLOADER_JSON}};
      window.__THEME_CSS__ = {{THEME_CSS_JSON}};
      window.__COMMON_CSS__ = {{COMMON_CSS_JSON}};
      window.__LANDING_HTML_URL__ = {{HTML_URL_JSON}};
      window.__PAGE_TITLE__ = {{PAGE_TITLE_JSON}};
    </script>
    <script type="module" src="{{GLUE_URL}}"></script>
  </body>
</html>`;
