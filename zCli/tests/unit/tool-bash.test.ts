import { describe, it, expect } from 'vitest'
import { BashTool } from '@tools/core/bash.js'
import type { ToolContext } from '@tools/core/types.js'

const CTX: ToolContext = { cwd: process.cwd() }

describe('BashTool', () => {
  const tool = new BashTool()

  // ---- 基础属性 ----
  it('dangerous 为 true', () => {
    expect(tool.dangerous).toBe(true)
  })

  it('parameters 包含 command / cwd / timeout / run_in_background', () => {
    const props = tool.parameters.properties as Record<string, unknown>
    expect(props).toHaveProperty('command')
    expect(props).toHaveProperty('cwd')
    expect(props).toHaveProperty('timeout')
    expect(props).toHaveProperty('run_in_background')
  })

  // ---- 正常执行 ----
  it('执行简单命令返回输出', async () => {
    const result = await tool.execute({ command: 'echo hello' }, CTX)
    expect(result.success).toBe(true)
    expect(result.output).toContain('hello')
  }, 15_000)

  it('命令失败返回 error', async () => {
    const result = await tool.execute({ command: 'nonexistent_command_xyz' }, CTX)
    expect(result.success).toBe(false)
  }, 15_000)

  it('空命令返回 error', async () => {
    const result = await tool.execute({ command: '' }, CTX)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/命令不能为空/)
  })

  // ---- timeout 参数 ----
  it('自定义 timeout：命令在时间内完成则成功', async () => {
    const result = await tool.execute({ command: 'echo fast', timeout: 5000 }, CTX)
    expect(result.success).toBe(true)
  }, 10_000)

  it('自定义 timeout：超时报错含 timed out', async () => {
    // Windows/MSYS 下杀进程较慢（SIGTERM 不能终止子进程），需要给足 vitest 时间
    const result = await tool.execute({ command: 'sleep 30', timeout: 1000 }, CTX)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/timed out/i)
  }, 60_000)

  it('timeout 超过上限 600000 时被截断（不报错）', async () => {
    const result = await tool.execute({ command: 'echo cap', timeout: 999999 }, CTX)
    expect(result.success).toBe(true)
  })

  it('timeout 为负数时使用默认值（不报错）', async () => {
    const result = await tool.execute({ command: 'echo ok', timeout: -1 }, CTX)
    expect(result.success).toBe(true)
  })

  // ---- run_in_background ----
  it('run_in_background 立即返回且包含 pid', async () => {
    const start = Date.now()
    const result = await tool.execute(
      { command: 'sleep 60', run_in_background: true },
      CTX,
    )
    const elapsed = Date.now() - start
    expect(result.success).toBe(true)
    expect(result.output).toMatch(/pid/i)
    // 应该秒级返回，不等 60 秒
    expect(elapsed).toBeLessThan(5000)
  }, 10_000)

  // ---- cwd ----
  it('支持自定义 cwd', async () => {
    const result = await tool.execute({ command: 'pwd', cwd: '/' }, CTX)
    expect(result.success).toBe(true)
    expect(result.output.length).toBeGreaterThan(0)
  }, 15_000)
})
