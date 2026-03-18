import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `zcli-write-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('WriteFileTool', () => {
  it('写入新文件', async () => {
    const { WriteFileTool } = await import('@tools/core/write-file.js')
    const tool = new WriteFileTool()
    const filePath = join(testDir, 'new.ts')
    const result = await tool.execute({ path: filePath, content: 'hello' }, { cwd: testDir })
    expect(result.success).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe('hello')
  })

  it('覆盖已有文件', async () => {
    const { WriteFileTool } = await import('@tools/core/write-file.js')
    const tool = new WriteFileTool()
    const filePath = join(testDir, 'exist.ts')
    await tool.execute({ path: filePath, content: 'old' }, { cwd: testDir })
    await tool.execute({ path: filePath, content: 'new' }, { cwd: testDir })
    expect(readFileSync(filePath, 'utf-8')).toBe('new')
  })

  it('自动创建父目录', async () => {
    const { WriteFileTool } = await import('@tools/core/write-file.js')
    const tool = new WriteFileTool()
    const filePath = join(testDir, 'a', 'b', 'c.ts')
    const result = await tool.execute({ path: filePath, content: 'deep' }, { cwd: testDir })
    expect(result.success).toBe(true)
    expect(existsSync(filePath)).toBe(true)
  })

  it('dangerous 为 true', async () => {
    const { WriteFileTool } = await import('@tools/core/write-file.js')
    expect(new WriteFileTool().dangerous).toBe(true)
  })
})

describe('EditFileTool', () => {
  it('替换文件中的字符串', async () => {
    const { WriteFileTool } = await import('@tools/core/write-file.js')
    const { EditFileTool } = await import('@tools/core/edit-file.js')
    const filePath = join(testDir, 'edit.ts')
    await new WriteFileTool().execute({ path: filePath, content: 'const x = 1\nconst y = 2\n' }, { cwd: testDir })
    const result = await new EditFileTool().execute(
      { path: filePath, old_str: 'const x = 1', new_str: 'const x = 99' },
      { cwd: testDir }
    )
    expect(result.success).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toContain('const x = 99')
  })

  it('old_str 不存在时返回错误', async () => {
    const { WriteFileTool } = await import('@tools/core/write-file.js')
    const { EditFileTool } = await import('@tools/core/edit-file.js')
    const filePath = join(testDir, 'edit2.ts')
    await new WriteFileTool().execute({ path: filePath, content: 'hello' }, { cwd: testDir })
    const result = await new EditFileTool().execute(
      { path: filePath, old_str: 'nonexistent', new_str: 'x' },
      { cwd: testDir }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('dangerous 为 true', async () => {
    const { EditFileTool } = await import('@tools/core/edit-file.js')
    expect(new EditFileTool().dangerous).toBe(true)
  })
})
