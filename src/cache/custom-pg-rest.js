import { sha256Hash, applyVerifyHeaders, hasVerifyCredentials } from '../utils.js';
import { logEvent } from '../logging.js';

const executeQuery = async (postgrestUrl, verifyHeader, verifySecret, tableName, method, filters = '', body = null, extraHeaders = {}) => {
  const url = `${postgrestUrl}/${tableName}${filters ? `?${filters}` : ''}`;

  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  applyVerifyHeaders(headers, verifyHeader, verifySecret);

  const options = {
    method,
    headers,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 404 && errorText.includes('PGRST205')) {
      throw new Error(
        `PostgREST table "${tableName}" not found. Ensure filesize cache schema is deployed (see init.sql).`
      );
    }
    throw new Error(`PostgREST API error (${response.status}): ${errorText}`);
  }

  let result = [];
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    result = await response.json();
  }

  const contentRange = response.headers.get('content-range');
  let affectedRows = 0;
  if (contentRange) {
    const match = contentRange.match(/(\d+)-(\d+)|\*\/(\d+)/);
    if (match) {
      if (match[1] !== undefined && match[2] !== undefined) {
        affectedRows = parseInt(match[2], 10) - parseInt(match[1], 10) + 1;
      } else if (match[3] !== undefined) {
        affectedRows = parseInt(match[3], 10);
      }
    }
  } else if (method === 'POST' && response.status === 201) {
    affectedRows = Array.isArray(result) ? result.length : 1;
  } else if (method === 'DELETE' || method === 'PATCH') {
    affectedRows = Array.isArray(result) ? result.length : 0;
  }

  return {
    data: Array.isArray(result) ? result : [],
    affectedRows,
  };
};

const callRpc = async (postgrestUrl, verifyHeader, verifySecret, rpcName, payload) => {
  const rpcUrl = `${postgrestUrl}/rpc/${rpcName}`;
  const headers = { 'Content-Type': 'application/json' };
  applyVerifyHeaders(headers, verifyHeader, verifySecret);

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PostgREST RPC ${rpcName} failed (${response.status}): ${errorText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return [];
};

export const checkCache = async (path, config) => {
  if (!config?.postgrestUrl || !hasVerifyCredentials(config.verifyHeader, config.verifySecret)) {
    logEvent('warn', 'Cache', 'check_failed', {
      reason: 'missing_config_or_credentials',
      hasPostgrestUrl: !!config?.postgrestUrl,
      hasVerifyHeader: config?.verifyHeader ? (Array.isArray(config.verifyHeader) ? config.verifyHeader.length > 0 : !!config.verifyHeader) : false,
      hasVerifySecret: config?.verifySecret ? (Array.isArray(config.verifySecret) ? config.verifySecret.length > 0 : !!config.verifySecret) : false,
    });
    return null;
  }

  const sizeTTL = Number(config.sizeTTL) || 0;
  if (sizeTTL <= 0) {
    logEvent('warn', 'Cache', 'check_failed', { reason: 'invalid_ttl', sizeTTL: config.sizeTTL, parsedTTL: sizeTTL });
    return null;
  }

  if (!path || typeof path !== 'string') {
    logEvent('warn', 'Cache', 'check_failed', { reason: 'invalid_path', pathProvided: Boolean(path) });
    return null;
  }

  try {
    const { postgrestUrl, verifyHeader, verifySecret } = config;
    const tableName = config.tableName || 'FILESIZE_CACHE_TABLE';

    const pathHash = await sha256Hash(path);
    if (!pathHash) {
      return null;
    }

    const filters = `PATH_HASH=eq.${pathHash}`;
    const queryResult = await executeQuery(
      postgrestUrl,
      verifyHeader,
      verifySecret,
      tableName,
      'GET',
      filters
    );

    const records = queryResult.data || [];
    if (records.length === 0) {
      return null;
    }

    const row = records[0];
    const now = Math.floor(Date.now() / 1000);
    const timestamp = Number.parseInt(row.TIMESTAMP, 10);
    const sizeValue = Number.parseInt(row.SIZE, 10);
    const age = now - timestamp;

    if (!Number.isFinite(timestamp) || age > sizeTTL) {
      return null;
    }

    if (!Number.isFinite(sizeValue) || sizeValue < 0) {
      logEvent('warn', 'Cache', 'parse_failed', { reason: 'invalid_size', tableName });
      return null;
    }

    return { size: sizeValue };
  } catch (error) {
    logEvent('error', 'Cache', 'check_failed', { error });
    return null;
  }
};

export const saveCache = async (path, size, config) => {
  if (!config?.postgrestUrl || !hasVerifyCredentials(config.verifyHeader, config.verifySecret)) {
    logEvent('warn', 'Cache', 'save_failed', {
      reason: 'missing_config_or_credentials',
      hasConfig: !!config,
      hasPostgrestUrl: !!config?.postgrestUrl,
      hasVerifyHeader: config?.verifyHeader ? (Array.isArray(config.verifyHeader) ? config.verifyHeader.length > 0 : !!config.verifyHeader) : false,
      hasVerifySecret: config?.verifySecret ? (Array.isArray(config.verifySecret) ? config.verifySecret.length > 0 : !!config.verifySecret) : false,
    });
    return;
  }

  const sizeTTL = Number(config.sizeTTL) || 0;
  if (sizeTTL <= 0) {
    logEvent('warn', 'Cache', 'save_failed', { reason: 'invalid_ttl', sizeTTL: config.sizeTTL, parsedTTL: sizeTTL });
    return;
  }

  if (!path || typeof path !== 'string') {
    logEvent('warn', 'Cache', 'save_failed', { reason: 'invalid_path', pathProvided: Boolean(path) });
    return;
  }

  const normalizedSize = Number(size);
  if (!Number.isFinite(normalizedSize) || normalizedSize < 0) {
    logEvent('warn', 'Cache', 'save_failed', { reason: 'invalid_size', size, normalizedSize });
    return;
  }

  try {
    const { postgrestUrl, verifyHeader, verifySecret } = config;
    const tableName = config.tableName || 'FILESIZE_CACHE_TABLE';
    const pathHash = await sha256Hash(path);
    if (!pathHash) {
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const rpcResult = await callRpc(
      postgrestUrl,
      verifyHeader,
      verifySecret,
      'landing_upsert_filesize_cache',
      {
        p_path_hash: pathHash,
        p_path: path,
        p_size: normalizedSize,
        p_timestamp: now,
        p_table_name: tableName,
      }
    );

    if (!rpcResult || rpcResult.length === 0) {
      throw new Error('landing_upsert_filesize_cache returned no rows');
    }
  } catch (error) {
    logEvent('error', 'Cache', 'save_failed', { error, tableName: config.tableName || 'FILESIZE_CACHE_TABLE' });
  }
};
