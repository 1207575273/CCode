import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'libsql'

/**
 * libsql 向量能力集成测试。
 *
 * 验证 libsql 内置的向量 API 在当前环境下真的可用：
 * - F32_BLOB 列类型
 * - vector32() 构造函数
 * - vector_distance_cos() 余弦距离
 * - WHERE 过滤 + 向量排序
 */

const DIM = 4

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return norm === 0 ? v : v.map(x => x / norm)
}

function vecJson(v: number[]): string {
  return `[${v.join(',')}]`
}

/** 每个测试用独立的内存数据库，避免表冲突和文件锁 */
function createTestDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE vec_test (
    id TEXT PRIMARY KEY,
    scope TEXT,
    embedding F32_BLOB(${DIM}),
    chunk_text TEXT
  )`)
  return db
}

describe('libsql 向量能力验证', () => {

  it('F32_BLOB 列类型可用 + vector32 构造 + 插入', () => {
    const db = createTestDb()
    const v = normalize([1, 0, 0, 0])
    db.prepare('INSERT INTO vec_test (id, embedding, chunk_text) VALUES (?, vector32(?), ?)').run('v1', vecJson(v), 'test')

    const count = db.prepare('SELECT count(*) AS cnt FROM vec_test').get() as { cnt: number }
    expect(count.cnt).toBe(1)
    db.close()
  })

  it('vector_distance_cos 余弦距离计算正确', () => {
    const db = createTestDb()
    const vBase = normalize([1, 0, 0, 0])
    const vSame = normalize([1, 0, 0, 0])
    const vOrtho = normalize([0, 1, 0, 0])
    const vOpposite = normalize([-1, 0, 0, 0])

    db.prepare('INSERT INTO vec_test (id, embedding, chunk_text) VALUES (?, vector32(?), ?)').run('same', vecJson(vSame), 'same')
    db.prepare('INSERT INTO vec_test (id, embedding, chunk_text) VALUES (?, vector32(?), ?)').run('ortho', vecJson(vOrtho), 'ortho')
    db.prepare('INSERT INTO vec_test (id, embedding, chunk_text) VALUES (?, vector32(?), ?)').run('opp', vecJson(vOpposite), 'opp')

    const rows = db.prepare(`
      SELECT id, vector_distance_cos(embedding, vector32(?)) AS dist
      FROM vec_test ORDER BY dist ASC
    `).all(vecJson(vBase)) as Array<{ id: string; dist: number }>

    // 完全相同 → 距离 ≈ 0
    expect(rows[0]!.id).toBe('same')
    expect(rows[0]!.dist).toBeCloseTo(0, 1)

    // 正交 → 距离 ≈ 1
    const ortho = rows.find(r => r.id === 'ortho')!
    expect(ortho.dist).toBeCloseTo(1, 1)

    // 完全相反 → 距离 ≈ 2
    const opp = rows.find(r => r.id === 'opp')!
    expect(opp.dist).toBeCloseTo(2, 1)

    db.close()
  })

  it('距离→相似度转换公式', () => {
    // score = 1 - (distance / 2)
    expect(1 - (0 / 2)).toBeCloseTo(1)    // 距离0 → 相似度1
    expect(1 - (1 / 2)).toBeCloseTo(0.5)  // 距离1 → 相似度0.5
    expect(1 - (2 / 2)).toBeCloseTo(0)    // 距离2 → 相似度0
  })

  it('完整 CRUD：插入→检索→删除', () => {
    const db = createTestDb()

    const vAuth = normalize([1, 0.5, 0, 0])
    const vFrontend = normalize([0, 1, 0.5, 0])
    const vDb = normalize([0, 0, 1, 0.5])

    db.prepare('INSERT INTO vec_test (id, scope, embedding, chunk_text) VALUES (?, ?, vector32(?), ?)').run('c1', 'project', vecJson(vAuth), '认证中间件')
    db.prepare('INSERT INTO vec_test (id, scope, embedding, chunk_text) VALUES (?, ?, vector32(?), ?)').run('c2', 'project', vecJson(vFrontend), '前端组件')
    db.prepare('INSERT INTO vec_test (id, scope, embedding, chunk_text) VALUES (?, ?, vector32(?), ?)').run('c3', 'project', vecJson(vDb), '数据库优化')

    // 用 vAuth 查询 → c1 排第一
    const results = db.prepare(`
      SELECT id, chunk_text, vector_distance_cos(embedding, vector32(?)) AS dist
      FROM vec_test ORDER BY dist ASC LIMIT 3
    `).all(vecJson(vAuth)) as Array<{ id: string; chunk_text: string; dist: number }>

    expect(results[0]!.id).toBe('c1')
    expect(results[0]!.chunk_text).toBe('认证中间件')
    expect(results[0]!.dist).toBeCloseTo(0, 1)

    // 删除
    db.prepare('DELETE FROM vec_test WHERE id = ?').run('c1')
    const remaining = db.prepare('SELECT count(*) AS cnt FROM vec_test').get() as { cnt: number }
    expect(remaining.cnt).toBe(2)

    db.close()
  })

  it('scope WHERE 过滤 + 向量排序', () => {
    const db = createTestDb()
    const v = normalize([1, 0, 0, 0])
    const vSimilar = normalize([0.9, 0.1, 0, 0])

    db.prepare('INSERT INTO vec_test (id, scope, embedding, chunk_text) VALUES (?, ?, vector32(?), ?)').run('c1', 'global', vecJson(v), '全局')
    db.prepare('INSERT INTO vec_test (id, scope, embedding, chunk_text) VALUES (?, ?, vector32(?), ?)').run('c2', 'project', vecJson(vSimilar), '项目')

    // 只搜 project
    const results = db.prepare(`
      SELECT id, vector_distance_cos(embedding, vector32(?)) AS dist
      FROM vec_test WHERE scope = ?
      ORDER BY dist ASC LIMIT 5
    `).all(vecJson(v), 'project') as Array<{ id: string; dist: number }>

    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe('c2')

    db.close()
  })
})
