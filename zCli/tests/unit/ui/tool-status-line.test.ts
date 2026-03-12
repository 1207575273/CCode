import { describe, it, expect } from 'vitest'
import { buildArgsSummary } from '@ui/ToolStatusLine.js'

describe('buildArgsSummary', () => {
  // ---- bash 工具 ----

  it('bash: 提取 command 参数', () => {
    const result = buildArgsSummary('bash', { command: 'ls -la' })
    expect(result).toBe('ls -la')
  })

  it('bash: 长命令截断到 80 字符', () => {
    const longCommand = 'a'.repeat(100)
    const result = buildArgsSummary('bash', { command: longCommand })
    expect(result).toHaveLength(80)
    expect(result).toBe('a'.repeat(77) + '...')
  })

  // ---- 文件操作工具 ----

  it('read_file: 提取 path', () => {
    const result = buildArgsSummary('read_file', { path: '/src/index.ts' })
    expect(result).toBe('/src/index.ts')
  })

  it('write_file: 提取 path', () => {
    const result = buildArgsSummary('write_file', { path: '/src/output.ts' })
    expect(result).toBe('/src/output.ts')
  })

  it('edit_file: 提取 path', () => {
    const result = buildArgsSummary('edit_file', { path: '/src/config.ts' })
    expect(result).toBe('/src/config.ts')
  })

  // ---- grep 工具 ----

  it('grep: 拼接 pattern + path', () => {
    const result = buildArgsSummary('grep', { pattern: 'TODO', path: 'src/' })
    expect(result).toBe('pattern: "TODO", path: src/')
  })

  it('grep: path 缺失时默认 .', () => {
    const result = buildArgsSummary('grep', { pattern: 'fixme' })
    expect(result).toBe('pattern: "fixme", path: .')
  })

  // ---- glob 工具 ----

  it('glob: 提取 pattern', () => {
    const result = buildArgsSummary('glob', { pattern: '**/*.ts' })
    expect(result).toBe('**/*.ts')
  })

  // ---- dispatch_agent 工具 ----

  it('dispatch_agent: 提取 description', () => {
    const result = buildArgsSummary('dispatch_agent', { description: '分析项目结构' })
    expect(result).toBe('分析项目结构')
  })

  // ---- 未知工具 ----

  it('未知工具: 提取第一个字符串值', () => {
    const result = buildArgsSummary('mcp_tool', { count: 42, query: 'hello world' })
    expect(result).toBe('hello world')
  })

  it('未知工具无字符串参数: 返回空字符串', () => {
    const result = buildArgsSummary('mcp_tool', { count: 42, flag: true })
    expect(result).toBe('')
  })

  // ---- 边界情况 ----

  it('args 为 undefined: 返回空字符串', () => {
    const result = buildArgsSummary('bash', undefined)
    expect(result).toBe('')
  })

  it('args 为空对象: 返回空字符串', () => {
    const result = buildArgsSummary('bash', {})
    expect(result).toBe('')
  })
})
