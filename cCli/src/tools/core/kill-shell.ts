// src/tools/kill-shell.ts

/**
 * KillShellTool — 终止由 bash 工具启动的后台进程。
 *
 * 功能：
 * - 指定 PID 终止单个进程
 * - 不传 PID 时列出所有追踪中的后台进程
 *
 * 安全约束：
 * - 只能终止 process-tracker 中追踪的进程（由 bash run_in_background 启动）
 * - 不能终止任意系统进程
 * - dangerous = false（终止自己启动的进程是安全的）
 */

import type { Tool, ToolResult, ToolContext } from './types.js'
import { listProcesses, killProcess, isTracked } from './process-tracker.js'

export class KillShellTool implements Tool {
  readonly name = 'kill_shell'
  readonly description = [
    '终止由 bash 后台启动的进程，或列出所有追踪中的后台进程。',
    '',
    '注意事项：',
    '• 只能终止通过 bash run_in_background 启动的进程，不能终止任意系统进程',
    '• 不传 pid 时列出所有活跃的后台进程及其状态',
    '• 传入 pid 时终止该进程并返回其最终输出',
  ].join('\n')
  readonly dangerous = false
  readonly parameters = {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description: '要终止的后台进程 PID。不传则列出所有后台进程',
      },
    },
    required: [],
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const pid = typeof args['pid'] === 'number' ? args['pid'] : undefined

    // 无 PID：列出所有追踪中的进程
    if (pid == null) {
      return this.#listProcesses()
    }

    // 有 PID：终止指定进程
    return this.#killProcess(pid)
  }

  #listProcesses(): ToolResult {
    const procs = listProcesses()
    if (procs.length === 0) {
      return { success: true, output: 'No tracked background processes.' }
    }

    const lines = procs.map(p => {
      const age = formatAge(Date.now() - p.startedAt.getTime())
      const cmd = p.command.length > 60 ? p.command.slice(0, 57) + '...' : p.command
      return `  PID ${p.pid} | ${age} | ${cmd}`
    })

    return {
      success: true,
      output: `Tracked background processes (${procs.length}):\n${lines.join('\n')}`,
    }
  }

  async #killProcess(pid: number): Promise<ToolResult> {
    if (!isTracked(pid)) {
      return {
        success: false,
        output: `PID ${pid} is not a tracked background process. Use kill_shell without pid to list tracked processes.`,
      }
    }

    const result = await killProcess(pid)
    return {
      success: result.success,
      output: result.message,
    }
  }
}

/** 格式化运行时间 */
function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
