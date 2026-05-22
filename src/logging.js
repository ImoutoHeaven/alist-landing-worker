const REDACTED = '[redacted]';
const OMIT_FIELD = Symbol('omit-log-field');

const SENSITIVE_KEY_PATTERN = /(^|_)?(authorization|api[-_]?key|secret|token|payload|preimage|nonce|binding|mac|signature|challenge|cdata)(_|$)?/i;
const IP_KEY_PATTERN = /(^|_)?(ip|clientip|client[-_]?ip|remote[-_]?addr|address|cidr)(_|$)?/i;
const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/\d{1,2})?\b/g;
const IPV6_PATTERN = /\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}(?:\/\d{1,3})?\b|\b(?:[a-f0-9]{1,4}:){1,7}:(?:[a-f0-9]{1,4})?(?:\/\d{1,3})?\b/gi;
const QUERY_URL_PATTERN = /\bhttps?:\/\/[^\s]+\?[^\s]+/gi;
const AUTHORIZATION_PATTERN = /\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const JSON_STRING_FIELD_PATTERN = /(["'])([^"']+)\1\s*:\s*(["'])(?:\\.|(?!\3).)*\3/g;
const JSON_PRIMITIVE_FIELD_PATTERN = /(["'])([^"']+)\1\s*:\s*(?!["'])[^,}\]\s]+/g;
const ASSIGNMENT_FIELD_PATTERN = /\b([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*([^\s,;]+)/g;

function normalizeKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function shouldOmitKey(key) {
  return IP_KEY_PATTERN.test(String(key)) || /^(ip|clientip|remoteaddr|cidr)$/.test(normalizeKey(key));
}

function shouldRedactKey(key) {
  return SENSITIVE_KEY_PATTERN.test(String(key));
}

function errorToObject(error) {
  return {
    name: error.name,
    message: error.message,
  };
}

export function sanitizeLogStructuredValue(value) {
  return sanitizeStructuredValue(value, undefined, new WeakSet());
}

function sanitizeStructuredValue(value, key, seen) {
  if (key !== undefined && shouldOmitKey(key)) {
    return OMIT_FIELD;
  }

  if (key !== undefined && shouldRedactKey(key)) {
    return REDACTED;
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeLogValue(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return REDACTED;
  }

  if (value instanceof Error) {
    return sanitizeStructuredValue(errorToObject(value), key, seen);
  }

  if (seen.has(value)) {
    return REDACTED;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeStructuredValue(item, undefined, seen))
      .filter((item) => item !== OMIT_FIELD);
  }

  const clone = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const sanitized = sanitizeStructuredValue(entryValue, entryKey, seen);
    if (sanitized !== OMIT_FIELD) {
      clone[entryKey] = sanitized;
    }
  }
  return clone;
}

export function sanitizeLogValue(value) {
  try {
    if (value === null || value === undefined) {
      return String(value);
    }
    if (value instanceof Error) {
      return sanitizeLogValue(value.message);
    }
    const text = typeof value === 'string' ? value : JSON.stringify(sanitizeLogStructuredValue(value));
    return String(text)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(QUERY_URL_PATTERN, (url) => `${url.split('?')[0]}?${REDACTED}`)
      .replace(AUTHORIZATION_PATTERN, `Authorization: ${REDACTED}`)
      .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
      .replace(JSON_STRING_FIELD_PATTERN, (match, quote, key, valueQuote) => (shouldRedactKey(key) ? `${quote}${key}${quote}:${valueQuote}${REDACTED}${valueQuote}` : match))
      .replace(JSON_PRIMITIVE_FIELD_PATTERN, (match, quote, key) => (shouldRedactKey(key) ? `${quote}${key}${quote}:${REDACTED}` : match))
      .replace(ASSIGNMENT_FIELD_PATTERN, (match, key) => (shouldRedactKey(key) ? `${key}=${REDACTED}` : match))
      .replace(IPV4_PATTERN, REDACTED)
      .replace(IPV6_PATTERN, REDACTED)
      .trim();
  } catch {
    return REDACTED;
  }
}

function formatFieldValue(value) {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'string') {
    return sanitizeLogValue(value);
  }
  return sanitizeLogValue(JSON.stringify(value));
}

function formatLogLine(component, event, fields) {
  const sanitizedFields = sanitizeLogStructuredValue(fields);
  const parts = [`[${sanitizeLogValue(component)}]`, sanitizeLogValue(event)];
  if (sanitizedFields && typeof sanitizedFields === 'object' && !Array.isArray(sanitizedFields)) {
    for (const [key, value] of Object.entries(sanitizedFields)) {
      parts.push(`${sanitizeLogValue(key)}=${formatFieldValue(value)}`);
    }
  }
  return parts.join(' ');
}

export function logEvent(level, component, event, fields = {}) {
  try {
    const line = formatLogLine(component, event, fields);
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[method](line);
  } catch {
    // Logging must never change runtime behavior.
  }
}

function describeReason(reason) {
  if (reason instanceof Error) {
    return reason.message;
  }
  return reason;
}

export function bindWaitUntil(ctx, promise, component, event, fields = {}) {
  const trackedPromise = Promise.resolve(promise).then(
    (value) => {
      logEvent('log', component, `${event}_done`, fields);
      return value;
    },
    (reason) => {
      logEvent('error', component, `${event}_failed`, {
        ...fields,
        error: describeReason(reason),
      });
      throw reason;
    },
  );

  if (ctx && typeof ctx.waitUntil === 'function') {
    logEvent('log', component, `${event}_bound`, fields);
    ctx.waitUntil(trackedPromise);
  } else {
    logEvent('warn', component, `${event}_inline`, fields);
  }

  return trackedPromise;
}
