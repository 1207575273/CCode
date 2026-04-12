// tests/unit/tools/git-tool.test.ts
import { describe, it, expect } from 'vitest'
import { GitTool } from '@tools/core/git.js'

describe('GitTool', () => {
  const git = new GitTool()
  const ctx = { cwd: process.cwd() }

  it('工具属性正确', () => {
    expect(git.name).toBe('git')
    expect(git.dangerous).toBe(true)
    expect(git.description).toContain('Git')
    expect(git.parameters).toBeDefined()
  })

  it('status 子命令正常返回', async () => {
    const result = await git.execute({ subcommand: 'status' }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('已暂存')
  })

  it('log 子命令正常返回', async () => {
    const result = await git.execute({ subcommand: 'log', count: 3 }, ctx)
    expect(result.success).toBe(true)
    expect(result.output.split('\n').length).toBeGreaterThanOrEqual(1)
  })

  it('branch 子命令正常返回', async () => {
    const result = await git.execute({ subcommand: 'branch' }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('main')
  })

  it('diff 子命令正常返回', async () => {
    const result = await git.execute({ subcommand: 'diff' }, ctx)
    expect(result.success).toBe(true)
  })

  it('非 git 仓库返回错误', async () => {
    // 使用系统根目录（通常不是 git 仓库）
    const result = await git.execute({ subcommand: 'status' }, { cwd: '/tmp' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Git 仓库')
  })

  it('commit 拒绝敏感文件', async () => {
    const result = await git.execute(
      { subcommand: 'commit', message: 'test', files: ['.env', 'src/foo.ts'] },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('.env')
  })

  it('commit 缺少 files 返回错误', async () => {
    const result = await git.execute(
      { subcommand: 'commit', message: 'test' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('files')
  })

  it('commit 缺少 message 返回错误', async () => {
    const result = await git.execute(
      { subcommand: 'commit', files: ['src/foo.ts'] },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('message')
  })

  it('checkout 缺少 branch_name 返回错误', async () => {
    const result = await git.execute({ subcommand: 'checkout' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('branch_name')
  })

  it('reset 缺少 ref 返回错误', async () => {
    const result = await git.execute({ subcommand: 'reset' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('ref')
  })

  it('log count 限制在 50 以内', async () => {
    const result = await git.execute({ subcommand: 'log', count: 100 }, ctx)
    expect(result.success).toBe(true)
    // 最多 50 条（实际提交可能少于 50）
    expect(result.output.split('\n').filter(Boolean).length).toBeLessThanOrEqual(50)
  })

  it('未知子命令返回错误', async () => {
    const result = await git.execute({ subcommand: 'unknown_cmd' }, ctx)
    expect(result.success).toBe(false)
  })
})
