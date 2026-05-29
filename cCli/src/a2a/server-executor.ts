// src/a2a/server-executor.ts

/**
 * A2A Server 执行器 — 把本会话的 AgentLoop 适配成 A2A Task 流式事件。
 *
 * 当本会话作为 A2A Server 被其他会话/Agent 调用时：
 *   收到 A2A message -> 起一个 AgentLoop 跑 -> 把 AgentEvent 翻译成 A2A 流事件
 *
 * 设计依据：总体方案 M3「AgentLoop -> AgentExecutor 适配」。
 * MVP 范围：本机会话互调，inbound 任务自动批准权限（本机受信）。
 *
 * 本模块是纯翻译逻辑（注入 runLoop），不直接 new AgentLoop，便于单测。
 */

import type { AgentEvent } from '@core/agent-loop.js'
import type { A2AStreamEvent } from './types.js'

/** 运行一轮 AgentLoop 的函数（注入，便于测试） */
export type RunLoopFn = (message: string, signal: AbortSignal) => AsyncGenerator<AgentEvent>

export interface ExecuteA2ATaskParams {
  message: string
  taskId: string
  contextId: string
  runLoop: RunLoopFn
  signal: AbortSignal
  /** 注入时间源（默认 Date.now），便于测试 */
  now?: () => number
}

/**
 * 执行一个 A2A inbound 任务，yield 出符合 A2A 协议的流式事件序列：
 *   task(submitted) -> status(working) -> [artifact] -> status(completed|failed, final)
 *
 * 终态后流即结束（A2A 协议硬约束）。
 */
export async function* executeA2ATask(
  params: ExecuteA2ATaskParams,
): AsyncGenerator<A2AStreamEvent> {
  const { message, taskId, contextId, runLoop, signal } = params
  const now = params.now ?? Date.now
  const ts = () => new Date(now()).toISOString()

  // 1. Task 创建
  yield {
    kind: 'task',
    id: taskId,
    contextId,
    status: { state: 'submitted', timestamp: ts() },
    history: [],
  } as A2AStreamEvent

  // 2. 进入 working
  yield {
    kind: 'status-update',
    taskId,
    contextId,
    status: { state: 'working', timestamp: ts() },
    final: false,
  } as A2AStreamEvent

  // 3. 驱动 AgentLoop，累积文本输出
  let accumulated = ''
  let errored: string | null = null

  try {
    for await (const event of runLoop(message, signal)) {
      switch (event.type) {
        case 'text':
          accumulated += event.text
          break
        case 'permission_request':
          // 本机 inbound 任务自动批准（MVP：本机受信）
          event.resolve(true)
          break
        case 'error':
          errored = event.error
          break
        case 'done':
          break
        default:
          // 其他事件（tool_start/tool_done/subagent_* 等）MVP 不外传
          break
      }
      if (errored) break
    }
  } catch (err) {
    errored = err instanceof Error ? err.message : String(err)
  }

  // 4. 失败终态
  if (errored) {
    yield {
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state: 'failed',
        timestamp: ts(),
        message: {
          kind: 'message',
          messageId: `${taskId}-err`,
          role: 'agent',
          parts: [{ kind: 'text', text: errored }],
        },
      },
      final: true,
    } as A2AStreamEvent
    return
  }

  // 5. 产出 artifact（最终文本）
  const finalText = accumulated || '(远端会话未产出文本输出)'
  yield {
    kind: 'artifact-update',
    taskId,
    contextId,
    artifact: {
      artifactId: `${taskId}-result`,
      name: 'result.txt',
      parts: [{ kind: 'text', text: finalText }],
    },
    lastChunk: true,
  } as A2AStreamEvent

  // 6. 完成终态
  yield {
    kind: 'status-update',
    taskId,
    contextId,
    status: {
      state: 'completed',
      timestamp: ts(),
      message: {
        kind: 'message',
        messageId: `${taskId}-done`,
        role: 'agent',
        parts: [{ kind: 'text', text: finalText }],
      },
    },
    final: true,
  } as A2AStreamEvent
}

/**
 * 收集模式：把流式事件跑完，返回最终 Task（供 message/send 同步响应用）。
 */
export async function collectA2ATask(
  stream: AsyncGenerator<A2AStreamEvent>,
): Promise<import('./types.js').Task> {
  let taskId = ''
  let contextId = ''
  let state: import('./types.js').TaskState = 'working'
  const artifacts: import('./types.js').Artifact[] = []
  let finalMessage: import('./types.js').Message | undefined

  for await (const evt of stream) {
    if (evt.kind === 'task') {
      taskId = evt.id
      contextId = evt.contextId
      state = evt.status.state
    } else if (evt.kind === 'status-update') {
      taskId = evt.taskId
      contextId = evt.contextId
      state = evt.status.state
      if (evt.status.message) finalMessage = evt.status.message
    } else if (evt.kind === 'artifact-update') {
      artifacts.push(evt.artifact)
    }
  }

  return {
    kind: 'task',
    id: taskId,
    contextId,
    status: {
      state,
      ...(finalMessage ? { message: finalMessage } : {}),
    },
    artifacts,
  }
}
