const REDACTED = '[redacted]';

const SENSITIVE_KEY_PATTERN = /(?:authorization|bearer|token|secret|signature|sign|payload|challenge|preimage|nonce|dataKey|baseNonce)/i;
const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const IPV6_PATTERN = /\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE_SECRET_PATTERN = /\b(?:authorization|token|secret|signature|sign|payload|challenge|preimage|nonce|dataKey|baseNonce)=([^\s&]+)/gi;
const URL_WITH_QUERY_PATTERN = /\bhttps?:\/\/[^\s?#]+\?[^\s]+/gi;

function sanitizeString(value) {
  return String(value)
    .replace(URL_WITH_QUERY_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, REDACTED)
    .replace(KEY_VALUE_SECRET_PATTERN, (match) => {
      const key = match.split('=')[0];
      return `${key}=${REDACTED}`;
    })
    .replace(IPV4_PATTERN, REDACTED)
    .replace(IPV6_PATTERN, REDACTED)
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

function sanitizeValue(value, key = '') {
  if (value === null || value === undefined) return value;
  if (/^(error|reason)$/i.test(key)) {
    if (value instanceof Error) return sanitizeString(value.message || value.name || 'Error');
    if (typeof value === 'string') return sanitizeString(value);
    if (value && typeof value === 'object' && typeof value.message === 'string') {
      return sanitizeString(value.message);
    }
    return REDACTED;
  }
  if (SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;
  if (value instanceof Error) return sanitizeString(value.message || value.name || 'Error');
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
  if (typeof value === 'object') {
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = sanitizeValue(entryValue, entryKey);
    }
    return output;
  }
  return sanitizeString(value);
}

function formatValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function formatFields(fields) {
  return Object.entries(sanitizeValue(fields) || {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
}

export function landingLogEvent(level, event, fields = {}) {
  try {
    const safeEvent = sanitizeString(event || 'event').replace(/\s+/g, '_') || 'event';
    const suffix = formatFields(fields);
    const line = `[Landing] ${safeEvent}${suffix ? ` ${suffix}` : ''}`;
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  } catch {
    // Logging must never affect landing page behavior.
  }
}
