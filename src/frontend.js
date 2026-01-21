import { htmlTemplate } from './templates/landing.html.js';

const escapeHtml = (value = '') =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const normalizeCssEntry = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const url = typeof value.url === 'string' ? value.url.trim() : '';
    if (url) return { type: 'url', value: url };
    const css = typeof value.css === 'string' ? value.css : '';
    if (css.trim()) return { type: 'inline', value: css };
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/[{}]/.test(trimmed)) {
    return { type: 'inline', value: trimmed };
  }
  return { type: 'url', value: trimmed };
};

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
  const pageTitleJson = JSON.stringify(display).replace(/</g, '\\u003c');
  const glueUrl =
    typeof normalizedOptions.glueUrl === 'string' ? normalizedOptions.glueUrl.trim() : '';
  if (!glueUrl) {
    throw new Error('glueUrl is required');
  }
  const htmlUrl =
    typeof normalizedOptions.htmlUrl === 'string' ? normalizedOptions.htmlUrl.trim() : '';
  if (!htmlUrl) {
    throw new Error('htmlUrl is required');
  }
  const commonCssEntry = normalizeCssEntry(normalizedOptions.commonCss);
  if (!commonCssEntry) {
    throw new Error('commonCss is required');
  }
  const commonCssPayload =
    commonCssEntry.type === 'url'
      ? { url: commonCssEntry.value }
      : { css: commonCssEntry.value };
  const commonCssJson = JSON.stringify(commonCssPayload).replace(/</g, '\\u003c');
  const themeCssInput =
    normalizedOptions.themeCss &&
    typeof normalizedOptions.themeCss === 'object' &&
    !Array.isArray(normalizedOptions.themeCss)
      ? normalizedOptions.themeCss
      : {};
  const defaultThemeEntry = normalizeCssEntry(themeCssInput.minimal);
  if (!defaultThemeEntry) {
    throw new Error('themeCss.minimal is required');
  }
  const minimalThemePayload =
    defaultThemeEntry.type === 'url'
      ? { url: defaultThemeEntry.value }
      : { css: defaultThemeEntry.value };
  const themeCssPayload = { ...themeCssInput, minimal: minimalThemePayload };
  const themeCssJson = JSON.stringify(themeCssPayload).replace(/</g, '\\u003c');
  const htmlUrlJson = JSON.stringify(htmlUrl).replace(/</g, '\\u003c');
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
        link: typeof rawAltchaChallenge.link === 'string' ? rawAltchaChallenge.link : '',
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
        link: typeof rawTurnstileBinding.link === 'string' ? rawTurnstileBinding.link : '',
      }
    : null;
  const rawPowdetChallenges = Array.isArray(normalizedOptions.powdetChallenges)
    ? normalizedOptions.powdetChallenges
    : [];
  const normalizedPowdetChallenges = rawPowdetChallenges
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const alg = typeof entry.alg === 'string' ? entry.alg.trim() : '';
      const challenge = typeof entry.challenge === 'string' ? entry.challenge : '';
      const expireRaw = entry.expireAt ?? entry.expiresAt;
      const expireAt = Number.isFinite(expireRaw) ? Number(expireRaw) : Number.parseInt(expireRaw, 10);
      const randomStr = typeof entry.randomStr === 'string' ? entry.randomStr : '';
      const hmac = typeof entry.hmac === 'string' ? entry.hmac : '';
      const link = typeof entry.link === 'string' ? entry.link : '';
      const staticBase = typeof entry.staticBase === 'string' ? entry.staticBase.trim() : '';
      if (!alg || !challenge || !randomStr || !hmac || !Number.isFinite(expireAt)) {
        return null;
      }
      return {
        alg,
        challenge,
        expireAt,
        randomStr,
        hmac,
        link,
        staticBase,
      };
    })
    .filter((entry) => entry);
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
    powdetChallenges: normalizedPowdetChallenges,
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
    clientDecrypt: normalizedOptions.clientDecrypt === true,
    decryptConfig:
      normalizedOptions.decryptConfig && typeof normalizedOptions.decryptConfig === 'object'
        ? normalizedOptions.decryptConfig
        : null,
  };
  const webDownloaderJson = JSON.stringify(webDownloaderPayload).replace(/</g, '\\u003c');

  // Use template and replace placeholders
  return htmlTemplate
    .replace(/\{\{TITLE\}\}/g, title)
    .replace(/\{\{SECURITY_JSON\}\}/g, securityJson)
    .replace(/\{\{AUTO_REDIRECT\}\}/g, autoRedirectLiteral)
    .replace(/\{\{WEB_DOWNLOADER_JSON\}\}/g, webDownloaderJson)
    .replace(/\{\{THEME_CSS_JSON\}\}/g, themeCssJson)
    .replace(/\{\{COMMON_CSS_JSON\}\}/g, commonCssJson)
    .replace(/\{\{HTML_URL_JSON\}\}/g, htmlUrlJson)
    .replace(/\{\{PAGE_TITLE_JSON\}\}/g, pageTitleJson)
    .replace(/\{\{GLUE_URL\}\}/g, escapeHtml(glueUrl));
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
