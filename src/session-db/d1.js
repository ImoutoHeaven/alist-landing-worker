const DEFAULT_TABLE_NAME = 'SESSION_MAPPING_TABLE';

export class SessionDBManagerD1 {
  constructor(options = {}) {
    this.env = options.env || null;
    this.databaseBinding = options.databaseBinding || 'SESSIONDB';
    this.tableName = options.tableName || DEFAULT_TABLE_NAME;
  }

  #getDatabase() {
    if (!this.env) {
      throw new Error('[SessionDB][D1] env binding container is not available');
    }
    const db = this.env[this.databaseBinding];
    if (!db || typeof db.prepare !== 'function') {
      throw new Error(`[SessionDB][D1] binding "${this.databaseBinding}" is not available or invalid`);
    }
    return db;
  }

  async insert(sessionTicket, filePath, ipSubnet, workerAddress, expireAt, createdAt) {
    const db = this.#getDatabase();
    const sql = `INSERT INTO ${this.tableName} (
      SESSION_TICKET,
      FILE_PATH,
      IP_SUBNET,
      WORKER_ADDRESS,
      EXPIRE_AT,
      CREATED_AT
    ) VALUES (?, ?, ?, ?, ?, ?)`;

    return db
      .prepare(sql)
      .bind(sessionTicket, filePath, ipSubnet, workerAddress, expireAt, createdAt)
      .run();
  }

  async cleanup() {
    const db = this.#getDatabase();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sql = `DELETE FROM ${this.tableName} WHERE EXPIRE_AT < ?`;
    return db.prepare(sql).bind(nowSeconds).run();
  }
}
