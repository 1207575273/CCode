import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '@commands/registry.js'
import type { Command, CommandResult } from '@commands/types.js'

const makeCmd = (name: string, aliases?: readonly string[]): Command => ({
  name,
  ...(aliases !== undefined ? { aliases } : {}),
  description: `mock ${name}`,
  execute: (_args) => ({ handled: true, action: { type: 'clear_messages' } }),
})

describe('CommandRegistry', () => {
  it('dispatch 已注册指令返回 handled: true', () => {
    const reg = new CommandRegistry()
    reg.register(makeCmd('clear'))
    const result = reg.dispatch('/clear')
    expect(result.handled).toBe(true)
  })

  it('dispatch 未知指令返回 error action', () => {
    const reg = new CommandRegistry()
    const result = reg.dispatch('/unknown')
    expect(result.handled).toBe(true)
    expect(result.action?.type).toBe('error')
  })

  it('dispatch 非 / 开头返回 handled: false', () => {
    const reg = new CommandRegistry()
    const result = reg.dispatch('hello')
    expect(result.handled).toBe(false)
  })

  it('dispatch 解析 args 传给 execute', () => {
    const reg = new CommandRegistry()
    let receivedArgs: string[] = []
    reg.register({
      name: 'model',
      description: 'test',
      execute: (args) => { receivedArgs = args; return { handled: true } },
    })
    reg.dispatch('/model glm-5')
    expect(receivedArgs).toEqual(['glm-5'])
  })

  it('dispatch 支持 aliases', () => {
    const reg = new CommandRegistry()
    reg.register(makeCmd('clear', ['c']))
    const result = reg.dispatch('/c')
    expect(result.handled).toBe(true)
    expect(result.action?.type).toBe('clear_messages')
  })

  it('dispatch 纯斜线或斜线加空格返回 handled: false', () => {
    const reg = new CommandRegistry()
    expect(reg.dispatch('/').handled).toBe(false)
    expect(reg.dispatch('/ ').handled).toBe(false)
    expect(reg.dispatch('/  ').handled).toBe(false)
  })

  it('getAll 返回所有已注册指令（去重别名）', () => {
    const reg = new CommandRegistry()
    reg.register(makeCmd('clear'))
    reg.register(makeCmd('help'))
    expect(reg.getAll()).toHaveLength(2)
  })
})
