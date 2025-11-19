/**
 * Landing page CSS styles
 * Design principles: Minimalism + Simplicity (inspired by alist-crypt-worker-client)
 * Theme Architecture: Split into common (layout) and theme-specific (visual) styles
 */

const commonStyles = `
/* ========== Base Styles ========== */
:root {
  color-scheme: dark;
  font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif;
  --theme-transition: 0.3s ease;
}

/* ========== Global Reset ========== */
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  position: relative;
  min-height: 100vh;
}

body::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  transition: all 0.6s ease-out;
  z-index: 0;
}

body::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  transition: all 0.6s ease-out;
}

.visual-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}

header, main {
  position: relative;
  z-index: 1;
}

.web-only {
  display: none;
}

body.web-downloader-active .web-only {
  display: block;
}

.client-only {
  display: none;
}

body.client-decrypt-active .client-only {
  display: block;
}

.mode-shared {
  display: none;
}

body.web-downloader-active .mode-shared,
body.client-decrypt-active .mode-shared {
  display: block;
}

/* ========== Loading Spinner ========== */
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  margin-right: 0.5rem;
  vertical-align: middle;
  animation: spin 0.6s linear infinite;
}

/* ========== Header ========== */
header {
  padding: 1.5rem 1.25rem 0.5rem;
}

h1 {
  margin: 0 0 0.5rem;
  font-size: 1.5rem;
  word-break: break-all;
}

.status {
  margin-bottom: 1rem;
  font-size: 0.95rem;
}

/* ========== Main Content ========== */
main {
  padding: 1.25rem;
  max-width: 720px;
  margin: 0 auto;
}

.metric {
  margin-bottom: 1rem;
}

.metric-label {
  margin-bottom: 0.25rem;
  font-size: 0.9rem;
}

.metric-bar {
  position: relative;
  border-radius: 999px;
  height: 10px;
  overflow: hidden;
}

.metric-bar > span {
  display: block;
  height: 100%;
  width: 0%;
  border-radius: inherit;
  transition: width 0.2s ease;
}

.metric-value {
  margin-top: 0.25rem;
  font-size: 0.85rem;
}

.label {
  margin-bottom: 0.25rem;
  font-size: 0.9rem;
}

/* ========== Turnstile Section ========== */
.turnstile-section {
  margin: 1.5rem 0 0;
}

.turnstile-container {
  display: none;
  padding: 1rem;
  border-radius: 0.75rem;
}

.turnstile-container.is-visible {
  display: block;
}

.turnstile-message {
  margin-top: 0.75rem;
  font-size: 0.85rem;
}

.turnstile-message[hidden] {
  display: none;
}

/* ========== Controls (Buttons) ========== */
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 1.5rem 0;
}

.controls .web-only {
  display: none;
}

body.web-downloader-active .controls .web-only {
  display: inline-flex;
}

button {
  position: relative;
  cursor: pointer;
  border-radius: 0.5rem;
  padding: 0.65rem 1.25rem;
  font-size: 0.95rem;
  font-weight: 600;
  text-align: center;
  transition: background 0.2s ease, transform 0.2s ease, border-color 0.2s ease;
  overflow: hidden;
}

button::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  border-radius: inherit;
}

button:hover:not(:disabled) {
  transform: translateY(-1px);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.client-decrypt {
  position: relative;
  margin: 0 0 1.5rem;
  padding: 1rem 1.25rem;
  border-radius: 1rem;
  transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
}

.client-decrypt[hidden] {
  display: none;
}

.client-decrypt::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  border-radius: inherit;
}

.client-decrypt-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

.client-decrypt-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.35rem;
}

.client-decrypt-desc {
  margin: 0;
  font-size: 0.85rem;
}

.client-decrypt-hints {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-end;
}

.client-decrypt-hint {
  font-size: 0.8rem;
  border-radius: 999px;
  padding: 0.3rem 0.75rem;
  white-space: nowrap;
  border: 1px solid;
}

.client-decrypt-body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.client-decrypt-file {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem 1rem;
  padding: 0.75rem 0.85rem;
  border-radius: 0.75rem;
  overflow: hidden;
}

.client-decrypt-file::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: var(--decrypt-progress, 0%);
  border-radius: inherit;
  transition: width 0.3s ease;
  pointer-events: none;
  z-index: 0;
}

.client-decrypt-file::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  border-radius: inherit;
}

.client-file-name {
  position: relative;
  z-index: 1;
  font-size: 0.95rem;
  word-break: break-all;
  flex: 1;
}

.client-file-size {
  position: relative;
  z-index: 1;
  font-size: 0.8rem;
  white-space: nowrap;
  flex-shrink: 0;
}

.client-save-path {
  position: relative;
  z-index: 1;
  flex-basis: 100%;
  font-size: 0.75rem;
  line-height: 1.5;
  word-break: break-all;
  white-space: pre-line;
}

.client-decrypt-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.client-decrypt-actions button {
  flex: 1 1 160px;
}

/* ========== Advanced Panel ========== */
.advanced-panel {
  position: fixed;
  top: 0;
  right: 0;
  transform: translateX(100%);
  width: 320px;
  max-width: 90vw;
  height: 100%;
  z-index: 30;
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
}

.advanced-close {
  background: transparent;
  border: none;
  font-size: 0.9rem;
  padding: 0.35rem 0.75rem;
  border-radius: 999px;
  cursor: pointer;
  transition: color 0.2s ease, background 0.2s ease;
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

.config-section {
  padding-top: 0.75rem;
}

.config-section-title {
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.retry-label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.9rem;
  margin-bottom: 0.5rem;
}

.retry-hint {
  font-size: 0.8rem;
}

.retry-input {
  width: 100%;
  border-radius: 0.5rem;
  padding: 0.6rem 0.75rem;
  font-size: 0.95rem;
  margin-bottom: 0.75rem;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.retry-input:focus {
  outline: none;
}

.keygen-panel {
  border-radius: 0.75rem;
  padding: 1rem;
}

.keygen-panel h3 {
  margin: 0 0 0.35rem;
  font-size: 0.95rem;
  font-weight: 600;
}

.keygen-hint {
  margin: 0 0 0.75rem;
  font-size: 0.75rem;
  font-style: italic;
}

.keygen-panel label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.85rem;
  margin-bottom: 0.65rem;
}

.keygen-panel input {
  border-radius: 0.5rem;
  padding: 0.5rem 0.65rem;
  font-size: 0.9rem;
}

.keygen-panel input:focus {
  outline: none;
}

.keygen-panel > button {
  width: 100%;
  margin-top: 0.5rem;
  margin-bottom: 0.5rem;
}

.keygen-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  font-size: 0.85rem;
}

.keygen-loading[hidden] {
  display: none;
}

.keygen-status {
  font-size: 0.8rem;
  text-align: center;
  min-height: 1.2rem;
  margin-bottom: 0.75rem;
}

.keygen-output-group {
  display: flex;
  flex-direction: column;
}

.keygen-panel pre {
  margin: 0;
  border-radius: 0.5rem 0.5rem 0 0;
  padding: 0.65rem;
  font-size: 0.75rem;
  line-height: 1.4;
  min-height: 70px;
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'Courier New', Courier, monospace;
}

.keygen-output-group button {
  width: 100%;
  margin-top: 0;
  border-radius: 0 0 0.5rem 0.5rem;
}

/* ========== Log Section ========== */
.log {
  position: relative;
  border-radius: 0.75rem;
  padding: 1rem;
  max-height: 260px;
  overflow-y: auto;
  font-size: 0.85rem;
  line-height: 1.5;
}

.log::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  border-radius: inherit;
}

/* ========== Responsive Design ========== */
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

  .client-decrypt {
    padding: 0.75rem 1rem;
  }

  .client-decrypt-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .client-decrypt-hints {
    align-items: flex-start;
  }
}
`;

const minimalStyles = `
/* ========== Minimal Theme - Visual Styles ========== */

body {
  background: #050607;
  color: #f4f4f8;
}

body::before {
  background:
    radial-gradient(circle at var(--glow-x, 50%) var(--glow-y, 0%), rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), 0.35), transparent 55%),
    radial-gradient(circle at calc(100% - var(--glow-x, 50%)) calc(100% - var(--glow-y, 0%)), rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), 0.2), transparent 55%);
  opacity: var(--breathe-opacity, 1);
}

/* Edge reflections - localized glow with dynamic width and color */
body::after {
  background:
    radial-gradient(ellipse var(--glow-h-width-top, 6.75%) var(--glow-v-height-top, 18px) at var(--glow-x, 50%) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--reflect-top, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--reflect-top, 0) * 0.4)) 40%,
      transparent 70%
    ) top / 100% var(--glow-v-height-top, 18px) no-repeat,
    radial-gradient(ellipse var(--glow-h-width-bottom, 6.75%) var(--glow-v-height-bottom, 18px) at var(--glow-x, 50%) 100%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--reflect-bottom, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--reflect-bottom, 0) * 0.4)) 40%,
      transparent 70%
    ) bottom / 100% var(--glow-v-height-bottom, 18px) no-repeat,
    radial-gradient(ellipse var(--glow-h-width-left, 18px) var(--glow-v-height-left, 6.75%) at 0% var(--glow-y, 0%),
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--reflect-left, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--reflect-left, 0) * 0.4)) 40%,
      transparent 70%
    ) left / var(--glow-h-width-left, 18px) 100% no-repeat,
    radial-gradient(ellipse var(--glow-h-width-right, 18px) var(--glow-v-height-right, 6.75%) at 100% var(--glow-y, 0%),
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--reflect-right, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--reflect-right, 0) * 0.4)) 40%,
      transparent 70%
    ) right / var(--glow-h-width-right, 18px) 100% no-repeat;
}

/* ========== Spinner ========== */
.spinner {
  border: 2px solid #38bdf8;
  border-top-color: transparent;
}

/* ========== Header ========== */
header {
  border-bottom: 1px solid rgba(255,255,255,0.08);
}

.status {
  color: #9ca3af;
}

/* ========== Metrics ========== */
.metric-label {
  color: #9ca3af;
}

.metric-bar {
  background: rgba(255,255,255,0.08);
}

.metric-bar > span {
  background: linear-gradient(90deg, #38bdf8, #22d3ee);
}

.metric-value {
  color: #f8fafc;
}

.label {
  color: #9ca3af;
}

/* ========== Turnstile ========== */
.turnstile-container {
  background: rgba(56,189,248,0.08);
}

.turnstile-message {
  color: #fbbf24;
}

/* ========== Buttons ========== */
button {
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(56,189,248,0.12);
  color: #e0f2fe;
  -webkit-backdrop-filter: blur(8px) saturate(140%);
  backdrop-filter: blur(8px) saturate(140%);
}

/* 按钮边缘辉光效果 - 只照亮边缘线条，不向外扩散 */
button::after {
  background:
    /* 顶部边缘 - 扁平椭圆，紧贴边缘 */
    radial-gradient(ellipse var(--elem-glow-h-width-top, 15%) 1px at var(--elem-glow-x, 50%) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-top, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-top, 0) * 0.3)) 50%,
      transparent 100%
    ) top / 100% 1px no-repeat,
    /* 底部边缘 */
    radial-gradient(ellipse var(--elem-glow-h-width-bottom, 15%) 1px at var(--elem-glow-x, 50%) 100%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-bottom, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-bottom, 0) * 0.3)) 50%,
      transparent 100%
    ) bottom / 100% 1px no-repeat,
    /* 左边缘 */
    radial-gradient(ellipse 1px var(--elem-glow-v-height-left, 15%) at 0% var(--elem-glow-y, 50%),
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-left, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-left, 0) * 0.3)) 50%,
      transparent 100%
    ) left / 1px 100% no-repeat,
    /* 右边缘 */
    radial-gradient(ellipse 1px var(--elem-glow-v-height-right, 15%) at 100% var(--elem-glow-y, 50%),
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-right, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-right, 0) * 0.3)) 50%,
      transparent 100%
    ) right / 1px 100% no-repeat;
}

button:hover:not(:disabled) {
  background: rgba(56,189,248,0.22);
  border-color: rgba(255,255,255,0.2);
}

.controls button.secondary {
  background: rgba(148,163,184,0.10);
  color: #e2e8f0;
}

.controls button.secondary:hover:not(:disabled) {
  background: rgba(148,163,184,0.20);
}

/* ========== Client Decrypt ========== */
.client-decrypt {
  border: 1px solid rgba(56,189,248,0.2);
  background: rgba(15,23,42,0.4);
  -webkit-backdrop-filter: blur(10px) saturate(140%);
  backdrop-filter: blur(10px) saturate(140%);
}

.client-decrypt.is-dropping {
  border-color: rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), 0.7);
  background: rgba(15,23,42,0.6);
  box-shadow:
    0 0 0 2px rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), 0.35),
    0 8px 24px rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), 0.25);
  transform: scale(1.01);
}

/* 离线解密容器边缘辉光效果 */
.client-decrypt::after {
  background:
    radial-gradient(ellipse var(--elem-glow-h-width-top, 15%) 1px at var(--elem-glow-x, 50%) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-top, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-top, 0) * 0.3)) 50%,
      transparent 100%
    ) top / 100% 1px no-repeat,
    radial-gradient(ellipse var(--elem-glow-h-width-bottom, 15%) 1px at var(--elem-glow-x, 50%) 100%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-bottom, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-bottom, 0) * 0.3)) 50%,
      transparent 100%
    ) bottom / 100% 1px no-repeat,
    radial-gradient(ellipse 1px var(--elem-glow-v-height-left, 15%) at 0% var(--elem-glow-y, 50%),
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-left, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-left, 0) * 0.3)) 50%,
      transparent 100%
    ) left / 1px 100% no-repeat,
    radial-gradient(ellipse 1px var(--elem-glow-v-height-right, 15%) at 100% var(--elem-glow-y, 50%),
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-right, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-right, 0) * 0.3)) 50%,
      transparent 100%
    ) right / 1px 100% no-repeat;
}

.client-decrypt-title {
  color: #f8fafc;
}

.client-decrypt-desc {
  color: #cbd5f5;
}

.client-decrypt-hint {
  -webkit-backdrop-filter: blur(8px) saturate(140%);
  backdrop-filter: blur(8px) saturate(140%);
}

.client-decrypt-hint.hint-success {
  color: #38bdf8;
  background: rgba(56,189,248,0.12);
  border-color: rgba(56,189,248,0.3);
}

.client-decrypt-hint.hint-warning {
  color: #fbbf24;
  background: rgba(251,191,36,0.12);
  border-color: rgba(251,191,36,0.3);
  animation: warning-breathe 2.5s ease-in-out infinite;
}

.client-decrypt-hint.hint-success-complete {
  color: #34d399;
  background: rgba(52,211,153,0.12);
  border-color: rgba(52,211,153,0.3);
  animation: success-breathe 2.5s ease-in-out infinite;
}

.client-decrypt-hint.hint-error {
  color: #f87171;
  background: rgba(248,113,113,0.12);
  border-color: rgba(248,113,113,0.3);
  animation: error-breathe 2.5s ease-in-out infinite;
}

@keyframes warning-breathe {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(251,191,36,0);
    border-color: rgba(251,191,36,0.3);
  }
  50% {
    box-shadow: 0 0 12px 2px rgba(251,191,36,0.4);
    border-color: rgba(251,191,36,0.6);
  }
}

@keyframes success-breathe {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(52,211,153,0);
    border-color: rgba(52,211,153,0.3);
  }
  50% {
    box-shadow: 0 0 12px 2px rgba(52,211,153,0.4);
    border-color: rgba(52,211,153,0.6);
  }
}

@keyframes error-breathe {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(248,113,113,0);
    border-color: rgba(248,113,113,0.3);
  }
  50% {
    box-shadow: 0 0 12px 2px rgba(248,113,113,0.4);
    border-color: rgba(248,113,113,0.6);
  }
}

.client-decrypt-file {
  background: rgba(15,23,42,0.7);
  border: 1px solid rgba(148,163,184,0.25);
  -webkit-backdrop-filter: blur(12px) saturate(130%);
  backdrop-filter: blur(12px) saturate(130%);
}

/* 解密进度条 - 透明毛玻璃效果，光斑透过且颜色同步 */
.client-decrypt-file::before {
  background: rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), 0.12);
  -webkit-backdrop-filter: blur(8px) saturate(150%);
  backdrop-filter: blur(8px) saturate(150%);
}

/* 文件信息块边缘辉光效果 */
.client-decrypt-file::after {
  background:
    radial-gradient(ellipse var(--elem-glow-h-width-top, 15%) 1px at var(--elem-glow-x, 50%) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-top, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-top, 0) * 0.3)) 50%,
      transparent 100%
    ) top / 100% 1px no-repeat,
    radial-gradient(ellipse var(--elem-glow-h-width-bottom, 15%) 1px at var(--elem-glow-x, 50%) 100%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-bottom, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-bottom, 0) * 0.3)) 50%,
      transparent 100%
    ) bottom / 100% 1px no-repeat,
    radial-gradient(ellipse 1px var(--elem-glow-v-height-left, 15%) at 0% var(--elem-glow-y, 50%),
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-left, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-left, 0) * 0.3)) 50%,
      transparent 100%
    ) left / 1px 100% no-repeat,
    radial-gradient(ellipse 1px var(--elem-glow-v-height-right, 15%) at 100% var(--elem-glow-y, 50%),
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-right, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-right, 0) * 0.3)) 50%,
      transparent 100%
    ) right / 1px 100% no-repeat;
}

.client-file-name {
  color: #e2e8f0;
}

.client-file-size {
  color: #94a3b8;
}

.client-save-path {
  color: #94a3b8;
}

/* ========== Advanced Panel ========== */
.advanced-panel {
  background: rgba(15,23,42,0.75);
  border-left: 1px solid rgba(148,163,184,0.3);
  box-shadow: -16px 0 32px rgba(15,23,42,0.5);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  backdrop-filter: blur(16px) saturate(150%);
}

.advanced-header h2 {
  color: #f8fafc;
}

.advanced-close {
  color: #94a3b8;
}

.advanced-close:hover {
  color: #f8fafc;
  background: rgba(148,163,184,0.14);
}

.config-section {
  border-top: 1px solid rgba(255,255,255,0.06);
}

.config-section-title {
  color: #e0f2fe;
}

.retry-label {
  color: #e0f2fe;
}

.retry-hint {
  color: #94a3b8;
}

.retry-input {
  background: rgba(15,23,42,0.85);
  border: 1px solid rgba(148,163,184,0.3);
  color: #f1f5f9;
}

.retry-input:focus {
  border-color: rgba(56,189,248,0.6);
  box-shadow: 0 0 0 2px rgba(56,189,248,0.2);
}

.keygen-panel {
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.02);
}

.keygen-panel h3 {
  color: #f8fafc;
}

.keygen-hint {
  color: #94a3b8;
}

.keygen-panel label {
  color: #9ca3af;
}

.keygen-panel input {
  border: 1px solid rgba(148,163,184,0.3);
  background: rgba(15,23,42,0.85);
  color: #f1f5f9;
}

.keygen-panel input:focus {
  border-color: rgba(56,189,248,0.6);
  box-shadow: 0 0 0 2px rgba(56,189,248,0.2);
}

.keygen-loading {
  color: #38bdf8;
}

.keygen-status {
  color: #94a3b8;
}

.keygen-panel pre {
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.06);
  color: #e0f2fe;
}

/* ========== Log Section ========== */
.log {
  background: rgba(15,23,42,0.4);
  border: 1px solid rgba(148,163,184,0.2);
  -webkit-backdrop-filter: blur(12px) saturate(130%);
  backdrop-filter: blur(12px) saturate(130%);
}

/* 事件日志边缘辉光效果 - 只照亮边缘线条，不向外扩散 */
.log::after {
  background:
    radial-gradient(ellipse var(--elem-glow-h-width-top, 15%) 1px at var(--elem-glow-x, 50%) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-top, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-top, 0) * 0.3)) 50%,
      transparent 100%
    ) top / 100% 1px no-repeat,
    radial-gradient(ellipse var(--elem-glow-h-width-bottom, 15%) 1px at var(--elem-glow-x, 50%) 100%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-bottom, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-bottom, 0) * 0.3)) 50%,
      transparent 100%
    ) bottom / 100% 1px no-repeat,
    radial-gradient(ellipse 1px var(--elem-glow-v-height-left, 15%) at 0% var(--elem-glow-y, 50%),
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-left, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-left, 0) * 0.3)) 50%,
      transparent 100%
    ) left / 1px 100% no-repeat,
    radial-gradient(ellipse 1px var(--elem-glow-v-height-right, 15%) at 100% var(--elem-glow-y, 50%),
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), var(--elem-reflect-right, 0)) 0%,
      rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), calc(var(--elem-reflect-right, 0) * 0.3)) 50%,
      transparent 100%
    ) right / 1px 100% no-repeat;
}

/* ========== Fallback for browsers without backdrop-filter ========== */
@supports not (backdrop-filter: blur(8px)) {
  button {
    background: rgba(56,189,248,0.25);
  }

  button:hover:not(:disabled) {
    background: rgba(56,189,248,0.35);
  }

  .controls button.secondary {
    background: rgba(148,163,184,0.22);
  }

  .controls button.secondary:hover:not(:disabled) {
    background: rgba(148,163,184,0.32);
  }

  .advanced-panel {
    background: rgba(15,23,42,0.92);
  }

  .log {
    background: rgba(15,23,42,0.75);
  }

  .client-decrypt {
    background: rgba(15,23,42,0.7);
  }

  .client-decrypt-file {
    background: rgba(15,23,42,0.85);
  }

  .client-decrypt-hint {
    background: rgba(56,189,248,0.25);
  }

  .client-decrypt-file::before {
    background: rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), 0.3);
  }
}
`;

// Export theme CSS object for dynamic theme switching
export const themeCSS = {
  common: commonStyles,
  minimal: minimalStyles,
};

// Backward compatibility: single CSS export
export const cssStyles = commonStyles + minimalStyles;
