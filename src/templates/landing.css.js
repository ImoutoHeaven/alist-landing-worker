/**
 * Landing page CSS styles
 * Design principles: Minimalism + Smooth animations
 */

export const cssStyles = `
/* ========== CSS Variables ========== */
:root {
  color-scheme: dark;

  /* Typography */
  --font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif;
  --font-size-base: 16px;
  --font-size-sm: 0.875rem;
  --font-size-xs: 0.75rem;
  --font-size-lg: 1.125rem;
  --font-size-xl: 1.5rem;
  --line-height-base: 1.6;
  --line-height-tight: 1.4;

  /* Spacing */
  --spacing-xs: 0.5rem;
  --spacing-sm: 0.75rem;
  --spacing-md: 1rem;
  --spacing-lg: 1.5rem;
  --spacing-xl: 2rem;

  /* Colors */
  --color-bg: #0b0b0f;
  --color-surface: rgba(15, 23, 42, 0.6);
  --color-surface-elevated: rgba(15, 23, 42, 0.95);
  --color-text-primary: #f4f4f8;
  --color-text-secondary: #9ca3af;
  --color-text-tertiary: #6b7280;
  --color-border: rgba(255, 255, 255, 0.08);
  --color-border-strong: rgba(148, 163, 184, 0.16);

  /* Accent colors */
  --color-accent: #38bdf8;
  --color-accent-subtle: rgba(56, 189, 248, 0.18);
  --color-accent-hover: rgba(56, 189, 248, 0.28);
  --color-accent-border: rgba(56, 189, 248, 0.3);
  --color-warning: #fbbf24;

  /* Shadows (subtle, minimalist) */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.12);
  --shadow-md: 0 4px 8px rgba(0, 0, 0, 0.16);
  --shadow-lg: 0 12px 24px rgba(0, 0, 0, 0.24);
  --shadow-panel: -16px 0 32px rgba(15, 23, 42, 0.5);

  /* Border radius */
  --radius-sm: 0.375rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-full: 9999px;

  /* Transitions (smooth easing) */
  --transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-base: 250ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-slow: 350ms cubic-bezier(0.4, 0, 0.2, 1);

  /* Backdrop blur */
  --blur-sm: blur(4px);
  --blur-md: blur(8px);
}

/* ========== Global Reset ========== */
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
  background: var(--color-bg);
  color: var(--color-text-primary);
  font-family: var(--font-family);
  font-size: var(--font-size-base);
  line-height: var(--line-height-base);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* ========== Loading Spinner ========== */
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--color-accent);
  border-top-color: transparent;
  border-radius: var(--radius-full);
  animation: spin 0.6s linear infinite;
  margin-right: var(--spacing-xs);
  vertical-align: middle;
}

/* ========== Header ========== */
header {
  padding: var(--spacing-lg) var(--spacing-md) var(--spacing-sm);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
}

h1 {
  margin: 0 0 var(--spacing-xs);
  font-size: var(--font-size-xl);
  font-weight: 600;
  word-break: break-all;
  letter-spacing: -0.02em;
  line-height: var(--line-height-tight);
}

.status {
  margin: var(--spacing-xs) 0 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  transition: color var(--transition-base);
}

/* ========== Main Content ========== */
main {
  padding: var(--spacing-lg) var(--spacing-md);
  max-width: 720px;
  margin: 0 auto;
}

/* ========== Turnstile Section ========== */
.turnstile-section {
  margin: var(--spacing-lg) 0 0;
}

.turnstile-container {
  display: none;
  padding: var(--spacing-md);
  background: var(--color-accent-subtle);
  border: 1px solid var(--color-accent-border);
  border-radius: var(--radius-lg);
  transition: all var(--transition-base);
}

.turnstile-container.is-visible {
  display: block;
  animation: fadeIn var(--transition-slow);
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.turnstile-message {
  margin-top: var(--spacing-sm);
  font-size: var(--font-size-sm);
  color: var(--color-warning);
  font-weight: 500;
}

.turnstile-message[hidden] {
  display: none;
}

/* ========== Controls (Buttons) ========== */
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
  margin: var(--spacing-lg) 0;
}

button {
  position: relative;
  cursor: pointer;
  border: none;
  border-radius: var(--radius-md);
  padding: 0.65rem 1.25rem;
  font-size: var(--font-size-sm);
  font-weight: 600;
  font-family: inherit;
  background: var(--color-accent-subtle);
  color: #e0f2fe;
  transition: all var(--transition-base);
  white-space: nowrap;
  overflow: hidden;
  box-shadow: var(--shadow-sm);
}

button:hover:not(:disabled) {
  background: var(--color-accent-hover);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

button:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: var(--shadow-sm);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

button.secondary {
  background: rgba(148, 163, 184, 0.16);
  color: #e2e8f0;
}

button.secondary:hover:not(:disabled) {
  background: rgba(148, 163, 184, 0.28);
}

/* Click ripple effect */
@keyframes ripple {
  to {
    transform: scale(4);
    opacity: 0;
  }
}

button::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 20px;
  height: 20px;
  background: rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-full);
  transform: translate(-50%, -50%) scale(0);
  pointer-events: none;
}

button:active:not(:disabled)::after {
  animation: ripple 0.6s ease-out;
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
  background: var(--color-surface-elevated);
  border-left: 1px solid var(--color-border-strong);
  box-shadow: var(--shadow-panel);
  backdrop-filter: var(--blur-md);
  transition: transform var(--transition-slow);
  display: flex;
  flex-direction: column;
  padding: var(--spacing-lg) var(--spacing-md);
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
  background: rgba(15, 23, 42, 0.55);
  backdrop-filter: var(--blur-sm);
  z-index: 20;
  opacity: 0;
  transition: opacity var(--transition-base);
  pointer-events: none;
}

.advanced-backdrop:not([hidden]) {
  opacity: 1;
  pointer-events: auto;
}

.advanced-backdrop[hidden] {
  display: none;
}

.advanced-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-md);
}

.advanced-header h2 {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: #f8fafc;
}

.advanced-close {
  background: transparent;
  border: none;
  color: #94a3b8;
  font-size: var(--font-size-sm);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: all var(--transition-base);
  box-shadow: none;
}

.advanced-close:hover {
  color: #f8fafc;
  background: rgba(148, 163, 184, 0.14);
}

.advanced-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  overflow-y: auto;
}

.advanced-actions {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.advanced-actions button {
  width: 100%;
}

/* ========== Log Section ========== */
.log {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--spacing-md);
  max-height: 260px;
  overflow-y: auto;
  font-size: var(--font-size-sm);
  line-height: 1.5;
  color: var(--color-text-secondary);
}

.log::-webkit-scrollbar {
  width: 6px;
}

.log::-webkit-scrollbar-track {
  background: transparent;
}

.log::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.3);
  border-radius: var(--radius-sm);
}

.log::-webkit-scrollbar-thumb:hover {
  background: rgba(148, 163, 184, 0.5);
}

.log > div {
  padding: var(--spacing-xs) 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.log > div:last-child {
  border-bottom: none;
}

/* ========== Responsive Design ========== */
@media (max-width: 600px) {
  main {
    padding: var(--spacing-sm);
  }

  header {
    padding: var(--spacing-md) var(--spacing-sm) var(--spacing-xs);
  }

  h1 {
    font-size: var(--font-size-lg);
  }

  .controls {
    flex-direction: column;
  }

  button {
    width: 100%;
  }

  .advanced-panel {
    width: 100%;
    padding: var(--spacing-md);
  }
}

/* ========== Accessibility ========== */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* Focus visible for keyboard navigation */
button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.advanced-close:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
`;
