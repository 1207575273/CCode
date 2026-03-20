import { describe, it, expect } from 'vitest'
import { GcCommand } from '@commands/gc.js'

describe('GcCommand', () => {
  const cmd = new GcCommand()

  it('无参数 — 默认全量清理', () => {
    const result = cmd.execute([])
    expect(result.handled).toBe(true)
    expect(result.action).toEqual({ type: 'run_gc', dryRun: false, days: null, target: 'all' })
  })

  it('--dry-run — 预览模式', () => {
    const result = cmd.execute(['--dry-run'])
    expect(result.action).toEqual({ type: 'run_gc', dryRun: true, days: null, target: 'all' })
  })

  it('--days 7 — 指定天数', () => {
    const result = cmd.execute(['--days', '7'])
    expect(result.action).toEqual({ type: 'run_gc', dryRun: false, days: 7, target: 'all' })
  })

  it('sessions — 仅清理会话', () => {
    const result = cmd.execute(['sessions'])
    expect(result.action).toEqual({ type: 'run_gc', dryRun: false, days: null, target: 'sessions' })
  })

  it('usage — 仅清理用量', () => {
    const result = cmd.execute(['usage'])
    expect(result.action).toEqual({ type: 'run_gc', dryRun: false, days: null, target: 'usage' })
  })

  it('组合参数 — --dry-run --days 14 sessions', () => {
    const result = cmd.execute(['--dry-run', '--days', '14', 'sessions'])
    expect(result.action).toEqual({ type: 'run_gc', dryRun: true, days: 14, target: 'sessions' })
  })

  it('name 和 aliases', () => {
    expect(cmd.name).toBe('gc')
    expect(cmd.aliases).toContain('cleanup')
  })
})
