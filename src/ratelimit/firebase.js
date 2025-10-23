import * as Firestore from 'fireworkers';
import { calculateIPSubnet, sha256Hash } from '../utils.js';

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
const FIRESTORE_MAX_RETRIES = 3;

const encodeFirestoreValue = (value) => {
  if (value === null || value === undefined) {
    return { nullValue: 'NULL_VALUE' };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(encodeFirestoreValue),
      },
    };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([key, nested]) => [key, encodeFirestoreValue(nested)]);
    return {
      mapValue: {
        fields: Object.fromEntries(entries),
      },
    };
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { integerValue: value.toString() };
    }
    return { doubleValue: value };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  return { stringValue: String(value) };
};

const buildFirestoreDocument = (fields) => ({
  fields: Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, encodeFirestoreValue(value)]),
  ),
});

const firestoreCollectionEndpoint = (projectId, collectionName) => {
  const encodedCollection = collectionName
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${FIRESTORE_BASE}/projects/${projectId}/databases/(default)/documents/${encodedCollection}`;
};

const firestoreDocumentEndpoint = (projectId, collectionName, docId) => {
  const encodedCollection = collectionName
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const encodedDocId = encodeURIComponent(docId);
  return `${FIRESTORE_BASE}/projects/${projectId}/databases/(default)/documents/${encodedCollection}/${encodedDocId}`;
};

const parseFirestoreError = async (response) => {
  let errorPayload = null;
  try {
    errorPayload = await response.json();
  } catch (error) {
    // Ignore JSON parse errors; fall back to status text
  }
  const message = errorPayload?.error?.message || `Firestore request failed with status ${response.status}`;
  const error = new Error(message);
  error.status = response.status;
  if (errorPayload?.error?.status) {
    error.code = errorPayload.error.status;
  }
  throw error;
};

const createFirestoreDocument = async (db, collectionName, docId, fields) => {
  const endpoint = `${firestoreCollectionEndpoint(db.project_id, collectionName)}?documentId=${encodeURIComponent(docId)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${db.jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildFirestoreDocument(fields)),
  });
  if (!response.ok) {
    await parseFirestoreError(response);
  }
  return response.json();
};

const patchFirestoreDocument = async (db, collectionName, docId, fields, updateTime) => {
  const endpoint = firestoreDocumentEndpoint(db.project_id, collectionName, docId);
  const payload = buildFirestoreDocument(fields);
  if (updateTime) {
    payload.currentDocument = { updateTime };
  }
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${db.jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await parseFirestoreError(response);
  }
  return response.json();
};

const isConcurrencyConflict = (error) => {
  if (!error || typeof error !== 'object') return false;
  if (error.code === 'ALREADY_EXISTS' || error.code === 'FAILED_PRECONDITION') {
    return true;
  }
  if (error.status === 409 || error.status === 412) {
    return true;
  }
  return false;
};

/**
 * Check and update rate limit for an IP address using Firebase Firestore
 * @param {string} ip - Client IP address
 * @param {Object} config - Rate limit configuration
 * @param {string} config.projectId - Firebase project ID
 * @param {string} config.privateKey - Firebase private key
 * @param {string} config.clientEmail - Firebase client email
 * @param {string} config.privateKeyId - Firebase private key ID
 * @param {string} config.collection - Firestore collection name
 * @param {number} config.windowTimeSeconds - Time window in seconds
 * @param {number} config.limit - Request limit per window
 * @param {string} config.ipv4Suffix - IPv4 subnet suffix
 * @param {string} config.ipv6Suffix - IPv6 subnet suffix
 * @param {string} config.pgErrorHandle - Error handling strategy ('fail-open' or 'fail-closed')
 * @param {number} config.cleanupProbability - Probability of triggering cleanup (0.0 to 1.0)
 * @param {number} config.blockTimeSeconds - Additional block time in seconds when limit exceeded
 * @param {Object} config.ctx - ExecutionContext for waitUntil (optional)
 * @returns {Promise<{allowed: boolean, ipSubnet?: string, retryAfter?: number, error?: string}>}
 */
export const checkRateLimit = async (ip, config) => {
  // If any required config is missing, skip rate limiting
  if (!config.projectId || !config.privateKey || !config.clientEmail || !config.windowTimeSeconds || !config.limit) {
    return { allowed: true };
  }

  if (!ip || typeof ip !== 'string') {
    return { allowed: true };
  }

  try {
    // Initialize Firestore database
    const db = await Firestore.init({
      uid: 'rate-limiter',
      project_id: config.projectId,
      private_key: config.privateKey,
      client_email: config.clientEmail,
      private_key_id: config.privateKeyId,
    });

    // Calculate IP subnet
    const ipSubnet = calculateIPSubnet(ip, config.ipv4Suffix, config.ipv6Suffix);
    if (!ipSubnet) {
      return { allowed: true };
    }

    // Calculate SHA256 hash of IP subnet
    const ipHash = await sha256Hash(ipSubnet);
    if (!ipHash) {
      return { allowed: true };
    }

    // Get current timestamp (in seconds)
    const now = Math.floor(Date.now() / 1000);

    // Collection and document reference
    const collectionName = config.collection || 'IP_LIMIT_TABLE';

    // Probabilistic cleanup helper
    const triggerCleanup = () => {
      // Use configured cleanup probability (default 1% = 0.01)
      const probability = config.cleanupProbability || 0.01;
      if (Math.random() < probability) {
        console.log(`[Rate Limit Cleanup] Triggered cleanup (probability: ${probability * 100}%)`);

        // Use ctx.waitUntil to ensure cleanup completes even after response is sent
        const cleanupPromise = cleanupExpiredRecords(db, collectionName, config.windowTimeSeconds)
          .then((deletedCount) => {
            console.log(`[Rate Limit Cleanup] Background cleanup finished: ${deletedCount} records deleted`);
            return deletedCount;
          })
          .catch((error) => {
            console.error('[Rate Limit Cleanup] Background cleanup failed:', error instanceof Error ? error.message : String(error));
          });

        if (config.ctx && config.ctx.waitUntil) {
          // Cloudflare Workers context available, use waitUntil
          config.ctx.waitUntil(cleanupPromise);
          console.log(`[Rate Limit Cleanup] Cleanup scheduled in background (using ctx.waitUntil)`);
        } else {
          // No context available, cleanup may be interrupted
          console.warn(`[Rate Limit Cleanup] No ctx.waitUntil available, cleanup may be interrupted`);
        }
      }
    };

    for (let attempt = 0; attempt < FIRESTORE_MAX_RETRIES; attempt += 1) {
      let doc = null;
      let docUpdateTime = '';
      try {
        doc = await Firestore.get(db, collectionName, ipHash);
        docUpdateTime = doc?.updateTime || '';
      } catch (error) {
        doc = null;
      }

      if (!doc) {
        try {
          await createFirestoreDocument(db, collectionName, ipHash, {
            IP_RANGE: ipSubnet,
            IP_ADDR: [ip],
            ACCESS_COUNT: 1,
            LAST_WINDOW_TIME: now,
            BLOCK_UNTIL: null,
          });
          triggerCleanup();
          return { allowed: true };
        } catch (createError) {
          if (isConcurrencyConflict(createError)) {
            continue;
          }
          throw createError;
        }
      }

      const data = doc?.fields || {};
      const ipRangeValue = data.IP_RANGE || ipSubnet;
      const lastWindowTime = Number(data.LAST_WINDOW_TIME) || 0;
      const currentCount = Number(data.ACCESS_COUNT) || 0;
      const diff = now - lastWindowTime;
      const blockUntil = data.BLOCK_UNTIL ? Number(data.BLOCK_UNTIL) : null;
      const existingIPs = Array.isArray(data.IP_ADDR) ? [...data.IP_ADDR] : [];

      if (blockUntil && blockUntil > now) {
        const retryAfter = blockUntil - now;
        return {
          allowed: false,
          ipSubnet,
          retryAfter: Math.max(1, retryAfter),
        };
      }

      if (blockUntil && blockUntil <= now) {
        try {
          await patchFirestoreDocument(db, collectionName, ipHash, {
            IP_RANGE: ipRangeValue,
            ACCESS_COUNT: 1,
            LAST_WINDOW_TIME: now,
            IP_ADDR: [ip],
            BLOCK_UNTIL: null,
          }, docUpdateTime);
          triggerCleanup();
          return { allowed: true };
        } catch (patchError) {
          if (isConcurrencyConflict(patchError)) {
            continue;
          }
          throw patchError;
        }
      }

      if (diff >= config.windowTimeSeconds) {
        try {
          await patchFirestoreDocument(db, collectionName, ipHash, {
            IP_RANGE: ipRangeValue,
            ACCESS_COUNT: 1,
            LAST_WINDOW_TIME: now,
            IP_ADDR: [ip],
            BLOCK_UNTIL: null,
          }, docUpdateTime);
          triggerCleanup();
          return { allowed: true };
        } catch (patchError) {
          if (isConcurrencyConflict(patchError)) {
            continue;
          }
          throw patchError;
        }
      }

      if (currentCount >= config.limit) {
        const blockTimeSeconds = config.blockTimeSeconds || 0;
        if (blockTimeSeconds > 0) {
          const newBlockUntil = now + blockTimeSeconds;
          try {
            await patchFirestoreDocument(db, collectionName, ipHash, {
              IP_RANGE: ipRangeValue,
              ACCESS_COUNT: currentCount,
              LAST_WINDOW_TIME: lastWindowTime,
              IP_ADDR: existingIPs.length > 0 ? existingIPs : [ip],
              BLOCK_UNTIL: newBlockUntil,
            }, docUpdateTime);
          } catch (patchError) {
            if (isConcurrencyConflict(patchError)) {
              continue;
            }
            throw patchError;
          }
          const retryAfter = blockTimeSeconds;
          return {
            allowed: false,
            ipSubnet,
            retryAfter: Math.max(1, retryAfter),
          };
        }
        const retryAfter = config.windowTimeSeconds - diff;
        return {
          allowed: false,
          ipSubnet,
          retryAfter: Math.max(1, retryAfter),
        };
      }

      const shouldUpdateIPs = !existingIPs.includes(ip);
      const nextIPs = shouldUpdateIPs ? [...existingIPs, ip] : existingIPs;

      try {
        await patchFirestoreDocument(db, collectionName, ipHash, {
          IP_RANGE: ipRangeValue,
          ACCESS_COUNT: currentCount + 1,
          LAST_WINDOW_TIME: lastWindowTime,
          IP_ADDR: nextIPs,
          BLOCK_UNTIL: blockUntil,
        }, docUpdateTime);
        triggerCleanup();
        return { allowed: true };
      } catch (patchError) {
        if (isConcurrencyConflict(patchError)) {
          continue;
        }
        throw patchError;
      }
    }

    throw new Error('Firestore concurrency retry limit exceeded');
  } catch (error) {
    // Handle errors based on pgErrorHandle strategy
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (config.pgErrorHandle === 'fail-open') {
      // Log error and allow request
      console.error('Rate limit check failed (fail-open):', errorMessage);
      return { allowed: true };
    } else {
      // fail-closed: propagate error
      return {
        allowed: false,
        error: `Rate limit check failed: ${errorMessage}`,
      };
    }
  }
};

/**
 * Clean up expired records from Firestore
 * Removes records older than windowTimeSeconds * 2 (double buffer)
 * Respects BLOCK_UNTIL: does NOT delete records that are still blocked
 * @param {Object} db - Firestore DB instance
 * @param {string} collectionName - Collection name
 * @param {number} windowTimeSeconds - Time window in seconds
 * @returns {Promise<number>} - Number of deleted records
 */
const cleanupExpiredRecords = async (db, collectionName, windowTimeSeconds) => {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTime = now - (windowTimeSeconds * 2);

  try {
    console.log(`[Rate Limit Cleanup] Querying expired records (cutoff: ${cutoffTime}, windowTime: ${windowTimeSeconds}s)`);

    // Query for expired records using StructuredQuery
    // Query for records with LAST_WINDOW_TIME < cutoffTime
    let results;
    try {
      results = await Firestore.query(db, {
        from: [{ collectionId: collectionName }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'LAST_WINDOW_TIME' },
            op: 'LESS_THAN',
            value: { integerValue: cutoffTime.toString() },
          },
        },
      });
      console.log(`[Rate Limit Cleanup] Query completed successfully`);
    } catch (queryError) {
      console.error(`[Rate Limit Cleanup] Query failed:`, queryError instanceof Error ? queryError.message : String(queryError));
      throw queryError;
    }

    console.log(`[Rate Limit Cleanup] Query returned ${results?.length || 0} expired records`);

    if (!results || results.length === 0) {
      console.log('[Rate Limit Cleanup] No expired records to delete');
      return 0;
    }

    // Filter out records that are still blocked
    console.log(`[Rate Limit Cleanup] Filtering records to find deletable documents...`);
    const docsToDelete = [];
    let blockedCount = 0;

    for (const doc of results) {
      // Note: query results also have fields property
      // Firestore integerValue is returned as string, need to convert to number
      const fields = doc.fields || {};
      const blockUntil = fields.BLOCK_UNTIL ? Number(fields.BLOCK_UNTIL) : null;

      // Extract document ID first
      let docId = doc.id;
      if (!docId && doc.__meta__ && doc.__meta__.name) {
        // Format: projects/{project_id}/databases/{database_id}/documents/{collection}/{doc_id}
        docId = doc.__meta__.name.split('/').pop();
      }

      // Only delete if not blocked or block has expired
      if (!blockUntil || blockUntil < now) {
        if (docId) {
          docsToDelete.push(docId);
        }
      } else {
        blockedCount++;
        console.log(`[Rate Limit Cleanup] Skipping doc ${docId?.substring(0, 8)}... (blocked until ${blockUntil})`);
      }
    }

    console.log(`[Rate Limit Cleanup] Filter complete: ${docsToDelete.length} deletable, ${blockedCount} still blocked`);

    // Delete documents (no batch API, so delete one by one)
    if (docsToDelete.length === 0) {
      console.log(`[Rate Limit Cleanup] No documents to delete (${blockedCount} still blocked)`);
      return 0;
    }

    console.log(`[Rate Limit Cleanup] Starting deletion of ${docsToDelete.length} documents...`);

    let deletedCount = 0;
    for (let i = 0; i < docsToDelete.length; i++) {
      const docId = docsToDelete[i];
      try {
        console.log(`[Rate Limit Cleanup] Deleting document ${i + 1}/${docsToDelete.length}: ${docId.substring(0, 16)}...`);
        await Firestore.remove(db, collectionName, docId);
        deletedCount++;
        console.log(`[Rate Limit Cleanup] ✓ Deleted ${docId.substring(0, 16)}...`);
      } catch (deleteError) {
        // Log but continue with other deletions
        console.error(`[Rate Limit Cleanup] ✗ Failed to delete ${docId.substring(0, 16)}...:`, deleteError instanceof Error ? deleteError.message : String(deleteError));
      }
    }

    console.log(`[Rate Limit Cleanup] Deletion complete: ${deletedCount}/${docsToDelete.length} successfully deleted`);

    return deletedCount;
  } catch (error) {
    // Log error but don't propagate (cleanup failure shouldn't block requests)
    console.error('[Rate Limit Cleanup] Query/delete failed:', error instanceof Error ? error.message : String(error));
    return 0;
  }
};

/**
 * Format time window for display (seconds to human readable)
 * @param {number} seconds - Time in seconds
 * @returns {string} - Formatted time (e.g., "24h", "30m", "10s")
 */
export const formatWindowTime = (seconds) => {
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }
  return `${seconds}s`;
};
