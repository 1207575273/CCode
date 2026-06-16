// src/a2a/task-store.ts

/**
 * A2A Task 存储 — taskId -> Task 快照映射，支撑标准 tasks/get、tasks/cancel。
 *
 * 背景：A2A 协议规定 Server 须支持 tasks/get（查任务状态）与 tasks/cancel
 * （取消任务）。这要求保存 taskId 到 Task 的映射；以及为可取消，保存每个
 * 进行中任务的 AbortController。
 *
 * 设计：
 * - 进程内单例、有界 + TTL（终态任务保留 5 分钟供查询后自动清理），不持久化。
 * - 从 A2AStreamEvent 增量维护 Task 快照（与 collectA2ATask 等价，但增量 + 终态不可变）。
 * - 终态（completed/failed/canceled/rejected）不可被后续事件覆盖（A2A 协议硬约束）。
 */

import type { Task, TaskState, Artifact, Message, A2AStreamEvent } from './types.js'

/** 终态集合（A2A 协议：进入终态后 Task 不可变） */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'completed', 'failed', 'canceled', 'rejected',
])

/** 终态任务保留时长（供查询后自动清理） */
export const TASK_TTL_MS = 5 * 60_000
/** 存储上限（防御无界增长，超出时优先清终态、再淘汰最老） */
export const TASK_STORE_MAX = 200

interface StoredTask {
  task: Task
  controller?: AbortController
  /** 进入终态的时间戳（ms），用于 TTL 清理 */
  endedAt?: number
}

const store = new Map<string, StoredTask>()

function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state)
}

/** 登记任务的取消句柄（tasks/cancel 据此中断正在跑的 sidechain） */
export function registerTaskController(taskId: string, controller: AbortController): void {
  const entry = store.get(taskId)
  if (entry) {
    entry.controller = controller
  } else {
    store.set(taskId, { task: emptyTask(taskId, ''), controller })
  }
}

function emptyTask(id: string, contextId: string): Task {
  return { kind: 'task', id, contextId, status: { state: 'submitted' }, artifacts: [] }
}

/**
 * 从一个 A2A 流事件增量维护对应 Task 快照。
 * @param nowMs 终态时间源（默认 Date.now），便于测试。
 */
export function applyTaskEvent(evt: A2AStreamEvent, nowMs: number = Date.now()): void {
  if (evt.kind === 'task') {
    const existing = store.get(evt.id)
    // 已存在且已终态：不覆盖
    if (existing && isTerminal(existing.task.status.state)) return
    const task: Task = {
      kind: 'task',
      id: evt.id,
      contextId: evt.contextId,
      status: { state: evt.status.state },
      artifacts: [],
    }
    store.set(evt.id, { ...(existing?.controller ? { controller: existing.controller } : {}), task })
    enforceBounds(nowMs)
    return
  }

  // 仅 status-update / artifact-update 携带 taskId 并影响快照；其余（如 message）忽略
  if (evt.kind !== 'status-update' && evt.kind !== 'artifact-update') return

  const taskId = evt.taskId
  const entry = store.get(taskId)
  if (!entry) return
  if (isTerminal(entry.task.status.state)) return // 终态不可变

  if (evt.kind === 'status-update') {
    entry.task.status = {
      state: evt.status.state,
      ...(evt.status.message ? { message: evt.status.message as Message } : {}),
    }
    if (isTerminal(evt.status.state)) entry.endedAt = nowMs
  } else if (evt.kind === 'artifact-update') {
    entry.task.artifacts = [...(entry.task.artifacts ?? []), evt.artifact as Artifact]
  }
}

/** 取 Task 快照（tasks/get） */
export function getStoredTask(taskId: string): Task | undefined {
  return store.get(taskId)?.task
}

export type CancelResult = 'canceled' | 'not-found' | 'not-cancelable'

/**
 * 取消任务（tasks/cancel）：中断 sidechain + 把 Task 标记 canceled（权威终态）。
 * 正在跑的流后续即便产出 failed，也因终态不可变被忽略。
 */
export function cancelStoredTask(taskId: string, nowMs: number = Date.now()): CancelResult {
  const entry = store.get(taskId)
  if (!entry) return 'not-found'
  if (isTerminal(entry.task.status.state)) return 'not-cancelable'

  entry.controller?.abort()
  entry.task.status = { state: 'canceled' }
  entry.endedAt = nowMs
  return 'canceled'
}

/** 清理已过 TTL 的终态任务 */
export function reapExpiredTasks(nowMs: number = Date.now()): void {
  for (const [id, entry] of store) {
    if (entry.endedAt !== undefined && nowMs - entry.endedAt > TASK_TTL_MS) {
      store.delete(id)
    }
  }
}

/** 超上限时的兜底淘汰：先清过期终态，仍超限则删最老的终态条目 */
function enforceBounds(nowMs: number): void {
  if (store.size <= TASK_STORE_MAX) return
  reapExpiredTasks(nowMs)
  while (store.size > TASK_STORE_MAX) {
    // 优先淘汰已终态的（有 endedAt）；都没有就删插入最早的
    const victim =
      [...store].find(([, e]) => e.endedAt !== undefined)?.[0] ?? store.keys().next().value
    if (victim === undefined) break
    store.delete(victim)
  }
}

/** 清空存储（测试隔离用） */
export function resetTaskStore(): void {
  store.clear()
}
