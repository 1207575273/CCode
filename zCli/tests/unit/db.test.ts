import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDb } from '@persistence/db.js'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'db-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('createDb', () => {
  it('should_create_usage_logs_table', () => {
    const db = createDb(join(tempDir, 'test.db'))
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toContain('usage_logs')
    db.close()
  })

  it('should_create_pricing_rules_table', () => {
    const db = createDb(join(tempDir, 'test.db'))
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toContain('pricing_rules')
    db.close()
  })

  it('should_seed_default_pricing_rules', () => {
    const db = createDb(join(tempDir, 'test.db'))
    const count = db.prepare('SELECT COUNT(*) as cnt FROM pricing_rules').get() as { cnt: number }
    expect(count.cnt).toBeGreaterThan(0)
    db.close()
  })

  it('should_create_schema_comments_table_with_metadata', () => {
    const db = createDb(join(tempDir, 'test.db'))
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toContain('schema_comments')

    // 验证 usage_logs 的字段注释已 seed
    const comment = db.prepare(
      "SELECT comment FROM schema_comments WHERE table_name = 'usage_logs' AND column_name = 'input_tokens'"
    ).get() as { comment: string } | undefined
    expect(comment).toBeDefined()
    expect(comment!.comment).toBe('输入 token 数')
    db.close()
  })

  it('should_be_idempotent_on_second_call', () => {
    const dbPath = join(tempDir, 'test.db')
    const db1 = createDb(dbPath)
    const count1 = (db1.prepare('SELECT COUNT(*) as cnt FROM pricing_rules').get() as { cnt: number }).cnt
    db1.close()

    const db2 = createDb(dbPath)
    const count2 = (db2.prepare('SELECT COUNT(*) as cnt FROM pricing_rules').get() as { cnt: number }).cnt
    db2.close()

    expect(count2).toBe(count1)
  })
})
