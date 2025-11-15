/**
 * Landing page CSS styles
 * Design principles: Minimalism + Simplicity (inspired by alist-crypt-worker-client)
 */

export const cssStyles = `
/* ========== Base Styles ========== */
:root {
  color-scheme: dark;
  font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif;
}

/* ========== Global Reset ========== */
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  position: relative;
  background: #050607;
  min-height: 100vh;
  color: #f4f4f8;
}

body::before {
  content: '';
  position: fixed;
  inset: 0;
  background:
    radial-gradient(circle at var(--glow-x, 50%) var(--glow-y, 0%), rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), 0.35), transparent 55%),
    radial-gradient(circle at calc(100% - var(--glow-x, 50%)) calc(100% - var(--glow-y, 0%)), rgba(var(--glow-r, 62), var(--glow-g, 110), var(--glow-b, 255), 0.2), transparent 55%);
  pointer-events: none;
  opacity: var(--breathe-opacity, 1);
  transition: all 0.6s ease-out;
  z-index: 0;
}

/* Edge reflections - localized glow with dynamic width and color */
body::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
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
  transition: all 0.6s ease-out;
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

/* ========== Loading Spinner ========== */
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid #38bdf8;
  border-top-color: transparent;
  border-radius: 999px;
  animation: spin 0.6s linear infinite;
  margin-right: 0.5rem;
  vertical-align: middle;
}

/* ========== Header ========== */
header {
  padding: 1.5rem 1.25rem 0.5rem;
  border-bottom: 1px solid rgba(255,255,255,0.08);
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
  color: #9ca3af;
}

.metric-bar {
  position: relative;
  background: rgba(255,255,255,0.08);
  border-radius: 999px;
  height: 10px;
  overflow: hidden;
}

.metric-bar > span {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #38bdf8, #22d3ee);
  width: 0%;
  border-radius: inherit;
  transition: width 0.2s ease;
}

.metric-value {
  margin-top: 0.25rem;
  font-size: 0.85rem;
  color: #f8fafc;
}

.label {
  margin-bottom: 0.25rem;
  font-size: 0.9rem;
  color: #9ca3af;
}

/* ========== Turnstile Section ========== */
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
  cursor: pointer;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 0.5rem;
  padding: 0.65rem 1.25rem;
  font-size: 0.95rem;
  font-weight: 600;
  background: rgba(56,189,248,0.12);
  color: #e0f2fe;
  text-align: center;
  -webkit-backdrop-filter: blur(8px) saturate(140%);
  backdrop-filter: blur(8px) saturate(140%);
  transition: background 0.2s ease, transform 0.2s ease, border-color 0.2s ease;
}

button:hover:not(:disabled) {
  background: rgba(56,189,248,0.22);
  border-color: rgba(255,255,255,0.2);
  transform: translateY(-1px);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.controls button.secondary {
  background: rgba(148,163,184,0.10);
  color: #e2e8f0;
}

.controls button.secondary:hover:not(:disabled) {
  background: rgba(148,163,184,0.20);
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
  background: rgba(15,23,42,0.75);
  border-left: 1px solid rgba(148,163,184,0.3);
  box-shadow: -16px 0 32px rgba(15,23,42,0.5);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  backdrop-filter: blur(16px) saturate(150%);
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
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
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

.config-section {
  padding-top: 0.75rem;
  border-top: 1px solid rgba(255,255,255,0.06);
}

.config-section-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: #e0f2fe;
  margin-bottom: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.retry-label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.9rem;
  color: #e0f2fe;
  margin-bottom: 0.5rem;
}

.retry-hint {
  font-size: 0.8rem;
  color: #94a3b8;
}

.retry-input {
  width: 100%;
  background: rgba(15,23,42,0.85);
  border: 1px solid rgba(148,163,184,0.3);
  border-radius: 0.5rem;
  padding: 0.6rem 0.75rem;
  color: #f1f5f9;
  font-size: 0.95rem;
  margin-bottom: 0.75rem;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.retry-input:focus {
  outline: none;
  border-color: rgba(56,189,248,0.6);
  box-shadow: 0 0 0 2px rgba(56,189,248,0.2);
}

.keygen-panel {
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 0.75rem;
  padding: 1rem;
  background: rgba(255,255,255,0.02);
}

.keygen-panel h3 {
  margin: 0 0 0.75rem;
  font-size: 0.95rem;
  font-weight: 600;
  color: #f8fafc;
}

.keygen-panel label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.85rem;
  color: #9ca3af;
  margin-bottom: 0.65rem;
}

.keygen-panel input {
  border: 1px solid rgba(148,163,184,0.3);
  border-radius: 0.5rem;
  padding: 0.5rem 0.65rem;
  background: rgba(15,23,42,0.85);
  color: #f1f5f9;
  font-size: 0.9rem;
}

.keygen-panel input:focus {
  outline: none;
  border-color: rgba(56,189,248,0.6);
  box-shadow: 0 0 0 2px rgba(56,189,248,0.2);
}

.keygen-panel > button {
  width: 100%;
  margin-top: 0.5rem;
  margin-bottom: 0.75rem;
}

.keygen-status {
  font-size: 0.8rem;
  color: #94a3b8;
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
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.06);
  padding: 0.65rem;
  font-size: 0.75rem;
  line-height: 1.4;
  min-height: 70px;
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: #e0f2fe;
  font-family: 'Courier New', Courier, monospace;
}

.keygen-output-group button {
  width: 100%;
  margin-top: 0;
  border-radius: 0 0 0.5rem 0.5rem;
}

/* ========== Log Section ========== */
.log {
  background: rgba(15,23,42,0.4);
  border: 1px solid rgba(148,163,184,0.2);
  border-radius: 0.75rem;
  padding: 1rem;
  max-height: 260px;
  overflow-y: auto;
  font-size: 0.85rem;
  line-height: 1.5;
  -webkit-backdrop-filter: blur(12px) saturate(130%);
  backdrop-filter: blur(12px) saturate(130%);
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
}
`;
