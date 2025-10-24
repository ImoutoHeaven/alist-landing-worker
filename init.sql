-- ========================================
-- Rate Limit Table Schema (原子化改造后)
-- ========================================
-- 说明: 移除了 IP_ADDR 字段以简化原子UPSERT实现

CREATE TABLE IF NOT EXISTS "IP_LIMIT_TABLE" (
  "IP_HASH" TEXT PRIMARY KEY,
  "IP_RANGE" TEXT NOT NULL,
  "ACCESS_COUNT" INTEGER NOT NULL,
  "LAST_WINDOW_TIME" INTEGER NOT NULL,
  "BLOCK_UNTIL" INTEGER
);

-- 创建索引优化清理和查询性能
CREATE INDEX IF NOT EXISTS idx_last_window_time ON "IP_LIMIT_TABLE"("LAST_WINDOW_TIME");
CREATE INDEX IF NOT EXISTS idx_block_until ON "IP_LIMIT_TABLE"("BLOCK_UNTIL") WHERE "BLOCK_UNTIL" IS NOT NULL;


-- ========================================
-- Postgres 存储过程: 原子化Rate Limit UPSERT
-- ========================================
-- 仅用于 custom-pg-rest 方案，Neon方案直接使用内联SQL
--
-- 功能: 原子地插入或更新rate limit记录，处理窗口重置、阻断、递增等逻辑
-- 返回: 更新后的 ACCESS_COUNT, LAST_WINDOW_TIME, BLOCK_UNTIL 用于判断是否允许请求
--
-- 使用示例 (PostgREST):
--   POST /rpc/upsert_rate_limit
--   Body: {"p_ip_hash": "abc123", "p_ip_range": "192.168.1.0/24", "p_now": 1700000000, ...}

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
  -- 原子 UPSERT: 插入新记录或根据复杂条件更新现有记录
  RETURN QUERY
  INSERT INTO "IP_LIMIT_TABLE" ("IP_HASH", "IP_RANGE", "ACCESS_COUNT", "LAST_WINDOW_TIME", "BLOCK_UNTIL")
  VALUES (p_ip_hash, p_ip_range, 1, p_now, NULL)
  ON CONFLICT ("IP_HASH") DO UPDATE SET
    -- 计数逻辑: 窗口过期/阻断过期则重置为1, 达到限流则保持, 否则递增
    "ACCESS_COUNT" = CASE
      -- Case 1: 窗口过期，重置计数
      WHEN p_now - "IP_LIMIT_TABLE"."LAST_WINDOW_TIME" >= p_window_seconds THEN 1
      -- Case 2: 阻断已过期，重置计数
      WHEN "IP_LIMIT_TABLE"."BLOCK_UNTIL" IS NOT NULL AND "IP_LIMIT_TABLE"."BLOCK_UNTIL" <= p_now THEN 1
      -- Case 3: 已达限流上限，不再递增
      WHEN "IP_LIMIT_TABLE"."ACCESS_COUNT" >= p_limit THEN "IP_LIMIT_TABLE"."ACCESS_COUNT"
      -- Case 4: 正常递增
      ELSE "IP_LIMIT_TABLE"."ACCESS_COUNT" + 1
    END,

    -- 窗口时间逻辑: 窗口过期或阻断过期时更新为当前时间
    "LAST_WINDOW_TIME" = CASE
      WHEN p_now - "IP_LIMIT_TABLE"."LAST_WINDOW_TIME" >= p_window_seconds THEN p_now
      WHEN "IP_LIMIT_TABLE"."BLOCK_UNTIL" IS NOT NULL AND "IP_LIMIT_TABLE"."BLOCK_UNTIL" <= p_now THEN p_now
      ELSE "IP_LIMIT_TABLE"."LAST_WINDOW_TIME"
    END,

    -- 阻断逻辑: 窗口/阻断过期时清除，达到限流且配置了block_seconds时设置阻断时间
    "BLOCK_UNTIL" = CASE
      WHEN p_now - "IP_LIMIT_TABLE"."LAST_WINDOW_TIME" >= p_window_seconds THEN NULL
      WHEN "IP_LIMIT_TABLE"."BLOCK_UNTIL" IS NOT NULL AND "IP_LIMIT_TABLE"."BLOCK_UNTIL" <= p_now THEN NULL
      WHEN "IP_LIMIT_TABLE"."ACCESS_COUNT" >= p_limit AND p_block_seconds > 0 THEN p_now + p_block_seconds
      ELSE "IP_LIMIT_TABLE"."BLOCK_UNTIL"
    END

  -- 返回更新后的记录供应用层判断是否允许请求
  RETURNING "IP_LIMIT_TABLE"."ACCESS_COUNT", "IP_LIMIT_TABLE"."LAST_WINDOW_TIME", "IP_LIMIT_TABLE"."BLOCK_UNTIL";
END;
$$ LANGUAGE plpgsql;


-- ========================================
-- 迁移说明 (Migration Notes)
-- ========================================
-- 如果已有包含 IP_ADDR 字段的旧表，执行以下迁移:
--
-- ALTER TABLE "IP_LIMIT_TABLE" DROP COLUMN IF EXISTS "IP_ADDR";
--
-- 警告: 此操作不可逆，执行前请备份数据
