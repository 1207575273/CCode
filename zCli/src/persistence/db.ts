/**
 * SQLite 懒加载单例 — 提供 usage_logs 和 pricing_rules 表。
 *
 * 首次 getDb() 调用时：
 * 1. 创建 ~/.zcli/data/ 目录
 * 2. 打开 zcli.db
 * 3. 建表（IF NOT EXISTS）
 * 4. 写入默认计价规则（IF NOT EXISTS 去重）
 */

import Database from 'libsql'
import type { Database as DatabaseType } from 'libsql'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'

let _db: DatabaseType | null = null

/** 创建并初始化数据库（可注入路径，测试用） */
export function createDb(dbPath: string): DatabaseType {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    -- ═══ Token 使用记录表 ═══
    -- 每次 LLM 调用产生一条记录，记录四维 token 消耗和费用
    CREATE TABLE IF NOT EXISTS usage_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
      session_id      TEXT NOT NULL,                      -- 所属会话 ID
      timestamp       TEXT NOT NULL,                      -- 记录时间 (ISO 8601)
      provider        TEXT NOT NULL,                      -- LLM 供应商 (anthropic/openai/google/...)
      model           TEXT NOT NULL,                      -- 模型标识 (claude-opus-4-6/gpt-4o/...)
      input_tokens    INTEGER NOT NULL,                   -- 输入 token 数
      output_tokens   INTEGER NOT NULL,                   -- 输出 token 数
      cache_read      INTEGER NOT NULL DEFAULT 0,         -- 缓存读取 token 数
      cache_write     INTEGER NOT NULL DEFAULT 0,         -- 缓存写入 token 数
      duration_ms     INTEGER,                            -- LLM 调用耗时（毫秒）
      cost_amount     REAL,                               -- 计算费用（美元），无匹配规则时为 NULL
      cost_currency   TEXT NOT NULL DEFAULT 'USD',        -- 费用币种
      pricing_rule_id INTEGER                             -- 匹配的计价规则 ID
    );

    -- ═══ 计价规则表 ═══
    -- 按 provider + model 通配符匹配，支持时间范围和优先级
    CREATE TABLE IF NOT EXISTS pricing_rules (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
      provider          TEXT NOT NULL,                      -- LLM 供应商
      model_pattern     TEXT NOT NULL,                      -- 模型匹配模式（支持末尾 * 通配符）
      input_price       REAL NOT NULL,                      -- 输入价格 (货币/百万 token)
      output_price      REAL NOT NULL,                      -- 输出价格 (货币/百万 token)
      cache_read_price  REAL NOT NULL DEFAULT 0,            -- 缓存读取价格 (货币/百万 token)
      cache_write_price REAL NOT NULL DEFAULT 0,            -- 缓存写入价格 (货币/百万 token)
      currency          TEXT NOT NULL DEFAULT 'USD',        -- 价格币种
      effective_from    TEXT NOT NULL,                      -- 生效起始日期 (ISO 8601)
      effective_to      TEXT,                               -- 生效截止日期（NULL 表示永久有效）
      source            TEXT,                               -- 价格来源说明
      priority          INTEGER NOT NULL DEFAULT 0          -- 匹配优先级（越大越优先）
    );

    -- ═══ 字段注释元数据表 ═══
    -- SQLite 不支持列级 COMMENT，用此表存储字段说明，可运行时查询
    CREATE TABLE IF NOT EXISTS schema_comments (
      table_name    TEXT NOT NULL,       -- 所属表名
      column_name   TEXT NOT NULL,       -- 字段名
      comment       TEXT NOT NULL,       -- 字段说明
      PRIMARY KEY (table_name, column_name)
    );

    -- ═══ 索引 ═══
    CREATE INDEX IF NOT EXISTS idx_pricing_lookup
      ON pricing_rules(provider, model_pattern, effective_from);

    CREATE INDEX IF NOT EXISTS idx_usage_session
      ON usage_logs(session_id);

    CREATE INDEX IF NOT EXISTS idx_usage_timestamp
      ON usage_logs(timestamp);
  `)

  seedDefaultPricing(db)
  seedSchemaComments(db)
  return db
}

/** 获取全局单例（懒加载） */
export function getDb(): DatabaseType {
  if (_db) return _db
  const dataDir = join(homedir(), '.zcli', 'data')
  mkdirSync(dataDir, { recursive: true })
  _db = createDb(join(dataDir, 'zcli.db'))
  return _db
}

/** 关闭数据库连接（进程退出时调用） */
export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

/** 写入默认计价规则（幂等：按 provider+model_pattern 去重） */
function seedDefaultPricing(db: DatabaseType): void {
  const insert = db.prepare(`
    INSERT INTO pricing_rules (provider, model_pattern, input_price, output_price, cache_read_price, cache_write_price, currency, effective_from, source, priority)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM pricing_rules WHERE provider = ? AND model_pattern = ?
    )
  `)

  // [provider, pattern, input, output, cacheRead, cacheWrite, currency, effectiveFrom, source, priority]
  const rules: Array<[string, string, number, number, number, number, string, string, string, number]> = [
    // Anthropic (USD)
    ['anthropic', 'claude-opus-4-*',   15.0, 75.0, 1.50, 18.75, 'USD', '2025-01-01', '官网 2025-01', 0],
    ['anthropic', 'claude-sonnet-4-*',  3.0, 15.0, 0.30,  3.75, 'USD', '2025-01-01', '官网 2025-01', 0],
    ['anthropic', 'claude-haiku-*',     0.8,  4.0, 0.08,  1.00, 'USD', '2025-01-01', '官网 2025-01', 0],
    // OpenAI (USD)
    ['openai', 'gpt-4o',               2.5, 10.0, 1.25,  0.0, 'USD', '2025-01-01', '官网 2025-01', 0],
    ['openai', 'gpt-4o-mini',          0.15, 0.6, 0.075, 0.0, 'USD', '2025-01-01', '官网 2025-01', 0],
    ['openai', 'o3-mini',              1.1,  4.4, 0.55,  0.0, 'USD', '2025-01-01', '官网 2025-01', 0],
    // Google (USD)
    ['google', 'gemini-2.0-flash*',    0.1,  0.4, 0.0,   0.0, 'USD', '2025-01-01', '官网 2025-01', 0],
    ['google', 'gemini-2.5-pro*',      1.25, 10.0, 0.0,  0.0, 'USD', '2025-01-01', '官网 2025-01', 0],
    // DeepSeek (CNY — 国内 API)
    ['deepseek', 'deepseek-r1*',       4.0,  16.0, 1.0,  0.0, 'CNY', '2025-01-01', 'platform.deepseek.com 2025-01', 0],
    ['deepseek', 'deepseek-v3*',       2.0,   8.0, 0.5,  0.0, 'CNY', '2025-01-01', 'platform.deepseek.com 2025-01', 0],
    // 智谱 GLM (CNY — 国内 API)
    ['glm', 'glm-5-code*',             4.0, 18.0,  0.0,  0.0, 'CNY', '2026-02-01', 'bigmodel.cn 2026-02', 0],
    ['glm', 'glm-5*',                  4.0, 18.0,  0.0,  0.0, 'CNY', '2026-02-01', 'bigmodel.cn 2026-02', 0],
    ['glm', 'glm-4.7-flash*',          0.0,  0.0,  0.0,  0.0, 'CNY', '2026-02-01', 'bigmodel.cn 2026-02 免费', 0],
    ['glm', 'glm-4.7*',                5.0,  5.0,  0.0,  0.0, 'CNY', '2026-02-01', 'bigmodel.cn 2026-02', 0],
    ['glm', 'glm-4.6*',                5.0,  5.0,  0.0,  0.0, 'CNY', '2026-02-01', 'bigmodel.cn 2026-02', 0],
    ['glm', 'glm-4.5-flash*',          0.0,  0.0,  0.0,  0.0, 'CNY', '2026-02-01', 'bigmodel.cn 2026-02 免费', 0],
    ['glm', 'glm-4.5-airx*',          10.0, 10.0,  0.0,  0.0, 'CNY', '2026-02-01', 'bigmodel.cn 2026-02', 0],
    ['glm', 'glm-4.5-air*',            0.5,  0.5,  0.0,  0.0, 'CNY', '2026-02-01', 'bigmodel.cn 2026-02', 0],
    ['glm', 'glm-4.5-x*',             10.0, 10.0,  0.0,  0.0, 'CNY', '2026-02-01', 'bigmodel.cn 2026-02', 0],
    ['glm', 'glm-4.5*',                5.0,  5.0,  0.0,  0.0, 'CNY', '2026-02-01', 'bigmodel.cn 2026-02', 0],
    // Ollama (free)
    ['ollama', '*',                     0.0,  0.0, 0.0,  0.0, 'USD', '2025-01-01', '本地免费', 0],
  ]

  const tx = db.transaction(() => {
    for (const [provider, pattern, inp, out, cacheR, cacheW, currency, from, source, priority] of rules) {
      insert.run(provider, pattern, inp, out, cacheR, cacheW, currency, from, source, priority, provider, pattern)
    }
  })
  tx()
}

/** 写入字段注释元数据（幂等：INSERT OR REPLACE） */
function seedSchemaComments(db: DatabaseType): void {
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO schema_comments (table_name, column_name, comment) VALUES (?, ?, ?)
  `)

  const comments: Array<[string, string, string]> = [
    // usage_logs
    ['usage_logs', 'id',              '自增主键'],
    ['usage_logs', 'session_id',      '所属会话 ID'],
    ['usage_logs', 'timestamp',       '记录时间 (ISO 8601)'],
    ['usage_logs', 'provider',        'LLM 供应商 (anthropic/openai/google/deepseek/ollama)'],
    ['usage_logs', 'model',           '模型标识 (claude-opus-4-6/gpt-4o/...)'],
    ['usage_logs', 'input_tokens',    '输入 token 数'],
    ['usage_logs', 'output_tokens',   '输出 token 数'],
    ['usage_logs', 'cache_read',      '缓存读取 token 数'],
    ['usage_logs', 'cache_write',     '缓存写入 token 数'],
    ['usage_logs', 'duration_ms',     'LLM 调用耗时（毫秒）'],
    ['usage_logs', 'cost_amount',     '计算费用（美元），无匹配规则时为 NULL'],
    ['usage_logs', 'cost_currency',   '费用币种'],
    ['usage_logs', 'pricing_rule_id', '匹配的计价规则 ID'],
    // pricing_rules
    ['pricing_rules', 'id',                '自增主键'],
    ['pricing_rules', 'provider',          'LLM 供应商'],
    ['pricing_rules', 'model_pattern',     '模型匹配模式（支持末尾 * 通配符）'],
    ['pricing_rules', 'input_price',       '输入价格 ($/百万 token)'],
    ['pricing_rules', 'output_price',      '输出价格 ($/百万 token)'],
    ['pricing_rules', 'cache_read_price',  '缓存读取价格 ($/百万 token)'],
    ['pricing_rules', 'cache_write_price', '缓存写入价格 ($/百万 token)'],
    ['pricing_rules', 'currency',          '价格币种'],
    ['pricing_rules', 'effective_from',    '生效起始日期 (ISO 8601)'],
    ['pricing_rules', 'effective_to',      '生效截止日期（NULL 表示永久有效）'],
    ['pricing_rules', 'source',            '价格来源说明'],
    ['pricing_rules', 'priority',          '匹配优先级（越大越优先）'],
    // schema_comments
    ['schema_comments', 'table_name',  '所属表名'],
    ['schema_comments', 'column_name', '字段名'],
    ['schema_comments', 'comment',     '字段说明'],
  ]

  const tx = db.transaction(() => {
    for (const [table, column, comment] of comments) {
      upsert.run(table, column, comment)
    }
  })
  tx()
}
