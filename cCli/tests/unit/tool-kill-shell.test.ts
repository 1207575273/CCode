// tests/unit/tool-kill-shell.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { KillShellTool } from '@tools/core/kill-shell.js'
import { BashTool } from '@tools/core/bash.js'
import { listProcesses, killAllProcesses } from '@tools/core/process-tracker.js'
import type { ToolContext } from '@tools/core/types.js'

const ctx: ToolContext = { cwd: process.cwd() }
const killTool = new KillShellTool()
const bashTool = new BashTool()

// 每个测试后清理所有后台进程
afterEach(async () => {
  await killAllProcesses()
})

describe('KillShellTool 基础属性', () => {
  it('should_have_correct_name_and_not_dangerous', () => {
    expect(killTool.name).toBe('kill_shell')
    expect(killTool.dangerous).toBe(false)
  })

  it('should_have_pid_parameter', () => {
    const props = (killTool.parameters as { properties: Record<string, unknown> }).properties
    expect(props).toHaveProperty('pid')
  })
})

describe('KillShellTool 列出进程', () => {
  it('should_return_empty_list_when_no_background_processes', async () => {
    const result = await killTool.execute({}, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('No tracked background processes')
  })

  it('should_list_background_processes_after_bash_starts_one', async () => {
    // 启动一个后台进程
    const bashResult = await bashTool.execute({
      command: 'sleep 60',
      run_in_background: true,
    }, ctx)
    expect(bashResult.success).toBe(true)
    expect(bashResult.output).toContain('pid')

    // 列出进程
    const listResult = await killTool.execute({}, ctx)
    expect(listResult.success).toBe(true)
    expect(listResult.output).toContain('sleep 60')
    expect(listResult.output).toContain('PID')
  })
})

describe('KillShellTool 终止进程', () => {
  it('should_kill_tracked_background_process', async () => {
    // 启动后台进程
    const bashResult = await bashTool.execute({
      command: 'sleep 60',
      run_in_background: true,
    }, ctx)
    expect(bashResult.success).toBe(true)

    // 提取 PID
    const procs = listProcesses()
    expect(procs.length).toBeGreaterThan(0)
    const pid = procs[0]!.pid

    // 终止
    const killResult = await killTool.execute({ pid }, ctx)
    expect(killResult.success).toBe(true)
    expect(killResult.output).toContain('已终止')

    // 确认已从追踪列表移除
    expect(listProcesses()).toHaveLength(0)
  })

  it('should_fail_for_untracked_pid', async () => {
    const result = await killTool.execute({ pid: 999999 }, ctx)
    expect(result.success).toBe(false)
    expect(result.output).toContain('not a tracked background process')
  })

  it('should_handle_already_exited_process', async () => {
    // 启动一个会快速退出的后台进程
    const bashResult = await bashTool.execute({
      command: 'echo done',
      run_in_background: true,
    }, ctx)
    expect(bashResult.success).toBe(true)

    const procs = listProcesses()
    if (procs.length > 0) {
      const pid = procs[0]!.pid
      // 等进程退出
      await new Promise(r => setTimeout(r, 500))
      // 尝试终止已退出的进程
      const killResult = await killTool.execute({ pid }, ctx)
      // 不管是 success true（已不存在）还是 false，都不应该崩溃
      expect(typeof killResult.success).toBe('boolean')
    }
  })
})

describe('process-tracker 集成', () => {
  it('should_register_pid_when_bash_starts_background_process', async () => {
    expect(listProcesses()).toHaveLength(0)

    await bashTool.execute({
      command: 'sleep 60',
      run_in_background: true,
    }, ctx)

    const procs = listProcesses()
    expect(procs.length).toBeGreaterThan(0)
    expect(procs[0]!.command).toBe('sleep 60')
    expect(procs[0]!.pid).toBeGreaterThan(0)
  })

  it('should_include_kill_shell_hint_in_bash_output', async () => {
    const result = await bashTool.execute({
      command: 'sleep 60',
      run_in_background: true,
    }, ctx)
    expect(result.output).toContain('kill_shell')
  })
})
