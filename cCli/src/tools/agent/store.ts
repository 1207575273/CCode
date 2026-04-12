// src/tools/agent/store.ts

/**
 * SubAgent 内存状态管理 — 缓存执行中/已完成的子 Agent 事件。
 *
 * 生命周期：
 * - 执行中：事件实时写入内存，UI 直读
 * - 执行完：内存保留（供 UI 查看），会话结束时统一清理
 * - 内存清除后：需要时从 JSONL 回放（loadMessages）
 *
 * 单例使用，CLI 进程生命周期内存在。
 */

import type { AgentEvent } from '@core/agent-loop.js'
import { eventBus } from '@core/event-bus.js'

/** 子 Agent 详细事件（工具调用、文本输出等） */
export interface SubAgentDetailEvent {
  type: 'tool_start' | 'tool_done' | 'text' | 'error'
  timestamp: number
  toolName?: string
  toolCallId?: string
  args?: Record<string, unknown>
  durationMs?: number
  success?: boolean
  resultSummary?: string
  text?: string
  error?: string
}

// ═══════════════════════════════════════════════
// 停止机制类型定义
// ═══════════════════════════════════════════════

/** 停止触发来源 */
export type StopSource = 'user_cli' | 'user_web' | 'parent_agent' | 'timeout'

/** 控制句柄 — running/stopping 时存在，终态后清除 */
export interface SubAgentControl {
  abortController: AbortController
  loop: import('@core/agent-loop.js').AgentLoop
}

/** 停止请求信息 */
export interface StopRequest {
  source: StopSource
  reason: string
  requestedAt: number
  gracePeriodMs: number
  /** 宽限期超时定时器 */
  timer: ReturnType<typeof setTimeout>
}

/** token 用量（累计 llm_done 事件） */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** 停止报告 — 向主 Agent 汇报停止结果 */
export interface StopReport {
  agentId: string
  name: string
  agentType: string
  /** 终止方式：优雅退出 or 宽限期超时后强制中断 */
  resolution: 'graceful' | 'forced'
  /** 谁触发的停止 */
  source: StopSource
  /** 为什么停止 */
  reason: string
  /** 执行进度 */
  turn: number
  maxTurns: number
  /** 已有结果（优雅退出=完整当前轮，强制中断=部分结果） */
  partialResult: string
  /** token 用量（累计 llm_done 事件） */
  tokenUsed?: TokenUsage
}

// ═══════════════════════════════════════════════
// SubAgent 状态
// ═══════════════════════════════════════════════

/** 内存中的 SubAgent 完整状态 */
export interface SubAgentState {
  agentId: string
  /** 人类可读名称 */
  name: string
  description: string
  /** Agent 类型标识 */
  agentType: string
  /** 实际使用的模型名 */
  modelName: string
  status: 'running' | 'stopping' | 'stopped' | 'done' | 'error'
  /** 缓存的详细事件 */
  events: SubAgentDetailEvent[]
  /** 当前轮次 */
  turn: number
  maxTurns: number
  /** 当前正在执行的工具 */
  currentTool?: string
  startedAt: number
  finishedAt?: number
  /** 最终文本输出 */
  finalText?: string
  /** 关联的 JSONL virtualSessionId（回放用） */
  virtualSessionId?: string
  /** 控制句柄 — running/stopping 时存在，终态后清除 */
  control?: SubAgentControl
  /** stop 请求信息 — stopping/stopped 时存在 */
  stopRequest?: StopRequest
  /** 停止报告 — stopped 时存在（供 task_output 读取） */
  stopReport?: StopReport
  /** token 用量累计（llm_done 事件实时更新） */
  tokenUsed?: TokenUsage
}

/** agentId → SubAgentState */
const store = new Map<string, SubAgentState>()

/** 会话内 name 计数器（用于去重） */
const nameCounter = new Map<string, number>()

/** 注册新的子 Agent */
export function registerSubAgent(params: {
  agentId: string
  name: string
  description: string
  agentType: string
  modelName: string
  maxTurns: number
}): void {
  const { agentId, name, description, agentType, modelName, maxTurns } = params
  store.set(agentId, {
    agentId,
    name,
    description,
    agentType,
    modelName,
    status: 'running',
    events: [],
    turn: 0,
    maxTurns,
    startedAt: Date.now(),
  })
}

/**
 * 解析并去重 name。
 *
 * 规则：
 * 1. 传入 name → trim + kebab-case 友好截断
 * 2. 未传 → 自动生成 `{agentType}-{agentId前6位}`
 * 3. 会话内同名 → 追加序号 `-2`、`-3`
 */
export function resolveAgentName(
  nameArg: string | undefined,
  agentType: string,
  agentId: string,
): string {
  let baseName: string
  if (nameArg?.trim()) {
    // 用户指定：trim + 截断 40 字符
    baseName = nameArg.trim().slice(0, 40)
  } else {
    // 自动生成
    baseName = `${agentType}-${agentId.slice(0, 6)}`
  }

  // 会话内去重
  const count = (nameCounter.get(baseName) ?? 0) + 1
  nameCounter.set(baseName, count)

  return count === 1 ? baseName : `${baseName}-${count}`
}

/** 追加详细事件到缓冲区 */
export function appendSubAgentEvent(agentId: string, event: SubAgentDetailEvent): void {
  const state = store.get(agentId)
  if (!state) return
  state.events.push(event)
}

/** 更新进度（turn、currentTool） */
export function updateSubAgentProgress(agentId: string, turn: number, currentTool?: string): void {
  const state = store.get(agentId)
  if (!state) return
  state.turn = turn
  if (currentTool !== undefined) {
    state.currentTool = currentTool
  }
}

/** 标记子 Agent 完成（支持 done / error / stopped 三种终态） */
export function markSubAgentDone(
  agentId: string,
  finalText: string,
  status: 'done' | 'error' | 'stopped' = 'done',
): void {
  const state = store.get(agentId)
  if (!state) return
  state.status = status
  state.finishedAt = Date.now()
  state.finalText = finalText
  delete state.currentTool
}

/** 设置关联的 JSONL virtualSessionId */
export function setSubAgentSessionId(agentId: string, virtualSessionId: string): void {
  const state = store.get(agentId)
  if (!state) return
  state.virtualSessionId = virtualSessionId
}

/** 获取指定子 Agent 的状态 */
export function getSubAgent(agentId: string): SubAgentState | undefined {
  return store.get(agentId)
}

/** 按 name 查找子 Agent（用于 task_output 按名称查询） */
export function findSubAgentByName(name: string): SubAgentState | undefined {
  for (const state of store.values()) {
    if (state.name === name) return state
  }
  return undefined
}

/** 获取所有子 Agent 状态（按 startedAt 排序） */
export function listSubAgents(): SubAgentState[] {
  return [...store.values()].sort((a, b) => a.startedAt - b.startedAt)
}

/** 获取所有活跃的子 Agent（running + stopping） */
export function listRunningSubAgents(): SubAgentState[] {
  return listSubAgents().filter(s => s.status === 'running' || s.status === 'stopping')
}

/** 清除所有子 Agent 状态（会话结束时调用） */
export function clearSubAgents(): void {
  // 先清理 stopping 状态 agent 的宽限期定时器，防止悬挂
  for (const state of store.values()) {
    if (state.stopRequest) {
      clearTimeout(state.stopRequest.timer)
    }
  }
  store.clear()
  nameCounter.clear()
}

/** 将 AgentEvent 转换为 SubAgentDetailEvent 写入 store */
export function consumeAgentEvent(agentId: string, event: AgentEvent): void {
  const now = Date.now()

  switch (event.type) {
    case 'tool_start':
      appendSubAgentEvent(agentId, {
        type: 'tool_start',
        timestamp: now,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
      })
      updateSubAgentProgress(agentId, store.get(agentId)?.turn ?? 0, event.toolName)
      break

    case 'tool_done': {
      appendSubAgentEvent(agentId, {
        type: 'tool_done',
        timestamp: now,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        durationMs: event.durationMs,
        success: event.success,
        ...(event.resultSummary !== undefined ? { resultSummary: event.resultSummary } : {}),
      })
      // 工具完成，清除 currentTool
      const s = store.get(agentId)
      if (s) delete s.currentTool
      break
    }

    case 'text': {
      // 流式 text chunk 合并：连续的 text 事件追加到同一条，避免每个 2-3 字的 chunk 独占一行
      const state = store.get(agentId)
      const lastEvent = state?.events[state.events.length - 1]
      if (lastEvent?.type === 'text') {
        lastEvent.text = (lastEvent.text ?? '') + event.text
      } else {
        appendSubAgentEvent(agentId, {
          type: 'text',
          timestamp: now,
          text: event.text,
        })
      }
      break
    }

    case 'error':
      appendSubAgentEvent(agentId, {
        type: 'error',
        timestamp: now,
        error: event.error,
      })
      break

    case 'llm_start':
      // 新的 LLM 调用 = 新的一轮
      updateSubAgentProgress(agentId, (store.get(agentId)?.turn ?? 0) + 1)
      break

    case 'llm_done': {
      // 累计 token 用量
      const s = store.get(agentId)
      if (s) {
        const prev = s.tokenUsed ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
        s.tokenUsed = {
          inputTokens: prev.inputTokens + event.inputTokens,
          outputTokens: prev.outputTokens + event.outputTokens,
          cacheReadTokens: prev.cacheReadTokens + event.cacheReadTokens,
          cacheWriteTokens: prev.cacheWriteTokens + event.cacheWriteTokens,
        }
      }
      break
    }

    default:
      // permission_*, thinking 等不写入详细事件
      break
  }
}

// ═══════════════════════════════════════════════
// 停止机制函数
// ═══════════════════════════════════════════════

/** 默认宽限期（毫秒）— 覆盖最坏情况：LLM 流 8s + 工具执行 20s */
const DEFAULT_GRACE_PERIOD_MS = 30_000

/** 批量停止所有活跃子 Agent（会话结束、清理时调用） */
export function stopAllRunningAgents(source: StopSource, reason: string): { stopped: number; failed: number } {
  const agents = listRunningSubAgents().filter(s => s.status === 'running')
  let stopped = 0
  let failed = 0
  for (const agent of agents) {
    const result = stopAgent(agent.agentId, source, reason)
    if (result.success) stopped++
    else failed++
  }
  return { stopped, failed }
}

/** 注册控制句柄（dispatch_agent 创建 SubAgent 后调用） */
export function setSubAgentControl(agentId: string, control: SubAgentControl): void {
  const state = store.get(agentId)
  if (!state) return
  state.control = control
}

/** 清除控制句柄（终态时调用，释放 AbortController 和 AgentLoop 引用） */
export function clearSubAgentControl(agentId: string): void {
  const state = store.get(agentId)
  if (!state) return
  delete state.control
  if (state.stopRequest) {
    clearTimeout(state.stopRequest.timer)
    delete state.stopRequest
  }
}

/**
 * 停止指定子 Agent。
 *
 * 流程：设置退出标志 → 宽限期等待优雅退出 → 超时后强制 abort。
 * 幂等操作：已在 stopping 中则忽略重复调用。
 *
 * @returns success=true 表示已发起停止（不代表已停止完成）
 */
export function stopAgent(
  idOrName: string,
  source: StopSource,
  reason: string,
  gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
): { success: boolean; error?: string } {
  // 按 ID 或 name 查找
  const state = getSubAgent(idOrName) ?? findSubAgentByName(idOrName)
  if (!state) return { success: false, error: `agent "${idOrName}" not found` }

  if (state.status !== 'running') {
    return { success: false, error: `agent is ${state.status}, cannot stop` }
  }
  if (!state.control) {
    return { success: false, error: 'agent has no control handle (already finishing)' }
  }

  // 幂等：已在 stopping 中则忽略
  if (state.stopRequest) return { success: true }

  // ── 阶段一：优雅停止 ──
  state.control.loop.requestStop()
  state.status = 'stopping'

  // ── 阶段二预备：宽限期超时后强制 abort ──
  const timer = setTimeout(() => {
    if (state.control && !state.control.abortController.signal.aborted) {
      state.control.abortController.abort()
    }
  }, gracePeriodMs)

  state.stopRequest = {
    source,
    reason,
    requestedAt: Date.now(),
    gracePeriodMs,
    timer,
  }

  // 广播停止中状态
  eventBus.emit({
    type: 'subagent_event',
    agentId: state.agentId,
    detail: { kind: 'text', text: `[Stopping: ${reason}]` },
  })

  return { success: true }
}

/** 构建 StopReport（在子 Agent 退出时调用） */
export function buildStopReport(
  state: SubAgentState,
  partialResult: string,
  currentTurn: number,
  resolution: 'graceful' | 'forced',
): StopReport {
  return {
    agentId: state.agentId,
    name: state.name,
    agentType: state.agentType,
    resolution,
    source: state.stopRequest?.source ?? 'parent_agent',
    reason: state.stopRequest?.reason ?? 'unknown',
    turn: currentTurn,
    maxTurns: state.maxTurns,
    partialResult,
    ...(state.tokenUsed ? { tokenUsed: state.tokenUsed } : {}),
  }
}
