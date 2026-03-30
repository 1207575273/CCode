import { describe, it, expect, beforeEach } from 'vitest'
import { VerifyCodeTool } from '@tools/ext/verify-code.js'
import type { ToolContext } from '@tools/core/types.js'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tool = new VerifyCodeTool()

// 临时测试目录
const testDir = join(tmpdir(), 'ccode-verify-test-' + Date.now())
const ctx: ToolContext = { cwd: testDir }

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true })
  mkdirSync(testDir, { recursive: true })
})

describe('VerifyCodeTool', () => {
  it('should have correct name and not dangerous', () => {
    expect(tool.name).toBe('verify_code')
    expect(tool.dangerous).toBe(false)
  })

  it('should reject empty file_path', async () => {
    const result = await tool.execute({ file_path: '' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('file_path')
  })

  it('should reject non-existent file', async () => {
    const result = await tool.execute({ file_path: '/non/existent/file.ts' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('不存在')
  })

  it('should return warning for unsupported file type', async () => {
    const mdFile = join(testDir, 'readme.md')
    writeFileSync(mdFile, '# Hello')
    const result = await tool.execute({ file_path: mdFile }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('No supported checker')
    expect(result.output).toContain('.md')
  })

  it('should return warning when no project config found', async () => {
    // .ts 文件但没有 tsconfig.json
    const tsFile = join(testDir, 'test.ts')
    writeFileSync(tsFile, 'const x: number = 1')
    const result = await tool.execute({ file_path: tsFile }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('No project config')
    expect(result.output).toContain('tsconfig.json')
  })

  it('should detect TypeScript project and run tsc', async () => {
    // 创建 tsconfig.json + 有效 ts 文件
    writeFileSync(join(testDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'ESNext' },
      include: ['*.ts'],
    }))
    const tsFile = join(testDir, 'valid.ts')
    writeFileSync(tsFile, 'export const x: number = 42\n')

    const result = await tool.execute({ file_path: tsFile }, ctx)
    // tsc 应该通过（简单的合法文件）
    expect(result.output).toContain('TypeScript')
  }, 30000)

  it('should detect TypeScript errors', async () => {
    writeFileSync(join(testDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'ESNext' },
      include: ['*.ts'],
    }))
    const tsFile = join(testDir, 'broken.ts')
    // 故意写类型错误
    writeFileSync(tsFile, 'const x: number = "not a number"\n')

    const result = await tool.execute({ file_path: tsFile }, ctx)
    expect(result.success).toBe(false)
    expect(result.output).toContain('TypeScript')
    expect(result.output).toContain('error')
  }, 30000)

  it('should support explicit check_type parameter', async () => {
    const pyFile = join(testDir, 'test.py')
    writeFileSync(pyFile, 'print("hello")')
    // 强制指定 python，但没有 pyproject.toml
    const result = await tool.execute({ file_path: pyFile, check_type: 'python' }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('No project config')
  })

  it('should resolve relative path from cwd', async () => {
    const tsFile = join(testDir, 'relative.ts')
    writeFileSync(tsFile, 'export const y = 1')
    const result = await tool.execute({ file_path: 'relative.ts' }, ctx)
    // 相对路径应被正确解析，不报"文件不存在"
    expect(result.error ?? '').not.toContain('不存在')
  })
})
