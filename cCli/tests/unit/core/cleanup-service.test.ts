// tests/unit/core/cleanup-service.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb } from '@persistence/db.js'
import type { Database } from 'libsql'
import { getCleanupStats, executeCleanup } from '@core/cleanup-service.js'

let db: Database

// 向 usage_logs 插入测试记录的辅助函数
function insertUsageLog(sessionId: string, timestamp: string): void {
  db.prepare(
    `INSERT INTO usage_logs
      (session_id, timestamp, provider, model, input_tokens, output_tokens, cache_read, cache_write, cost_amount, cost_currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, timestamp, 'test', 'test-model', 100, 50, 0, 0, null, 'USD')
}

/** 生成 N 天前的 ISO 时间戳 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

beforeEach(() => {
  db = createDb(':memory:')
})

afterEach(() => {
  db.close()
})

describe('CleanupService — usage_logs 统计 (dry-run)', () => {
  it('空数据库统计全零', () => {
    const stats = getCleanupStats({ target: 'usage', _db: db })
    expect(stats.usage.totalRows).toBe(0)
    expect(stats.usage.expiredRows).toBe(0)
  })

  it('有过期记录时正确统计 expiredRows', () => {
    // 插入 2 条 100 天前记录 + 1 条今天记录
    insertUsageLog('s1', daysAgo(100))
    insertUsageLog('s1', daysAgo(100))
    insertUsageLog('s1', new Date().toISOString())

    const stats = getCleanupStats({ target: 'usage', usageRetentionDays: 90, _db: db })
    expect(stats.usage.totalRows).toBe(3)
    expect(stats.usage.expiredRows).toBe(2)
  })

  it('无过期记录时 expiredRows 为零', () => {
    // 只插入最近记录
    insertUsageLog('s1', daysAgo(10))
    insertUsageLog('s1', daysAgo(5))

    const stats = getCleanupStats({ target: 'usage', usageRetentionDays: 90, _db: db })
    expect(stats.usage.totalRows).toBe(2)
    expect(stats.usage.expiredRows).toBe(0)
  })

  it('target=sessions 时 usage 统计全零（不查 DB）', () => {
    insertUsageLog('s1', daysAgo(100))

    // target=sessions 时 usage 部分应返回全零，不访问 DB
    const stats = getCleanupStats({ target: 'sessions', _db: db })
    expect(stats.usage.totalRows).toBe(0)
    expect(stats.usage.expiredRows).toBe(0)
  })
})

describe('CleanupService — usage_logs 实际清理', () => {
  it('删除过期记录并返回删除数', () => {
    insertUsageLog('s1', daysAgo(100))
    insertUsageLog('s1', new Date().toISOString())

    const result = executeCleanup({ target: 'usage', usageRetentionDays: 90, _db: db })
    expect(result.deletedUsageRows).toBe(1)

    // 验证数据库中只剩 1 条
    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM usage_logs').get() as { cnt: number }
    expect(remaining.cnt).toBe(1)
  })

  it('无过期记录时 deletedUsageRows 为零', () => {
    insertUsageLog('s1', daysAgo(10))

    const result = executeCleanup({ target: 'usage', usageRetentionDays: 90, _db: db })
    expect(result.deletedUsageRows).toBe(0)

    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM usage_logs').get() as { cnt: number }
    expect(remaining.cnt).toBe(1)
  })

  it('target=sessions 时不删除 usage_logs', () => {
    insertUsageLog('s1', daysAgo(100))

    const result = executeCleanup({ target: 'sessions', _db: db })
    expect(result.deletedUsageRows).toBe(0)

    // usage_logs 记录应保持不变
    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM usage_logs').get() as { cnt: number }
    expect(remaining.cnt).toBe(1)
  })

  it('target=usage 时 deletedSessionFiles 和 deletedSessionBytes 为零', () => {
    const result = executeCleanup({ target: 'usage', _db: db })
    expect(result.deletedSessionFiles).toBe(0)
    expect(result.deletedSessionBytes).toBe(0)
  })

  it('删除所有过期记录（批量）', () => {
    for (let i = 0; i < 5; i++) {
      insertUsageLog(`s${i}`, daysAgo(100 + i))
    }
    // 插入 2 条不过期的
    insertUsageLog('s5', daysAgo(30))
    insertUsageLog('s6', new Date().toISOString())

    const result = executeCleanup({ target: 'usage', usageRetentionDays: 90, _db: db })
    expect(result.deletedUsageRows).toBe(5)

    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM usage_logs').get() as { cnt: number }
    expect(remaining.cnt).toBe(2)
  })
})
