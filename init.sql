-- ========================================
-- PostgreSQL Infrastructure for alist-landing-worker
-- ========================================
-- This script provisions rate limit + filesize cache helpers that mirror the
-- Cloudflare Workers runtime expectations. Apply it to the backing database
-- before enabling custom-pg-rest mode.


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
-- Stored Procedure: Unified Check (Rate Limit + Filesize Cache)
-- ========================================

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
  p_ratelimit_table_name TEXT
)
RETURNS TABLE(
  cache_size BIGINT,
  cache_timestamp INTEGER,
  rate_access_count INTEGER,
  rate_last_window_time INTEGER,
  rate_block_until INTEGER
) AS $$
DECLARE
  cache_sql TEXT;
  cache_rec RECORD;
  rate_rec RECORD;
BEGIN
  cache_sql := format(
    'SELECT "SIZE", "TIMESTAMP"
     FROM %1$I
     WHERE "PATH_HASH" = $1',
    p_cache_table_name
  );

  EXECUTE cache_sql INTO cache_rec USING p_path_hash;

  IF FOUND AND cache_rec."TIMESTAMP" IS NOT NULL AND (p_now - cache_rec."TIMESTAMP") <= p_cache_ttl THEN
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

  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
