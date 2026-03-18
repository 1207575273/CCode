import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '@tools/core/registry.js'
import type { Tool, ToolContext, ToolResult } from '@tools/core/types.js'

const mockTool = (name: string, dangerous = false): Tool => ({
  name,
  description: `mock ${name}`,
  parameters: { type: 'object', properties: {}, required: [] },
  dangerous,
  execute: async (_args, _ctx): Promise<ToolResult> => ({ success: true, output: `${name} result` }),
})

describe('ToolRegistry', () => {
  it('register + getAll 返回所有工具', () => {
    const reg = new ToolRegistry()
    reg.register(mockTool('read_file'))
    reg.register(mockTool('glob'))
    expect(reg.getAll()).toHaveLength(2)
    expect(reg.getAll().map(t => t.name)).toContain('read_file')
  })

  it('isDangerous 正确判断危险工具', () => {
    const reg = new ToolRegistry()
    reg.register(mockTool('read_file', false))
    reg.register(mockTool('write_file', true))
    expect(reg.isDangerous('read_file')).toBe(false)
    expect(reg.isDangerous('write_file')).toBe(true)
  })

  it('execute 调用对应工具', async () => {
    const reg = new ToolRegistry()
    reg.register(mockTool('read_file'))
    const ctx: ToolContext = { cwd: '/tmp' }
    const result = await reg.execute('read_file', {}, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toBe('read_file result')
  })

  it('execute 未知工具返回 error', async () => {
    const reg = new ToolRegistry()
    const result = await reg.execute('unknown', {}, { cwd: '/tmp' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('unknown')
  })

  it('has 返回工具是否已注册', () => {
    const reg = new ToolRegistry()
    reg.register(mockTool('read_file'))
    expect(reg.has('read_file')).toBe(true)
    expect(reg.has('nonexistent')).toBe(false)
  })

  it('toToolDefinitions 返回正确的 schema 格式', () => {
    const reg = new ToolRegistry()
    reg.register(mockTool('read_file'))
    const defs = reg.toToolDefinitions()
    expect(defs[0]?.name).toBe('read_file')
    expect(defs[0]).toHaveProperty('description')
    expect(defs[0]).toHaveProperty('parameters')
  })
})
