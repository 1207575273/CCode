import { describe, it, expect } from 'vitest'
import { resolveShell } from '@platform/shell-resolver.js'

describe('resolveShell', () => {
  it('返回合法的 shell 信息', () => {
    const shell = resolveShell()
    expect(shell.path).toBeTruthy()
    expect(shell.args).toBeInstanceOf(Array)
    expect(shell.args.length).toBeGreaterThan(0)
  })

  it('shell type 是已知类型', () => {
    const shell = resolveShell()
    expect(['bash', 'gitbash', 'powershell', 'sh']).toContain(shell.type)
  })
})
