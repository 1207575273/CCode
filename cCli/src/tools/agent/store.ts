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
  status: 'running' | 'done' | 'error'
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

/** 标记子 Agent 完成 */
export function markSubAgentDone(
  agentId: string,
  finalText: string,
  status: 'done' | 'error' = 'done',
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

/** 获取所有运行中的子 Agent */
export function listRunningSubAgents(): SubAgentState[] {
  return listSubAgents().filter(s => s.status === 'running')
}

/** 清除所有子 Agent 状态（会话结束时调用） */
export function clearSubAgents(): void {
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

    case 'text':
      appendSubAgentEvent(agentId, {
        type: 'text',
        timestamp: now,
        text: event.text,
      })
      break

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

    default:
      // llm_done, permission_*, thinking 等不写入详细事件
      break
  }
}
