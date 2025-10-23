import * as Firestore from 'fireworkers';
import { calculateIPSubnet, sha256Hash } from '../utils.js';

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

    // Try to get existing document
    let doc = null;
    try {
      doc = await Firestore.get(db, collectionName, ipHash);
    } catch (error) {
      // Document doesn't exist - this is expected for first request from this IP subnet
      // Firestore.get() throws error when document not found
    }

    // If no document exists, create a new one using update (which does upsert)
    if (!doc) {
      await Firestore.update(db, collectionName, ipHash, {
        IP_RANGE: ipSubnet,
        IP_ADDR: [ip],
        ACCESS_COUNT: 1,
        LAST_WINDOW_TIME: now,
        BLOCK_UNTIL: null,
      });
      triggerCleanup();
      return { allowed: true };
    }

    // Document exists, get data
    // Note: fireworkers returns {fields: {FIELD_NAME: value}} format
    // Firestore integerValue is returned as string, need to convert to number
    const data = doc.fields || {};
    const lastWindowTime = Number(data.LAST_WINDOW_TIME) || 0;
    const currentCount = Number(data.ACCESS_COUNT) || 0;
    const diff = now - lastWindowTime;
    const blockUntil = data.BLOCK_UNTIL ? Number(data.BLOCK_UNTIL) : null;

    // Priority 1: Check if IP is currently blocked (BLOCK_UNTIL)
    if (blockUntil && blockUntil > now) {
      // Still blocked, return 429 with retry after
      const retryAfter = blockUntil - now;
      return {
        allowed: false,
        ipSubnet,
        retryAfter: Math.max(1, retryAfter),
      };
    }

    // Priority 2: If BLOCK_UNTIL has expired, clear it and reset counter
    if (blockUntil && blockUntil <= now) {
      await Firestore.update(db, collectionName, ipHash, {
        IP_RANGE: data.IP_RANGE || ipSubnet,
        ACCESS_COUNT: 1,
        LAST_WINDOW_TIME: now,
        IP_ADDR: [ip],
        BLOCK_UNTIL: null,
      });
      triggerCleanup();
      return { allowed: true };
    }

    // Priority 3: If time window has expired, reset count
    if (diff >= config.windowTimeSeconds) {
      await Firestore.update(db, collectionName, ipHash, {
        IP_RANGE: data.IP_RANGE || ipSubnet,
        ACCESS_COUNT: 1,
        LAST_WINDOW_TIME: now,
        IP_ADDR: [ip],
        BLOCK_UNTIL: null,
      });
      triggerCleanup();
      return { allowed: true };
    }

    // Priority 4: Within time window, check if limit reached
    if (currentCount >= config.limit) {
      // Rate limit exceeded, set BLOCK_UNTIL if blockTimeSeconds configured
      const blockTimeSeconds = config.blockTimeSeconds || 0;
      if (blockTimeSeconds > 0) {
        const newBlockUntil = now + blockTimeSeconds;
        await Firestore.update(db, collectionName, ipHash, {
          IP_RANGE: data.IP_RANGE || ipSubnet,
          ACCESS_COUNT: currentCount,
          LAST_WINDOW_TIME: lastWindowTime,
          IP_ADDR: data.IP_ADDR || [ip],
          BLOCK_UNTIL: newBlockUntil,
        });
        const retryAfter = blockTimeSeconds;
        return {
          allowed: false,
          ipSubnet,
          retryAfter: Math.max(1, retryAfter),
        };
      } else {
        // No block time configured, use original behavior
        const retryAfter = config.windowTimeSeconds - diff;
        return {
          allowed: false,
          ipSubnet,
          retryAfter: Math.max(1, retryAfter),
        };
      }
    }

    // Still within limit, increment count
    // Check if we need to update IP_ADDR with new unique IP
    const existingIPs = data.IP_ADDR || [];
    const shouldUpdateIPs = !existingIPs.includes(ip);

    if (shouldUpdateIPs) {
      await Firestore.update(db, collectionName, ipHash, {
        IP_RANGE: data.IP_RANGE || ipSubnet,
        ACCESS_COUNT: currentCount + 1,
        LAST_WINDOW_TIME: lastWindowTime,
        IP_ADDR: [...existingIPs, ip],
        BLOCK_UNTIL: blockUntil,
      });
    } else {
      await Firestore.update(db, collectionName, ipHash, {
        IP_RANGE: data.IP_RANGE || ipSubnet,
        ACCESS_COUNT: currentCount + 1,
        LAST_WINDOW_TIME: lastWindowTime,
        IP_ADDR: existingIPs,
        BLOCK_UNTIL: blockUntil,
      });
    }

    triggerCleanup();
    return { allowed: true };
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
