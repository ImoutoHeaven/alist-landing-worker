import { applyVerifyHeaders } from '../utils.js';

const DEFAULT_TABLE_NAME = 'SESSION_MAPPING_TABLE';

export class SessionDBManagerPostgREST {
  constructor(options = {}) {
    this.postgrestUrl = options.postgrestUrl || '';
    this.tableName = options.tableName || DEFAULT_TABLE_NAME;
    this.verifyHeader = options.verifyHeader;
    this.verifySecret = options.verifySecret;

    if (!this.postgrestUrl) {
      throw new Error('[SessionDB][PostgREST] postgrestUrl is required');
    }
  }

  async #callRpc(rpcName, payload = {}) {
    const url = `${this.postgrestUrl}/rpc/${rpcName}`;
    const headers = { 'Content-Type': 'application/json' };
    applyVerifyHeaders(headers, this.verifyHeader, this.verifySecret);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`[SessionDB][PostgREST] RPC ${rpcName} failed (${response.status}): ${errorText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json().catch(() => null);
    }
    return null;
  }

  async insert({
    sessionTicket,
    filePath,
    filePathHash,
    ipSubnet,
    workerAddress,
    expireAt,
    createdAt,
  }) {
    const payload = {
      p_session_ticket: sessionTicket,
      p_file_path: filePath,
      p_file_path_hash: filePathHash,
      p_ip_subnet: ipSubnet,
      p_worker_address: workerAddress,
      p_expire_at: expireAt,
      p_created_at: createdAt,
    };
    await this.#callRpc('session_insert', payload);
  }

  async cleanup() {
    await this.#callRpc('session_cleanup_expired');
  }
}
