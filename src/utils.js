export const rotLower = (value = '') => value.toLowerCase();

export const uint8ToBase64 = (bytes) => {
  if (!bytes || bytes.length === 0) return '';
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  const lowered = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  return defaultValue;
};

export const parseInteger = (value, defaultValue) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return parsed;
};

export const parseNumber = (value, defaultValue) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) return defaultValue;
  return parsed;
};

/**
 * Parse time window string (e.g., "24h", "4h", "30m", "10s") to seconds
 * @param {string} value - Time window string
 * @returns {number} - Time in seconds, or 0 if invalid
 */
export const parseWindowTime = (value) => {
  if (!value || typeof value !== 'string') return 0;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)(h|m|s)$/);
  if (!match) return 0;
  const num = Number.parseInt(match[1], 10);
  if (Number.isNaN(num) || num <= 0) return 0;
  const unit = match[2];
  if (unit === 'h') return num * 3600;
  if (unit === 'm') return num * 60;
  if (unit === 's') return num;
  return 0;
};

/**
 * Calculate IP subnet based on IP address and subnet suffix
 * @param {string} ip - IP address (IPv4 or IPv6)
 * @param {string} ipv4Suffix - IPv4 subnet suffix (e.g., "/24")
 * @param {string} ipv6Suffix - IPv6 subnet suffix (e.g., "/60")
 * @returns {string} - IP subnet string (e.g., "192.168.1.0/24")
 */
export const calculateIPSubnet = (ip, ipv4Suffix, ipv6Suffix) => {
  if (!ip || typeof ip !== 'string') return '';
  const trimmedIP = ip.trim();

  // Check if IPv6
  if (trimmedIP.includes(':')) {
    // IPv6
    const suffix = ipv6Suffix || '/60';
    const prefixLength = Number.parseInt(suffix.replace('/', ''), 10);
    if (Number.isNaN(prefixLength) || prefixLength < 0 || prefixLength > 128) {
      return `${trimmedIP}${suffix}`;
    }

    try {
      // Parse IPv6 address
      const parts = trimmedIP.split(':');
      const expanded = [];
      let emptyIndex = -1;

      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '') {
          if (emptyIndex === -1) emptyIndex = i;
          continue;
        }
        expanded.push(Number.parseInt(parts[i] || '0', 16));
      }

      // Handle :: notation
      if (emptyIndex !== -1) {
        const zerosNeeded = 8 - expanded.length;
        const before = expanded.slice(0, emptyIndex);
        const after = expanded.slice(emptyIndex);
        expanded.length = 0;
        expanded.push(...before, ...Array(zerosNeeded).fill(0), ...after);
      }

      // Apply subnet mask
      const bitsPerGroup = 16;
      const fullGroups = Math.floor(prefixLength / bitsPerGroup);
      const remainingBits = prefixLength % bitsPerGroup;

      for (let i = fullGroups; i < 8; i++) {
        if (i === fullGroups && remainingBits > 0) {
          const mask = (0xFFFF << (bitsPerGroup - remainingBits)) & 0xFFFF;
          expanded[i] = (expanded[i] || 0) & mask;
        } else {
          expanded[i] = 0;
        }
      }

      // Format as compressed IPv6
      const hex = expanded.map(n => (n || 0).toString(16));
      return `${hex.join(':')}${suffix}`;
    } catch (error) {
      return `${trimmedIP}${suffix}`;
    }
  } else {
    // IPv4
    const suffix = ipv4Suffix || '/32';
    const prefixLength = Number.parseInt(suffix.replace('/', ''), 10);
    if (Number.isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
      return `${trimmedIP}${suffix}`;
    }

    try {
      // Parse IPv4 address
      const octets = trimmedIP.split('.').map(o => Number.parseInt(o, 10));
      if (octets.length !== 4 || octets.some(o => Number.isNaN(o) || o < 0 || o > 255)) {
        return `${trimmedIP}${suffix}`;
      }

      // Convert to 32-bit integer
      let ipInt = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3];

      // Apply subnet mask
      const mask = prefixLength === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLength)) >>> 0;
      ipInt = (ipInt & mask) >>> 0;

      // Convert back to dotted notation
      const subnetOctets = [
        (ipInt >>> 24) & 0xFF,
        (ipInt >>> 16) & 0xFF,
        (ipInt >>> 8) & 0xFF,
        ipInt & 0xFF
      ];

      return `${subnetOctets.join('.')}${suffix}`;
    } catch (error) {
      return `${trimmedIP}${suffix}`;
    }
  }
};

/**
 * Calculate SHA256 hash of a string
 * @param {string} text - Text to hash
 * @returns {Promise<string>} - Hex string of hash
 */
export const sha256Hash = async (text) => {
  if (!text || typeof text !== 'string') return '';
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
};

/**
 * Apply verify header/secret pairs to a headers object.
 * Supports single values (string) and arrays of header/value pairs.
 * @param {Object} targetHeaders - Headers map to mutate
 * @param {string|string[]} verifyHeader - Header name(s)
 * @param {string|string[]} verifySecret - Header value(s)
 */
export const applyVerifyHeaders = (targetHeaders, verifyHeader, verifySecret) => {
  if (!targetHeaders || typeof targetHeaders !== 'object') return;

  if (Array.isArray(verifyHeader) && Array.isArray(verifySecret)) {
    verifyHeader.forEach((headerName, index) => {
      if (!headerName || typeof headerName !== 'string') return;
      const secretValue = verifySecret[index];
      if (typeof secretValue === 'undefined' || secretValue === null) return;
      targetHeaders[headerName] = secretValue;
    });
    return;
  }

  if (typeof verifyHeader === 'string' && typeof verifySecret === 'string' && verifyHeader && verifySecret) {
    targetHeaders[verifyHeader] = verifySecret;
  }
};

/**
 * Determine if verify header/secret values are present.
 * Works with both string and array formats.
 * @param {string|string[]} verifyHeader
 * @param {string|string[]} verifySecret
 * @returns {boolean}
 */
export const hasVerifyCredentials = (verifyHeader, verifySecret) => {
  if (Array.isArray(verifyHeader) && Array.isArray(verifySecret)) {
    return verifyHeader.length > 0 && verifySecret.length > 0;
  }
  return Boolean(verifyHeader) && Boolean(verifySecret);
};
