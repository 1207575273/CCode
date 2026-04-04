import { describe, it, expect } from 'vitest'
import { summarizeArgs } from '@core/args-summarizer.js'

describe('summarizeArgs', () => {
  it('bash: 保留 command，不截断短命令', () => {
    const result = summarizeArgs('bash', { command: 'ls -la' })
    expect(result).toEqual({ command: 'ls -la' })
  })

  it('bash: 截断超长命令', () => {
    const longCmd = 'a'.repeat(400)
    const result = summarizeArgs('bash', { command: longCmd })
    expect((result['command'] as string).length).toBeLessThan(400)
    expect((result['command'] as string)).toContain('...')
  })

  it('bash: 保留 run_in_background', () => {
    const result = summarizeArgs('bash', { command: 'npm start', run_in_background: true })
    expect(result['run_in_background']).toBe(true)
  })

  it('write_file: 路径 + 内容字符数，不含 content 本身', () => {
    const content = '// React component\n'.repeat(50)
    const result = summarizeArgs('write_file', { file_path: 'src/App.tsx', content })
    expect(result['file_path']).toBe('src/App.tsx')
    expect(result['content_chars']).toBe(content.length)
    expect(result['content']).toBeUndefined() // 不泄露完整内容
  })

  it('edit_file: 路径 + old/new 预览', () => {
    const result = summarizeArgs('edit_file', {
      file_path: 'src/App.tsx',
      old_string: 'import React from "react"',
      new_string: 'import { useState } from "react"',
    })
    expect(result['file_path']).toBe('src/App.tsx')
    expect(result['old_preview']).toBe('import React from "react"')
    expect(result['new_preview']).toBe('import { useState } from "react"')
    expect(result['old_string']).toBeUndefined()
    expect(result['new_string']).toBeUndefined()
  })

  it('edit_file: 超长 old/new 截断', () => {
    const result = summarizeArgs('edit_file', {
      file_path: 'x.ts',
      old_string: 'x'.repeat(200),
      new_string: 'y'.repeat(200),
    })
    expect((result['old_preview'] as string).length).toBeLessThan(200)
    expect((result['new_preview'] as string).length).toBeLessThan(200)
  })

  it('read_file: 保留路径和偏移量', () => {
    const result = summarizeArgs('read_file', { file_path: 'readme.md', offset: 100, limit: 50 })
    expect(result).toEqual({ file_path: 'readme.md', offset: 100, limit: 50 })
  })

  it('grep: 保留 pattern 和 path', () => {
    const result = summarizeArgs('grep', { pattern: 'useState', path: 'src/', glob: '*.tsx' })
    expect(result).toEqual({ pattern: 'useState', path: 'src/', glob: '*.tsx' })
  })

  it('glob: 保留 pattern', () => {
    const result = summarizeArgs('glob', { pattern: '**/*.ts' })
    expect(result).toEqual({ pattern: '**/*.ts' })
  })

  it('dispatch_agent: 保留描述和类型，不含 prompt', () => {
    const result = summarizeArgs('dispatch_agent', {
      description: '创建前端项目',
      prompt: '很长的 prompt '.repeat(100),
      subagent_type: 'general',
      name: 'frontend',
    })
    expect(result['description']).toBe('创建前端项目')
    expect(result['subagent_type']).toBe('general')
    expect(result['name']).toBe('frontend')
    expect(result['prompt']).toBeUndefined()
  })

  it('todo_write: 只记数量', () => {
    const result = summarizeArgs('todo_write', {
      todos: [{ id: '1', content: 'a', status: 'pending' }, { id: '2', content: 'b', status: 'done' }],
    })
    expect(result).toEqual({ count: 2 })
  })

  it('未知工具: 大字符串只记长度', () => {
    const result = summarizeArgs('mcp_custom_tool', {
      short: 'hello',
      long: 'x'.repeat(200),
      num: 42,
      flag: true,
      arr: [1, 2, 3],
    })
    expect(result['short']).toBe('hello')
    expect(result['long']).toBe('(200 chars)')
    expect(result['num']).toBe(42)
    expect(result['flag']).toBe(true)
    expect(result['arr']).toBe('(array, 3 items)')
  })
})
