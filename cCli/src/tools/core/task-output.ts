// src/tools/task-output.ts

/**
 * TaskOutput — 读取后台任务输出。
 *
 * 支持两种后台任务：
 * 1. bash run_in_background → 通过 PID 读取进程输出（process-tracker）
 * 2. dispatch_agent run_in_background → 通过 agentId 读取子 Agent 状态（subagent-store）
 *
 * 支持两种模式：
 * - block=false（默认）：立即返回当前已有的输出
 * - block=true：等待任务结束或超时，再返回全部输出
 */

import { getProcess, getOutput } from './process-tracker.js'
import { getSubAgent, findSubAgentByName } from '../agent/store.js'
import type { Tool, ToolContext, ToolResult } from './types.js'

/** 默认阻塞超时 10 秒 */
const DEFAULT_BLOCK_TIMEOUT_MS = 10_000
/** 最大阻塞超时 5 分钟 */
const MAX_BLOCK_TIMEOUT_MS = 300_000
/** 等待轮询间隔 */
const POLL_INTERVAL_MS = 200

export class TaskOutputTool implements Tool {
  readonly name = 'task_output'
  readonly dangerous = false
  readonly description =
    '读取后台任务的输出。支持两种 ID：\n' +
    '- pid（数字）：bash run_in_background 启动的进程\n' +
    '- agentId（字符串）：dispatch_agent run_in_background 启动的子 Agent\n' +
    'block=true 时阻塞等待任务结束。'
  readonly parameters = {
    type: 'object',
    properties: {
      pid: { type: 'number', description: '后台进程 PID（bash 后台任务）' },
      agent_id: { type: 'string', description: '子 Agent ID（dispatch_agent 后台任务）' },
      block: {
        type: 'boolean',
        description: '是否阻塞等待任务结束（默认 false，立即返回已有输出）',
      },
      timeout: {
        type: 'number',
        description: '阻塞超时（毫秒），仅 block=true 时生效，默认 10000，上限 300000',
      },
    },
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const agentId = args['agent_id'] as string | undefined
    const pid = args['pid'] as number | undefined

    // 优先检查 agentId（子 Agent 后台任务）
    if (agentId && typeof agentId === 'string') {
      return this.#readSubAgent(agentId, args)
    }

    // 检查 pid（bash 后台进程）
    if (pid != null) {
      return this.#readProcess(Number(pid), args)
    }

    return { success: false, output: '', error: '需要提供 pid（进程）或 agent_id（子 Agent）' }
  }

  /** 读取子 Agent 状态（支持 agentId 精确匹配或 name 查找） */
  async #readSubAgent(agentId: string, args: Record<string, unknown>): Promise<ToolResult> {
    // 先按 agentId 精确查找，找不到再按 name 查找
    const state = getSubAgent(agentId) ?? findSubAgentByName(agentId)
    if (!state) {
      return {
        success: false,
        output: '',
        error: `"${agentId}" 不在追踪列表中（按 agentId 和 name 均未匹配）。子 Agent 可能已完成并被清理。`,
      }
    }

    const block = args['block'] === true
    const rawTimeout = Number(args['timeout'])
    const timeout = block
      ? (!Number.isFinite(rawTimeout) || rawTimeout <= 0
          ? DEFAULT_BLOCK_TIMEOUT_MS
          : Math.min(rawTimeout, MAX_BLOCK_TIMEOUT_MS))
      : 0

    // 阻塞模式
    if (block && state.status === 'running') {
      const deadline = Date.now() + timeout
      while (state.status === 'running' && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS)
      }
    }

    const status = state.status === 'running'
      ? `子 Agent 仍在运行 (turn ${state.turn}/${state.maxTurns})`
      : state.status === 'done'
        ? '子 Agent 已完成'
        : '子 Agent 执行异常'

    const toolSummary = state.events
      .filter(e => e.type === 'tool_done')
      .map(e => `${e.success ? '✓' : '✗'} ${e.toolName} ${e.durationMs ?? 0}ms`)
      .join('\n')

    const output = [
      `[${status}]`,
      `任务: ${state.description}`,
      state.currentTool ? `当前工具: ${state.currentTool}` : '',
      toolSummary ? `\n工具调用历史:\n${toolSummary}` : '',
      state.finalText ? `\n最终输出:\n${state.finalText}` : '',
    ].filter(Boolean).join('\n')

    return { success: true, output }
  }

  /** 读取 bash 后台进程输出 */
  async #readProcess(pid: number, args: Record<string, unknown>): Promise<ToolResult> {
    if (!Number.isFinite(pid) || pid <= 0) {
      return { success: false, output: '', error: 'pid 必须是正整数' }
    }

    const proc = getProcess(pid)
    if (!proc) {
      return {
        success: false,
        output: '',
        error: `PID ${pid} 不在追踪列表中（只能读取由 bash run_in_background 启动的进程输出）`,
      }
    }

    const block = args['block'] === true
    const rawTimeout = Number(args['timeout'])
    const timeout = block
      ? (!Number.isFinite(rawTimeout) || rawTimeout <= 0
          ? DEFAULT_BLOCK_TIMEOUT_MS
          : Math.min(rawTimeout, MAX_BLOCK_TIMEOUT_MS))
      : 0

    if (block && !proc.done) {
      const deadline = Date.now() + timeout
      while (!proc.done && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS)
      }
    }

    const output = getOutput(pid) ?? ''
    const status = proc.done
      ? `进程已结束 (exitCode: ${proc.exitCode ?? 'unknown'})`
      : '进程仍在运行'

    return {
      success: true,
      output: output
        ? `[${status}]\n${output}`
        : `[${status}]\n(暂无输出)`,
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
