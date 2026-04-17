// src/persistence/db.ts

/**
 * SQLite 懒加载单例 — 版本化迁移框架。
 *
 * 首次 getDb() 调用时：
 * 1. 创建 ~/.ccode/data/ 目录
 * 2. 打开 ccode.db
 * 3. 执行 runMigrations()（建表、加字段、种子数据全在 migrations 里）
 *
 * 版本管理：
 * - 主 schema 用 PRAGMA user_version（usage_logs / pricing_rules / schema_comments / memory_meta）
 * - memory_vectors 用 memory_meta.vectors_schema_version（维度是运行时参数，延迟建表）
 */

import Database from 'libsql'
import type { Database as DatabaseType } from 'libsql'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'

let _db: DatabaseType | null = null

// ═══════════════════════════════════════════════
// 迁移框架
// ═══════════════════════════════════════════════

type MigrationFn = (db: DatabaseType) => void

/**
 * 迁移函数数组 — 按索引顺序执行。
 *
 * migrations[0] = v0 → v1（基线建表，包含全部表）
 * migrations[N] = vN → v(N+1)（未来扩展...）
 *
 * 约定：
 * - 每个函数接收 db 实例，内部自行执行 SQL
 * - 破坏性迁移（DROP TABLE）只允许出现在早期版本（用户量小时）
 * - 数据迁移（INSERT/UPDATE）放在同一个函数内，和 DDL 一起执行
 * - 函数内部不设置 user_version（由 runMigrations 统一设置）
 */
const migrations: MigrationFn[] = [
  // ══════════════════════════════════════════════
  // v0 → v1：基线 schema — 全量建表
  // ══════════════════════════════════════════════
  // 全新安装或旧库（无版本号）统一走这里。
  //
  // ⚠️ 本次迁移会清空全部历史数据（usage_logs / pricing_rules / memory_vectors）。
  // 当前阶段项目处于早期迭代，历史数据价值有限，可以接受。
  (db) => {
    // ── 1. 清理旧表 ──
    db.exec('DROP TABLE IF EXISTS usage_logs')
    db.exec('DROP TABLE IF EXISTS pricing_rules')
    db.exec('DROP TABLE IF EXISTS schema_comments')
    db.exec('DROP TABLE IF EXISTS memory_meta')
    db.exec('DROP TABLE IF EXISTS memory_vectors')
    db.exec('DROP INDEX IF EXISTS idx_memory_vec')

    // ── 2. 观测层：Token 使用记录 + 性能指标 ──
    db.exec(`
      CREATE TABLE usage_logs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      TEXT NOT NULL,
        timestamp       TEXT NOT NULL,
        provider        TEXT NOT NULL,
        model           TEXT NOT NULL,
        input_tokens    INTEGER NOT NULL,
        output_tokens   INTEGER NOT NULL,
        cache_read      INTEGER NOT NULL DEFAULT 0,
        cache_write     INTEGER NOT NULL DEFAULT 0,
        duration_ms     INTEGER,
        ttft_ms         INTEGER,
        tps             REAL,
        cost_amount     REAL,
        cost_currency   TEXT NOT NULL DEFAULT 'USD',
        pricing_rule_id INTEGER
      );
      CREATE INDEX idx_usage_session   ON usage_logs(session_id);
      CREATE INDEX idx_usage_timestamp ON usage_logs(timestamp);
    `)

    // ── 3. 计价规则 ──
    db.exec(`
      CREATE TABLE pricing_rules (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        provider          TEXT NOT NULL,
        model_pattern     TEXT NOT NULL,
        input_price       REAL NOT NULL,
        output_price      REAL NOT NULL,
        cache_read_price  REAL NOT NULL DEFAULT 0,
        cache_write_price REAL NOT NULL DEFAULT 0,
        currency          TEXT NOT NULL DEFAULT 'USD',
        effective_from    TEXT NOT NULL,
        effective_to      TEXT,
        source            TEXT,
        priority          INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_pricing_lookup
        ON pricing_rules(provider, model_pattern, effective_from);
    `)

    // ── 4. 字段注释元数据 ──
    db.exec(`
      CREATE TABLE schema_comments (
        table_name    TEXT NOT NULL,
        column_name   TEXT NOT NULL,
        comment       TEXT NOT NULL,
        PRIMARY KEY (table_name, column_name)
      );
    `)

    // ── 5. 记忆系统配置 ──
    // memory_vectors 延迟建表：维度由 EmbeddingProvider 动态决定，
    // 在 ensureMemoryVectors(dimension) 时按需创建。
    db.exec(`
      CREATE TABLE memory_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    // ── 6. 种子数据 ──
    seedDefaultPricing(db)
    seedSchemaComments(db)
  },
]

/** 目标版本 = migrations 数组长度 */
const SCHEMA_VERSION = migrations.length

/**
 * 执行数据库迁移。
 *
 * 读取 user_version → 事务内逐个执行待跑的迁移 → 成功后更新 user_version。
 *
 * ⚠️ PRAGMA user_version 不参与事务回滚（它写在 DB 文件头，不受 rollback 影响）。
 * 因此必须放在事务外面，迁移事务成功后再设置。
 */
function runMigrations(db: DatabaseType): void {
  const rows = db.pragma('user_version') as Array<{ user_version: number }>
  const current = rows[0]?.user_version ?? 0

  if (current >= SCHEMA_VERSION) return

  // 逐个执行迁移（不套外层事务——migration 内部的 seed 函数自带事务，
  // SQLite 不支持嵌套事务，外层包裹会导致 "cannot start a transaction within a transaction"）
  for (let i = current; i < SCHEMA_VERSION; i++) {
    const migration = migrations[i]
    if (migration) migration(db)
  }

  // 迁移成功后才更新版本号（PRAGMA 不受事务保护，必须放在最后）
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}

// ═══════════════════════════════════════════════
// 公共 API
// ═══════════════════════════════════════════════

/** 创建并初始化数据库（可注入路径，测试用） */
export function createDb(dbPath: string): DatabaseType {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)

  return db
}

/** 获取全局单例（懒加载） */
export function getDb(): DatabaseType {
  if (_db) return _db
  const dataDir = join(homedir(), '.ccode', 'data')
  mkdirSync(dataDir, { recursive: true })
  _db = createDb(join(dataDir, 'ccode.db'))
  return _db
}

/** 关闭数据库连接（进程退出时调用） */
export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

// ═══════════════════════════════════════════════
// memory_vectors：延迟建表 + 维度感知重建
// ═══════════════════════════════════════════════

/** memory_vectors schema 版本 */
const VECTORS_SCHEMA_VERSION = 1

/**
 * 确保 memory_vectors 表存在且 schema 正确。
 *
 * 调用时机：LibsqlVectorStore.initialize()
 * 调用者传入 dimension，本函数负责：
 *   1. 维度变化 → DROP + 重建（向量索引不支持动态修改维度）
 *   2. vectors_schema_version 落后 → 执行增量迁移
 *   3. 全部到位 → 跳过
 *
 * @param dimension 向量维度（如 1024、1536）。传 0 表示不建向量表（纯 BM25 模式）
 */
export function ensureMemoryVectors(dimension: number): void {
  const db = getDb()

  if (dimension <= 0) return

  // 检查维度是否变化
  const existingDim = getMemoryMeta(db, 'embedding_dimension')
  if (existingDim !== null && parseInt(existingDim, 10) !== dimension) {
    // 维度变化：必须 DROP 重建（F32_BLOB 维度写死在列定义里）
    db.exec('DROP TABLE IF EXISTS memory_vectors')
    db.exec('DROP INDEX IF EXISTS idx_memory_vec')
    setMemoryMeta(db, 'vectors_schema_version', '0')
  }

  // 检查 schema 版本
  const currentVer = parseInt(getMemoryMeta(db, 'vectors_schema_version') ?? '0', 10)

  if (currentVer < VECTORS_SCHEMA_VERSION) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        id          TEXT PRIMARY KEY,
        entry_id    TEXT NOT NULL,
        scope       TEXT NOT NULL,
        project_slug TEXT,
        embedding   F32_BLOB(${dimension}),
        chunk_text  TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        tags        TEXT,
        type        TEXT NOT NULL,
        source      TEXT NOT NULL,
        created     TEXT NOT NULL,
        updated     TEXT NOT NULL
      );
    `)

    // DiskANN 向量索引
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_vec
        ON memory_vectors(libsql_vector_idx(embedding));
    `)

    // 常规索引
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_entry_id
        ON memory_vectors(entry_id);
      CREATE INDEX IF NOT EXISTS idx_memory_scope
        ON memory_vectors(scope);
    `)

    setMemoryMeta(db, 'vectors_schema_version', String(VECTORS_SCHEMA_VERSION))
  }

  // 记录当前维度
  setMemoryMeta(db, 'embedding_dimension', String(dimension))
}

/**
 * 获取已存储的 embedding 维度。
 * 未初始化或纯 BM25 模式返回 null。
 */
export function getStoredEmbeddingDimension(): number | null {
  const db = getDb()
  const val = getMemoryMeta(db, 'embedding_dimension')
  return val ? parseInt(val, 10) : null
}

// ═══════════════════════════════════════════════
// memory_meta 辅助函数
// ═══════════════════════════════════════════════

function getMemoryMeta(db: DatabaseType, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM memory_meta WHERE key = ?')
      .get(key) as { value: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function setMemoryMeta(db: DatabaseType, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)')
    .run(key, value)
}

// ═══════════════════════════════════════════════
// 种子数据
// ═══════════════════════════════════════════════

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
    // Anthropic (USD) — claude.com/docs/pricing 2026-03
    ['anthropic', 'claude-opus-4-*',    5.0,  25.0, 0.50, 6.25,  'USD', '2026-01-01', 'anthropic 2026-03', 0],
    ['anthropic', 'claude-sonnet-4-*',  3.0,  15.0, 0.30, 3.75,  'USD', '2026-01-01', 'anthropic 2026-03', 0],
    ['anthropic', 'claude-haiku-4-*',   1.0,   5.0, 0.10, 1.25,  'USD', '2026-01-01', 'anthropic 2026-03', 0],
    // Google Gemini (USD) — ai.google.dev/pricing 2026-03
    ['google', 'gemini-3-pro*',         2.0,  12.0, 0.20, 0.0,   'USD', '2026-01-01', 'google 2026-03 preview', 0],
    ['google', 'gemini-2.5-pro*',       1.25, 10.0, 0.125, 0.0,  'USD', '2026-01-01', 'google 2026-03', 0],
    // DeepSeek (CNY) — platform.deepseek.com 2025
    ['deepseek', 'deepseek-r1*',        4.0,  16.0, 1.0,  0.0,   'CNY', '2025-01-01', 'deepseek 2025', 0],
    ['deepseek', 'deepseek-v3*',        2.0,   8.0, 0.5,  0.0,   'CNY', '2025-01-01', 'deepseek 2025', 0],
    // 智谱 GLM (CNY) — bigmodel.cn 2026-02
    ['glm', 'glm-5*',                   4.0,  18.0, 0.0,  0.0,   'CNY', '2026-02-01', 'bigmodel.cn 2026-02', 0],
    ['glm', 'glm-4.7-flash*',           0.0,   0.0, 0.0,  0.0,   'CNY', '2026-02-01', 'bigmodel.cn 2026-02 免费', 0],
    ['glm', 'glm-4.7*',                 5.0,   5.0, 0.0,  0.0,   'CNY', '2026-02-01', 'bigmodel.cn 2026-02', 0],
    // MiniMax (USD) — minimaxi.com 2026-02
    ['minimax', 'minimax-m2.5*',         0.3,   2.4, 0.0,  0.0,  'USD', '2026-02-01', 'minimaxi.com 2026-02', 0],
    ['minimax', 'minimax-m2*',           0.3,   1.2, 0.03, 0.0,  'USD', '2026-02-01', 'minimaxi.com 2026-02', 0],
    // Ollama / 本地模型 (free)
    ['ollama', '*',                      0.0,   0.0, 0.0,  0.0,  'USD', '2025-01-01', '本地免费', 0],
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
    ['usage_logs', 'duration_ms',     'LLM 调用端到端耗时（毫秒）— E2E Latency'],
    ['usage_logs', 'ttft_ms',         '首 Token 延迟（毫秒）— Time To First Token'],
    ['usage_logs', 'tps',             '输出吞吐率（tokens/sec）— Tokens Per Second'],
    ['usage_logs', 'cost_amount',     '计算费用，无匹配规则时为 NULL'],
    ['usage_logs', 'cost_currency',   '费用币种'],
    ['usage_logs', 'pricing_rule_id', '匹配的计价规则 ID'],
    // pricing_rules
    ['pricing_rules', 'id',                '自增主键'],
    ['pricing_rules', 'provider',          'LLM 供应商'],
    ['pricing_rules', 'model_pattern',     '模型匹配模式（支持末尾 * 通配符）'],
    ['pricing_rules', 'input_price',       '输入价格 (货币/百万 token)'],
    ['pricing_rules', 'output_price',      '输出价格 (货币/百万 token)'],
    ['pricing_rules', 'cache_read_price',  '缓存读取价格 (货币/百万 token)'],
    ['pricing_rules', 'cache_write_price', '缓存写入价格 (货币/百万 token)'],
    ['pricing_rules', 'currency',          '价格币种'],
    ['pricing_rules', 'effective_from',    '生效起始日期 (ISO 8601)'],
    ['pricing_rules', 'effective_to',      '生效截止日期（NULL 表示永久有效）'],
    ['pricing_rules', 'source',            '价格来源说明'],
    ['pricing_rules', 'priority',          '匹配优先级（越大越优先）'],
    // schema_comments
    ['schema_comments', 'table_name',  '所属表名'],
    ['schema_comments', 'column_name', '字段名'],
    ['schema_comments', 'comment',     '字段说明'],
    // memory_meta
    ['memory_meta', 'key',   '配置键名'],
    ['memory_meta', 'value', '配置值'],
  ]

  const tx = db.transaction(() => {
    for (const [table, column, comment] of comments) {
      upsert.run(table, column, comment)
    }
  })
  tx()
}
