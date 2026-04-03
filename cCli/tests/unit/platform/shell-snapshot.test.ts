import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolveShell } from '@platform/shell-resolver.js'

/**
 * shell-snapshot 使用模块级缓存（单例），同一进程内只创建一次。
 * 测试按顺序执行，共享同一个快照实例。退出后由 cleanupSnapshot 清理。
 */
describe('shell-snapshot', () => {
  const shell = resolveShell()
  const isPowerShell = shell.type === 'powershell'

  // 提前创建快照供后续测试使用
  let snapshotPath: string | undefined
  let mod: typeof import('@platform/shell-snapshot.js')

  // 因为模块缓存是单例，所有测试共享同一个 snapshot
  afterAll(async () => {
    if (mod) await mod.cleanupSnapshot()
  })

  it('startSnapshotCreation 返回 .sh 文件路径或 undefined', async () => {
    mod = await import('@platform/shell-snapshot.js')
    const result = await mod.startSnapshotCreation()
    snapshotPath = result

    if (isPowerShell) {
      expect(result).toBeUndefined()
    } else {
      expect(result).toBeDefined()
      expect(result!.endsWith('.sh')).toBe(true)
      expect(existsSync(result!)).toBe(true)
    }
  })

  it('getSnapshotPath 在创建后返回路径', () => {
    const path = mod.getSnapshotPath()
    if (!isPowerShell) {
      expect(path).toBe(snapshotPath)
      expect(path!.includes('shell-snapshots')).toBe(true)
    }
  })

  it('快照文件包含 PATH 导出和标准头', () => {
    if (isPowerShell || !snapshotPath) return

    const content = readFileSync(snapshotPath, 'utf-8')
    expect(content).toContain('# Shell snapshot')
    expect(content).toContain('export PATH=')
    expect(content).toContain('# Aliases')
  })

  it('cleanupSnapshot 删除文件并重置路径', async () => {
    if (isPowerShell || !snapshotPath) return

    await mod.cleanupSnapshot()
    expect(existsSync(snapshotPath)).toBe(false)
    expect(mod.getSnapshotPath()).toBeUndefined()
  })
})
