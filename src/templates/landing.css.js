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
  background: #0b0b0f;
  color: #f4f4f8;
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

.retry-label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.95rem;
  color: #e0f2fe;
}

.retry-hint {
  font-size: 0.8rem;
  color: #94a3b8;
}

.retry-input {
  background: rgba(15,23,42,0.85);
  border: 1px solid rgba(148,163,184,0.3);
  border-radius: 0.5rem;
  padding: 0.6rem 0.75rem;
  color: #f1f5f9;
  font-size: 0.95rem;
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
  background: rgba(15,23,42,0.6);
  border-radius: 0.75rem;
  padding: 1rem;
  max-height: 260px;
  overflow-y: auto;
  font-size: 0.85rem;
  line-height: 1.5;
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
`;
