const DEFAULT_TABLE_NAME = 'SESSION_MAPPING_TABLE';

export class SessionDBManagerD1 {
  #ensureTablePromise = null;

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

  async #ensureTable(db) {
    if (!this.#ensureTablePromise) {
      this.#ensureTablePromise = (async () => {
        try {
          await db.batch([
            db.prepare(`
              CREATE TABLE IF NOT EXISTS ${this.tableName} (
                SESSION_TICKET TEXT PRIMARY KEY,
                FILE_PATH TEXT NOT NULL,
                FILE_PATH_HASH TEXT NOT NULL,
                IP_SUBNET TEXT NOT NULL,
                WORKER_ADDRESS TEXT NOT NULL,
                EXPIRE_AT INTEGER NOT NULL,
                CREATED_AT INTEGER NOT NULL
              )
            `),
            db.prepare(`CREATE INDEX IF NOT EXISTS idx_session_expire ON ${this.tableName}(EXPIRE_AT)`),
            db.prepare(`CREATE INDEX IF NOT EXISTS idx_session_file_path_hash ON ${this.tableName}(FILE_PATH_HASH)`),
          ]);
        } catch (error) {
          console.error(
            '[SessionDB][D1] Failed to ensure session table:',
            error instanceof Error ? error.message : String(error)
          );
          this.#ensureTablePromise = null;
          throw error;
        }
      })();
    }

    return this.#ensureTablePromise;
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
    const db = this.#getDatabase();
    await this.#ensureTable(db);
    const sql = `INSERT INTO ${this.tableName} (
      SESSION_TICKET,
      FILE_PATH,
      FILE_PATH_HASH,
      IP_SUBNET,
      WORKER_ADDRESS,
      EXPIRE_AT,
      CREATED_AT
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`;

    return db
      .prepare(sql)
      .bind(sessionTicket, filePath, filePathHash, ipSubnet, workerAddress, expireAt, createdAt)
      .run();
  }

  async cleanup() {
    const db = this.#getDatabase();
    await this.#ensureTable(db);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sql = `DELETE FROM ${this.tableName} WHERE EXPIRE_AT < ?`;
    return db.prepare(sql).bind(nowSeconds).run();
  }
}
