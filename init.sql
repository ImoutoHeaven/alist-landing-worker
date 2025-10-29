-- ========================================
-- PostgreSQL Infrastructure for alist-landing-worker
-- ========================================
-- This script provisions rate limit, filesize cache, and Turnstile token binding
-- helpers that mirror the Cloudflare Workers runtime expectations. Apply it to the
-- backing database before enabling custom-pg-rest mode.


-- ========================================
-- Rate Limit Table Schema
-- ========================================

CREATE TABLE IF NOT EXISTS "IP_LIMIT_TABLE" (
  "IP_HASH" TEXT PRIMARY KEY,
  "IP_RANGE" TEXT NOT NULL,
  "ACCESS_COUNT" INTEGER NOT NULL,
  "LAST_WINDOW_TIME" INTEGER NOT NULL,
  "BLOCK_UNTIL" INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ip_limit_last_window
  ON "IP_LIMIT_TABLE" ("LAST_WINDOW_TIME");
CREATE INDEX IF NOT EXISTS idx_ip_limit_block_until
  ON "IP_LIMIT_TABLE" ("BLOCK_UNTIL")
  WHERE "BLOCK_UNTIL" IS NOT NULL;


-- ========================================
-- Stored Procedure: Atomic Rate Limit UPSERT (Parametrised)
-- ========================================

CREATE OR REPLACE FUNCTION landing_upsert_rate_limit(
  p_ip_hash TEXT,
  p_ip_range TEXT,
  p_now INTEGER,
  p_window_seconds INTEGER,
  p_limit INTEGER,
  p_block_seconds INTEGER,
  p_table_name TEXT DEFAULT 'IP_LIMIT_TABLE'
)
RETURNS TABLE(
  "ACCESS_COUNT" INTEGER,
  "LAST_WINDOW_TIME" INTEGER,
  "BLOCK_UNTIL" INTEGER
) AS $$
DECLARE
  sql TEXT;
BEGIN
  sql := format(
    'INSERT INTO %1$I ("IP_HASH", "IP_RANGE", "ACCESS_COUNT", "LAST_WINDOW_TIME", "BLOCK_UNTIL")
     VALUES ($1, $2, 1, $3, NULL)
     ON CONFLICT ("IP_HASH") DO UPDATE SET
       "ACCESS_COUNT" = CASE
         WHEN $3 - %1$I."LAST_WINDOW_TIME" >= $4 THEN 1
         WHEN %1$I."BLOCK_UNTIL" IS NOT NULL AND %1$I."BLOCK_UNTIL" <= $3 THEN 1
         WHEN %1$I."ACCESS_COUNT" >= $5 THEN %1$I."ACCESS_COUNT"
         ELSE %1$I."ACCESS_COUNT" + 1
       END,
       "LAST_WINDOW_TIME" = CASE
         WHEN $3 - %1$I."LAST_WINDOW_TIME" >= $4 THEN $3
         WHEN %1$I."BLOCK_UNTIL" IS NOT NULL AND %1$I."BLOCK_UNTIL" <= $3 THEN $3
         ELSE %1$I."LAST_WINDOW_TIME"
       END,
       "BLOCK_UNTIL" = CASE
         WHEN $3 - %1$I."LAST_WINDOW_TIME" >= $4 THEN NULL
         WHEN %1$I."BLOCK_UNTIL" IS NOT NULL AND %1$I."BLOCK_UNTIL" <= $3 THEN NULL
         WHEN %1$I."ACCESS_COUNT" >= $5 AND $6 > 0 THEN $3 + $6
         ELSE %1$I."BLOCK_UNTIL"
       END
     RETURNING "ACCESS_COUNT", "LAST_WINDOW_TIME", "BLOCK_UNTIL"',
    p_table_name
  );

  RETURN QUERY EXECUTE sql
    USING p_ip_hash, p_ip_range, p_now, p_window_seconds, p_limit, p_block_seconds;
END;
$$ LANGUAGE plpgsql;

-- Backwards compatible wrapper for existing PostgREST deployment.
CREATE OR REPLACE FUNCTION upsert_rate_limit(
  p_ip_hash TEXT,
  p_ip_range TEXT,
  p_now INTEGER,
  p_window_seconds INTEGER,
  p_limit INTEGER,
  p_block_seconds INTEGER
)
RETURNS TABLE(
  "ACCESS_COUNT" INTEGER,
  "LAST_WINDOW_TIME" INTEGER,
  "BLOCK_UNTIL" INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM landing_upsert_rate_limit(
    p_ip_hash,
    p_ip_range,
    p_now,
    p_window_seconds,
    p_limit,
    p_block_seconds,
    'IP_LIMIT_TABLE'
  );
END;
$$ LANGUAGE plpgsql;


-- ========================================
-- Filesize Cache Table Schema
-- ========================================

CREATE TABLE IF NOT EXISTS "FILESIZE_CACHE_TABLE" (
  "PATH_HASH" TEXT PRIMARY KEY,
  "PATH" TEXT NOT NULL,
  "SIZE" BIGINT NOT NULL,
  "TIMESTAMP" INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_filesize_cache_timestamp
  ON "FILESIZE_CACHE_TABLE" ("TIMESTAMP");


-- ========================================
-- Stored Procedure: Atomic UPSERT (Filesize Cache)
-- ========================================

CREATE OR REPLACE FUNCTION landing_upsert_filesize_cache(
  p_path_hash TEXT,
  p_path TEXT,
  p_size BIGINT,
  p_timestamp INTEGER,
  p_table_name TEXT DEFAULT 'FILESIZE_CACHE_TABLE'
)
RETURNS TABLE(
  "PATH_HASH" TEXT,
  "PATH" TEXT,
  "SIZE" BIGINT,
  "TIMESTAMP" INTEGER
) AS $$
DECLARE
  sql TEXT;
BEGIN
  sql := format(
    'INSERT INTO %1$I ("PATH_HASH", "PATH", "SIZE", "TIMESTAMP")
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ("PATH_HASH") DO UPDATE SET
       "PATH" = EXCLUDED."PATH",
       "SIZE" = EXCLUDED."SIZE",
       "TIMESTAMP" = EXCLUDED."TIMESTAMP"
     RETURNING "PATH_HASH", "PATH", "SIZE", "TIMESTAMP"',
    p_table_name
  );

  RETURN QUERY EXECUTE sql USING p_path_hash, p_path, p_size, p_timestamp;
END;
$$ LANGUAGE plpgsql;


-- ========================================
-- Stored Procedure: Cleanup Expired Cache Records
-- ========================================

CREATE OR REPLACE FUNCTION landing_cleanup_expired_cache(
  p_ttl_seconds INTEGER,
  p_table_name TEXT DEFAULT 'FILESIZE_CACHE_TABLE'
)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER := 0;
  cutoff INTEGER;
  now_ts INTEGER;
  sql TEXT;
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 THEN
    RETURN 0;
  END IF;

  now_ts := EXTRACT(EPOCH FROM NOW())::INTEGER;
  cutoff := now_ts - (p_ttl_seconds * 2);

  sql := format(
    'DELETE FROM %1$I
     WHERE "TIMESTAMP" < $1',
    p_table_name
  );

  EXECUTE sql USING cutoff;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;


-- ========================================
-- Turnstile Token Binding Schema
-- ========================================

CREATE TABLE IF NOT EXISTS "TURNSTILE_TOKEN_BINDING" (
  "TOKEN_HASH" TEXT PRIMARY KEY,
  "CLIENT_IP" TEXT NOT NULL,
  "FILEPATH_HASH" TEXT NOT NULL,
  "ACCESS_COUNT" INTEGER NOT NULL,
  "CREATED_AT" INTEGER NOT NULL,
  "UPDATED_AT" INTEGER NOT NULL,
  "EXPIRES_AT" INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turnstile_token_expires
  ON "TURNSTILE_TOKEN_BINDING" ("EXPIRES_AT");


-- ========================================
-- Stored Procedure: Turnstile Token UPSERT
-- ========================================

CREATE OR REPLACE FUNCTION landing_upsert_token_binding(
  p_token_hash TEXT,
  p_client_ip TEXT,
  p_now INTEGER,
  p_ttl_seconds INTEGER,
  p_table_name TEXT DEFAULT 'TURNSTILE_TOKEN_BINDING'
)
RETURNS TABLE(
  "TOKEN_HASH" TEXT,
  "CLIENT_IP" TEXT,
  "ACCESS_COUNT" INTEGER,
  "CREATED_AT" INTEGER,
  "UPDATED_AT" INTEGER,
  "EXPIRES_AT" INTEGER
) AS $$
DECLARE
  sql TEXT;
BEGIN
  sql := format(
    'INSERT INTO %1$I ("TOKEN_HASH", "CLIENT_IP", "ACCESS_COUNT", "CREATED_AT", "UPDATED_AT", "EXPIRES_AT")
     VALUES ($1, $2, 1, $3, $3, $3 + $4)
     ON CONFLICT ("TOKEN_HASH") DO UPDATE SET
       "ACCESS_COUNT" = LEAST(%1$I."ACCESS_COUNT" + 1, 2147483647),
       "UPDATED_AT" = $3,
       "EXPIRES_AT" = CASE
         WHEN %1$I."EXPIRES_AT" IS NULL OR %1$I."EXPIRES_AT" < $3 THEN $3 + $4
         ELSE %1$I."EXPIRES_AT"
       END
     WHERE %1$I."CLIENT_IP" = $2
     RETURNING "TOKEN_HASH", "CLIENT_IP", "ACCESS_COUNT", "CREATED_AT", "UPDATED_AT", "EXPIRES_AT"',
    p_table_name
  );

  RETURN QUERY EXECUTE sql USING p_token_hash, p_client_ip, p_now, p_ttl_seconds;
END;
$$ LANGUAGE plpgsql;


-- ========================================
-- ALTCHA Token Binding Schema (Replay Attack Prevention)
-- ========================================

CREATE TABLE IF NOT EXISTS "ALTCHA_TOKEN_LIST" (
  "ALTCHA_TOKEN_HASH" TEXT PRIMARY KEY,
  "CLIENT_IP" TEXT NOT NULL,
  "FILEPATH_HASH" TEXT NOT NULL,
  "ACCESS_COUNT" INTEGER NOT NULL DEFAULT 0,
  "CREATED_AT" INTEGER NOT NULL,
  "EXPIRES_AT" INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_altcha_token_expires
  ON "ALTCHA_TOKEN_LIST" ("EXPIRES_AT");


-- ========================================
-- Stored Procedure: Verify and Consume ALTCHA Token
-- ========================================

CREATE OR REPLACE FUNCTION landing_verify_altcha_token(
  p_token_hash TEXT,
  p_client_ip TEXT,
  p_filepath_hash TEXT,
  p_now INTEGER,
  p_table_name TEXT DEFAULT 'ALTCHA_TOKEN_LIST'
)
RETURNS TABLE(
  token_allowed BOOLEAN,
  token_error_code INTEGER,
  token_access_count INTEGER,
  token_expires_at INTEGER
) AS $$
DECLARE
  sql TEXT;
  rec RECORD;
  allowed_local BOOLEAN := FALSE;
  error_local INTEGER := 0;
  access_local INTEGER := 0;
  expires_local INTEGER := NULL;
BEGIN
  sql := format(
    'SELECT "CLIENT_IP", "FILEPATH_HASH", "ACCESS_COUNT", "EXPIRES_AT"
     FROM %1$I
     WHERE "ALTCHA_TOKEN_HASH" = $1',
    p_table_name
  );

  EXECUTE sql INTO rec USING p_token_hash;

  IF rec."ACCESS_COUNT" IS NULL THEN
    allowed_local := TRUE;
    error_local := 0;
    access_local := 0;
    expires_local := NULL;
  ELSE
    access_local := rec."ACCESS_COUNT";
    expires_local := rec."EXPIRES_AT";

    IF rec."CLIENT_IP" <> p_client_ip THEN
      allowed_local := FALSE;
      error_local := 1;
    ELSIF rec."FILEPATH_HASH" <> p_filepath_hash THEN
      allowed_local := FALSE;
      error_local := 4;
    ELSIF rec."EXPIRES_AT" < p_now THEN
      allowed_local := FALSE;
      error_local := 2;
    ELSIF access_local >= 1 THEN
      allowed_local := FALSE;
      error_local := 3;
    ELSE
      allowed_local := TRUE;
      error_local := 0;
    END IF;
  END IF;

  token_allowed := allowed_local;
  token_error_code := error_local;
  token_access_count := access_local;
  token_expires_at := expires_local;

  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;


-- ========================================
-- Stored Procedure: Record ALTCHA Token Usage
-- ========================================

CREATE OR REPLACE FUNCTION landing_record_altcha_token(
  p_token_hash TEXT,
  p_client_ip TEXT,
  p_filepath_hash TEXT,
  p_now INTEGER,
  p_ttl_seconds INTEGER,
  p_table_name TEXT DEFAULT 'ALTCHA_TOKEN_LIST'
)
RETURNS TABLE(
  "ALTCHA_TOKEN_HASH" TEXT,
  "ACCESS_COUNT" INTEGER,
  "CREATED_AT" INTEGER,
  "EXPIRES_AT" INTEGER
) AS $$
DECLARE
  sql TEXT;
BEGIN
  sql := format(
    'INSERT INTO %1$I ("ALTCHA_TOKEN_HASH", "CLIENT_IP", "FILEPATH_HASH", "ACCESS_COUNT", "CREATED_AT", "EXPIRES_AT")
     VALUES ($1, $2, $3, 1, $4, $4 + $5)
     ON CONFLICT ("ALTCHA_TOKEN_HASH") DO UPDATE SET
       "ACCESS_COUNT" = %1$I."ACCESS_COUNT" + 1
     RETURNING "ALTCHA_TOKEN_HASH", "ACCESS_COUNT", "CREATED_AT", "EXPIRES_AT"',
    p_table_name
  );

  RETURN QUERY EXECUTE sql USING p_token_hash, p_client_ip, p_filepath_hash, p_now, p_ttl_seconds;
END;
$$ LANGUAGE plpgsql;


-- ========================================
-- Stored Procedure: Cleanup Expired ALTCHA Tokens
-- ========================================

CREATE OR REPLACE FUNCTION landing_cleanup_expired_altcha_tokens(
  p_now INTEGER,
  p_table_name TEXT DEFAULT 'ALTCHA_TOKEN_LIST'
)
RETURNS INTEGER AS $$
DECLARE
  sql TEXT;
  deleted_count INTEGER := 0;
BEGIN
  sql := format(
    'DELETE FROM %1$I
     WHERE "EXPIRES_AT" <= $1',
    p_table_name
  );

  EXECUTE sql USING p_now;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;


-- ========================================
-- Stored Procedure: Cleanup Expired Turnstile Tokens
-- ========================================

CREATE OR REPLACE FUNCTION landing_cleanup_expired_tokens(
  p_now INTEGER,
  p_table_name TEXT DEFAULT 'TURNSTILE_TOKEN_BINDING'
)
RETURNS INTEGER AS $$
DECLARE
  sql TEXT;
  deleted_count INTEGER := 0;
BEGIN
  sql := format(
    'DELETE FROM %1$I
     WHERE "EXPIRES_AT" <= $1',
    p_table_name
  );

  EXECUTE sql USING p_now;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;


-- ========================================
-- Stored Procedure: Unified Check (Cache + Rate Limit + Token Binding)
-- ========================================
-- PostgreSQL FOUND variable behavior is undefined after dynamic SQL execution (EXECUTE).
-- Instead of relying on FOUND, we check record fields for NULL values directly.

CREATE OR REPLACE FUNCTION landing_unified_check(
  p_path_hash TEXT,
  p_cache_ttl INTEGER,
  p_cache_table_name TEXT,
  p_ip_hash TEXT,
  p_ip_range TEXT,
  p_now INTEGER,
  p_window_seconds INTEGER,
  p_limit INTEGER,
  p_block_seconds INTEGER,
  p_ratelimit_table_name TEXT,
  p_token_hash TEXT,
  p_token_ip TEXT,
  p_token_ttl INTEGER,
  p_token_table_name TEXT DEFAULT 'TURNSTILE_TOKEN_BINDING',
  p_filepath_hash TEXT DEFAULT NULL,
  p_altcha_token_hash TEXT DEFAULT NULL,
  p_altcha_token_ip TEXT DEFAULT NULL,
  p_altcha_filepath_hash TEXT DEFAULT NULL,
  p_altcha_table_name TEXT DEFAULT 'ALTCHA_TOKEN_LIST'
)
RETURNS TABLE(
  cache_size BIGINT,
  cache_timestamp INTEGER,
  rate_access_count INTEGER,
  rate_last_window_time INTEGER,
  rate_block_until INTEGER,
  token_allowed BOOLEAN,
  token_error_code INTEGER,
  token_access_count INTEGER,
  token_client_ip TEXT,
  token_filepath TEXT,
  token_expires_at INTEGER,
  altcha_allowed BOOLEAN,
  altcha_error_code INTEGER,
  altcha_access_count INTEGER,
  altcha_expires_at INTEGER
) AS $$
DECLARE
  cache_sql TEXT;
  cache_rec RECORD;
  rate_rec RECORD;
  token_sql TEXT;
  token_rec RECORD;
  token_allowed_local BOOLEAN := TRUE;
  token_error_local INTEGER := 0;
  token_access_local INTEGER := 0;
  token_client_local TEXT := NULL;
  token_filepath_local TEXT := NULL;
  token_expires_local INTEGER := NULL;
  altcha_rec RECORD;
  altcha_allowed_local BOOLEAN := TRUE;
  altcha_error_local INTEGER := 0;
  altcha_access_local INTEGER := 0;
  altcha_expires_local INTEGER := NULL;
BEGIN
  cache_sql := format(
    'SELECT "SIZE", "TIMESTAMP"
     FROM %1$I
     WHERE "PATH_HASH" = $1',
    p_cache_table_name
  );

  EXECUTE cache_sql INTO cache_rec USING p_path_hash;

  IF cache_rec."TIMESTAMP" IS NOT NULL AND (p_now - cache_rec."TIMESTAMP") <= p_cache_ttl THEN
    cache_size := cache_rec."SIZE";
    cache_timestamp := cache_rec."TIMESTAMP";
  ELSE
    cache_size := NULL;
    cache_timestamp := NULL;
  END IF;

  SELECT *
  INTO rate_rec
  FROM landing_upsert_rate_limit(
    p_ip_hash,
    p_ip_range,
    p_now,
    p_window_seconds,
    p_limit,
    p_block_seconds,
    p_ratelimit_table_name
  );

  rate_access_count := rate_rec."ACCESS_COUNT";
  rate_last_window_time := rate_rec."LAST_WINDOW_TIME";
  rate_block_until := rate_rec."BLOCK_UNTIL";

  IF p_token_hash IS NOT NULL AND length(p_token_hash) > 0 THEN
    token_sql := format(
      'SELECT "CLIENT_IP", "FILEPATH_HASH", "ACCESS_COUNT", "EXPIRES_AT"
       FROM %1$I
       WHERE "TOKEN_HASH" = $1',
      p_token_table_name
    );

    EXECUTE token_sql INTO token_rec USING p_token_hash;

    IF token_rec."CLIENT_IP" IS NOT NULL THEN
      token_access_local := COALESCE(token_rec."ACCESS_COUNT", 0);
      token_client_local := token_rec."CLIENT_IP";
      token_filepath_local := token_rec."FILEPATH_HASH";
      token_expires_local := token_rec."EXPIRES_AT";

      IF token_rec."CLIENT_IP" <> p_token_ip THEN
        token_allowed_local := FALSE;
        token_error_local := 1; -- IP mismatch
      ELSIF token_rec."FILEPATH_HASH" IS NOT NULL AND token_rec."FILEPATH_HASH" <> p_filepath_hash THEN
        token_allowed_local := FALSE;
        token_error_local := 4; -- Filepath mismatch
      ELSIF token_rec."EXPIRES_AT" IS NULL OR token_rec."EXPIRES_AT" < p_now THEN
        token_allowed_local := FALSE;
        token_error_local := 2; -- Token expired
      ELSIF token_access_local >= 1 THEN
        token_allowed_local := FALSE;
        token_error_local := 3; -- Token already consumed
      END IF;
    ELSE
      token_access_local := 0;
      token_client_local := NULL;
      token_filepath_local := NULL;
      token_expires_local := NULL;
    END IF;
  ELSE
    token_allowed_local := TRUE;
    token_error_local := 0;
    token_access_local := 0;
    token_client_local := NULL;
    token_filepath_local := NULL;
    token_expires_local := NULL;
  END IF;

  token_allowed := token_allowed_local;
  token_error_code := token_error_local;
  token_access_count := token_access_local;
  token_client_ip := token_client_local;
  token_filepath := token_filepath_local;
  token_expires_at := token_expires_local;

  IF p_altcha_token_hash IS NOT NULL AND length(p_altcha_token_hash) > 0 THEN
    SELECT *
    INTO altcha_rec
    FROM landing_verify_altcha_token(
      p_altcha_token_hash,
      p_altcha_token_ip,
      p_altcha_filepath_hash,
      p_now,
      p_altcha_table_name
    );

    altcha_allowed_local := altcha_rec.token_allowed;
    altcha_error_local := altcha_rec.token_error_code;
    altcha_access_local := altcha_rec.token_access_count;
    altcha_expires_local := altcha_rec.token_expires_at;
  ELSE
    altcha_allowed_local := TRUE;
    altcha_error_local := 0;
    altcha_access_local := 0;
    altcha_expires_local := NULL;
  END IF;

  altcha_allowed := altcha_allowed_local;
  altcha_error_code := altcha_error_local;
  altcha_access_count := altcha_access_local;
  altcha_expires_at := altcha_expires_local;

  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
