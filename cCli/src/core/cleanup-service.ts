// src/core/cleanup-service.ts

/**
 * CleanupService — 会话与数据清理服务。
 *
 * 提供 dry-run 统计和实际清理两个主要操作，
 * 支持按 sessions / usage 分别或同时清理。
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'libsql'
import { sessionStore } from '@persistence/index.js'
import { getDb } from '@persistence/db.js'

const DEFAULT_SESSION_RETENTION_DAYS = 30
const DEFAULT_USAGE_RETENTION_DAYS = 90

export interface CleanupStats {
  sessions: {
    totalFiles: number
    totalSizeBytes: number
    expiredFiles: number
    expiredSizeBytes: number
  }
  usage: {
    totalRows: number
    expiredRows: number
  }
}

export interface CleanupOptions {
  sessionRetentionDays?: number | undefined
  usageRetentionDays?: number | undefined
  /** 只清理 sessions / 只清理 usage / 默认两者都清 */
  target?: 'sessions' | 'usage' | 'all' | undefined
  /** 当前活跃的 sessionId，不清理 */
  activeSessionId?: string | undefined
  /**
   * 可注入的 DB 实例（主要用于测试），不传则使用全局单例。
   * @internal
   */
  _db?: Database | undefined
}

export interface CleanupResult {
  deletedSessionFiles: number
  deletedSessionBytes: number
  deletedUsageRows: number
}

/**
 * 统计将被清理的数据量（dry-run）。
 */
export function getCleanupStats(options: CleanupOptions = {}): CleanupStats {
  const sessionDays = options.sessionRetentionDays ?? DEFAULT_SESSION_RETENTION_DAYS
  const usageDays = options.usageRetentionDays ?? DEFAULT_USAGE_RETENTION_DAYS
  const target = options.target ?? 'all'
  const db = options._db ?? getDb()

  const sessions =
    target === 'all' || target === 'sessions'
      ? scanSessionFiles(sessionDays)
      : { totalFiles: 0, totalSizeBytes: 0, expiredFiles: 0, expiredSizeBytes: 0 }

  const usage =
    target === 'all' || target === 'usage'
      ? scanUsageLogs(usageDays, db)
      : { totalRows: 0, expiredRows: 0 }

  return { sessions, usage }
}

/**
 * 执行实际清理。
 */
export function executeCleanup(options: CleanupOptions = {}): CleanupResult {
  const sessionDays = options.sessionRetentionDays ?? DEFAULT_SESSION_RETENTION_DAYS
  const usageDays = options.usageRetentionDays ?? DEFAULT_USAGE_RETENTION_DAYS
  const target = options.target ?? 'all'
  const db = options._db ?? getDb()

  let deletedSessionFiles = 0
  let deletedSessionBytes = 0
  let deletedUsageRows = 0

  // 清理会话文件
  if (target === 'all' || target === 'sessions') {
    const before = scanSessionFiles(sessionDays)
    sessionStore.cleanup(sessionDays)
    deletedSessionFiles = before.expiredFiles
    deletedSessionBytes = before.expiredSizeBytes
  }

  // 清理 usage_logs
  if (target === 'all' || target === 'usage') {
    deletedUsageRows = deleteExpiredUsageLogs(usageDays, db)
  }

  return { deletedSessionFiles, deletedSessionBytes, deletedUsageRows }
}

// ═══ 内部辅助 ═══

function scanSessionFiles(retentionDays: number): CleanupStats['sessions'] {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const baseDir = sessionStore.baseDir
  let totalFiles = 0
  let totalSizeBytes = 0
  let expiredFiles = 0
  let expiredSizeBytes = 0

  let slugs: string[]
  try {
    slugs = readdirSync(baseDir)
  } catch {
    return { totalFiles, totalSizeBytes, expiredFiles, expiredSizeBytes }
  }

  for (const slug of slugs) {
    const dir = join(baseDir, slug)
    let entries: string[]
    try {
      entries = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const entry of entries) {
      try {
        const stat = statSync(join(dir, entry))
        totalFiles++
        totalSizeBytes += stat.size
        if (stat.mtime.getTime() < cutoff) {
          expiredFiles++
          expiredSizeBytes += stat.size
        }
      } catch {
        continue
      }
    }
  }

  return { totalFiles, totalSizeBytes, expiredFiles, expiredSizeBytes }
}

function scanUsageLogs(retentionDays: number, db: Database): CleanupStats['usage'] {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM usage_logs').get() as { cnt: number }
  const expiredRow = db
    .prepare('SELECT COUNT(*) as cnt FROM usage_logs WHERE timestamp < ?')
    .get(cutoff) as { cnt: number }
  return { totalRows: totalRow.cnt, expiredRows: expiredRow.cnt }
}

function deleteExpiredUsageLogs(retentionDays: number, db: Database): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const result = db.prepare('DELETE FROM usage_logs WHERE timestamp < ?').run(cutoff)
  // VACUUM 回收磁盘空间（仅在有删除时执行）
  if (result.changes > 0) {
    db.exec('VACUUM')
  }
  return result.changes
}
