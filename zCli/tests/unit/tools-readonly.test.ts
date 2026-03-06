import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `zcli-tools-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  writeFileSync(join(testDir, 'hello.ts'), 'export const hello = "world"\n// greeting function\n')
  writeFileSync(join(testDir, 'other.ts'), 'export const other = 42\n')
  mkdirSync(join(testDir, 'sub'), { recursive: true })
  writeFileSync(join(testDir, 'sub', 'nested.ts'), 'nested content\n')
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

// ---- read_file ----
describe('ReadFileTool', () => {
  it('读取文件内容', async () => {
    const { ReadFileTool } = await import('@tools/read-file.js')
    const tool = new ReadFileTool()
    const result = await tool.execute({ path: join(testDir, 'hello.ts') }, { cwd: testDir })
    expect(result.success).toBe(true)
    expect(result.output).toContain('hello')
  })

  it('文件不存在返回错误', async () => {
    const { ReadFileTool } = await import('@tools/read-file.js')
    const tool = new ReadFileTool()
    const result = await tool.execute({ path: join(testDir, 'nope.ts') }, { cwd: testDir })
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('dangerous 为 false', async () => {
    const { ReadFileTool } = await import('@tools/read-file.js')
    expect(new ReadFileTool().dangerous).toBe(false)
  })
})

// ---- glob ----
describe('GlobTool', () => {
  it('匹配 *.ts 返回文件列表', async () => {
    const { GlobTool } = await import('@tools/glob.js')
    const tool = new GlobTool()
    const result = await tool.execute({ pattern: '**/*.ts', cwd: testDir }, { cwd: testDir })
    expect(result.success).toBe(true)
    expect(result.output).toContain('hello.ts')
    expect(result.output).toContain('other.ts')
  })

  it('无匹配时返回空列表提示', async () => {
    const { GlobTool } = await import('@tools/glob.js')
    const tool = new GlobTool()
    const result = await tool.execute({ pattern: '*.py', cwd: testDir }, { cwd: testDir })
    expect(result.success).toBe(true)
    expect(result.output).toContain('No files')
  })
})

// ---- grep ----
describe('GrepTool', () => {
  it('搜索内容返回匹配行', async () => {
    const { GrepTool } = await import('@tools/grep.js')
    const tool = new GrepTool()
    const result = await tool.execute(
      { pattern: 'greeting', path: testDir, recursive: true },
      { cwd: testDir }
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('greeting')
  })

  it('无匹配时返回提示', async () => {
    const { GrepTool } = await import('@tools/grep.js')
    const tool = new GrepTool()
    const result = await tool.execute(
      { pattern: 'nonexistent_xyz', path: testDir, recursive: true },
      { cwd: testDir }
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('No matches')
  })
})
