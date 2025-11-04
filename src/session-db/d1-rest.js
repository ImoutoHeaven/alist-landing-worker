const DEFAULT_TABLE_NAME = 'SESSION_MAPPING_TABLE';

export class SessionDBManagerD1Rest {
  constructor(options = {}) {
    this.accountId = options.accountId || '';
    this.databaseId = options.databaseId || '';
    this.apiToken = options.apiToken || '';
    this.tableName = options.tableName || DEFAULT_TABLE_NAME;

    if (!this.accountId || !this.databaseId || !this.apiToken) {
      throw new Error('[SessionDB][D1-REST] accountId, databaseId, and apiToken are required');
    }
  }

  async #execute(sql, params = []) {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    const body = params.length > 0 ? { sql, params } : { sql };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`[SessionDB][D1-REST] query failed (${response.status}): ${errorText}`);
    }

    const payload = await response.json().catch(() => ({}));
    if (payload && payload.success === false) {
      throw new Error(
        `[SessionDB][D1-REST] query unsuccessful: ${JSON.stringify(payload.errors || [])}`
      );
    }

    return payload?.result?.[0] || {};
  }

  async insert(sessionTicket, filePath, ipSubnet, workerAddress, expireAt, createdAt) {
    const sql = `INSERT INTO ${this.tableName} (
      SESSION_TICKET,
      FILE_PATH,
      IP_SUBNET,
      WORKER_ADDRESS,
      EXPIRE_AT,
      CREATED_AT
    ) VALUES (?, ?, ?, ?, ?, ?)`;

    await this.#execute(sql, [sessionTicket, filePath, ipSubnet, workerAddress, expireAt, createdAt]);
  }

  async cleanup() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sql = `DELETE FROM ${this.tableName} WHERE EXPIRE_AT < ?`;
    await this.#execute(sql, [nowSeconds]);
  }
}
