import { describe, it, expect } from 'vitest'
import { ClearCommand } from '@commands/clear.js'
import { HelpCommand } from '@commands/help.js'
import type { Command } from '@commands/types.js'

describe('ClearCommand', () => {
  it('execute() 返回 handled: true', () => {
    const cmd = new ClearCommand()
    const result = cmd.execute([])
    expect(result.handled).toBe(true)
  })

  it('execute() 返回 action.type === clear_messages', () => {
    const cmd = new ClearCommand()
    const result = cmd.execute([])
    expect(result.action?.type).toBe('clear_messages')
  })
})

describe('HelpCommand', () => {
  const makeCommands = (): Command[] => [
    { name: 'clear', description: 'Clear current conversation', execute: () => ({ handled: true }) },
    { name: 'model', aliases: ['m'], description: 'Switch model', execute: () => ({ handled: true }) },
  ]

  it('execute() 输出包含所有注册指令名', () => {
    const cmd = new HelpCommand(makeCommands)
    const result = cmd.execute([])
    expect(result.action?.type).toBe('show_help')
    if (result.action?.type !== 'show_help') return
    expect(result.action.content).toContain('/clear')
    expect(result.action.content).toContain('/model')
  })

  it('execute() 输出包含指令描述', () => {
    const cmd = new HelpCommand(makeCommands)
    const result = cmd.execute([])
    expect(result.action?.type).toBe('show_help')
    if (result.action?.type !== 'show_help') throw new Error('unexpected action type')
    expect(result.action.content).toContain('Clear current conversation')
    expect(result.action.content).toContain('Switch model')
  })

  it('execute() 当指令有 aliases 时输出中包含别名', () => {
    const cmd = new HelpCommand(makeCommands)
    const result = cmd.execute([])
    expect(result.action?.type).toBe('show_help')
    if (result.action?.type !== 'show_help') throw new Error('unexpected action type')
    expect(result.action.content).toContain('(m)')
  })
})
