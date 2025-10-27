import { sha256Hash, applyVerifyHeaders, hasVerifyCredentials } from '../utils.js';

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
    return null;
  }

  const sizeTTL = Number(config.sizeTTL) || 0;
  if (sizeTTL <= 0) {
    return null;
  }

  if (!path || typeof path !== 'string') {
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
      console.log('[Filesize Cache] MISS (no record)');
      return null;
    }

    const row = records[0];
    const now = Math.floor(Date.now() / 1000);
    const timestamp = Number.parseInt(row.TIMESTAMP, 10);
    const sizeValue = Number.parseInt(row.SIZE, 10);
    const age = now - timestamp;

    if (!Number.isFinite(timestamp) || age > sizeTTL) {
      console.log('[Filesize Cache] MISS (expired)');
      return null;
    }

    if (!Number.isFinite(sizeValue) || sizeValue < 0) {
      console.warn('[Filesize Cache] Invalid size stored, treating as miss');
      return null;
    }

    console.log('[Filesize Cache] HIT (PostgREST)');
    return { size: sizeValue };
  } catch (error) {
    console.error('[Filesize Cache] Check failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
};

export const saveCache = async (path, size, config) => {
  if (!config?.postgrestUrl || !hasVerifyCredentials(config.verifyHeader, config.verifySecret)) {
    return;
  }

  const sizeTTL = Number(config.sizeTTL) || 0;
  if (sizeTTL <= 0) {
    return;
  }

  if (!path || typeof path !== 'string') {
    return;
  }

  const normalizedSize = Number(size);
  if (!Number.isFinite(normalizedSize) || normalizedSize < 0) {
    console.warn('[Filesize Cache] Skipping save (invalid size value)');
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

    const triggerCleanup = () => {
      const probability = config.cleanupProbability ?? 0.01;
      if (probability <= 0) {
        return;
      }
      if (Math.random() < probability) {
        console.log(`[Filesize Cache Cleanup] Triggering probabilistic cleanup (p=${probability})`);
        const cleanupPromise = callRpc(
          postgrestUrl,
          verifyHeader,
          verifySecret,
          'landing_cleanup_expired_cache',
          {
            p_ttl_seconds: sizeTTL,
            p_table_name: tableName,
          }
        )
          .then((result) => {
            const deleted = Array.isArray(result) && result[0]?.landing_cleanup_expired_cache;
            console.log(
              `[Filesize Cache Cleanup] Removed ${Number.parseInt(deleted || '0', 10) || 0} expired records`
            );
          })
          .catch((error) => {
            console.error('[Filesize Cache Cleanup] Failed:', error instanceof Error ? error.message : String(error));
          });

        if (config.ctx?.waitUntil) {
          config.ctx.waitUntil(cleanupPromise);
        }
      }
    };

    triggerCleanup();
  } catch (error) {
    console.error('[Filesize Cache] Save failed:', error instanceof Error ? error.message : String(error));
  }
};
