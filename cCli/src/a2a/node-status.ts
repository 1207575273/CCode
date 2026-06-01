// src/a2a/node-status.ts

/**
 * 本会话 A2A 节点的运行时状态（进程内全局单例）。
 *
 * ccli 启动本地 A2A 节点后写入；StatusBar(CLI + Web) 读取以展示
 * "当前会话可被 A2A 连接"标记。进程退出时内存态自然消失，无需手动清理。
 */

export interface LocalA2ANodeStatus {
  /** A2A 节点监听端口 */
  port: number
  /** 完整 baseUrl（含局域网 IP），可直接给其他机器/会话连接 */
  baseUrl: string
  /** 项目名（展示用） */
  projectName: string
}

let current: LocalA2ANodeStatus | null = null

/** 标记本会话已成为可被连接的 A2A 节点 */
export function setLocalA2ANode(status: LocalA2ANodeStatus): void {
  current = status
}

/** 取消标记（节点停止时） */
export function clearLocalA2ANode(): void {
  current = null
}

/** 读取当前 A2A 节点状态；null 表示本会话不是 A2A 节点 */
export function getLocalA2ANode(): LocalA2ANodeStatus | null {
  return current
}

// ════════════════════════════════════════════════════════════════
// inbound 活动记录（被调方可见反馈）
//
// 本会话作为 A2A Server 被其他会话/Agent 调用时，inbound 任务在后台
// sidechain 执行、不进主对话历史。这里记录"被调用了"这件事，供 StatusBar
// (CLI + Web) 与 Agent 网格页展示，让用户知道自己正在/曾经被远程委托。
// 进程内单例、有界环形日志，进程退出自然消失，不持久化。
// ════════════════════════════════════════════════════════════════

/** inbound 日志保留的最大条数（环形，超出挤出最老） */
export const INBOUND_LOG_MAX = 20

/** 发起方身份在 A2A message.metadata 中的命名空间 key（A2A extension 约定） */
export const CALLER_METADATA_KEY = 'ccode:caller'

/** inbound 任务的发起方标识（块 2 透传后有值） */
export interface InboundCaller {
  /** 发起方 A2A 节点端口 */
  port?: number
  /** 发起方项目名 */
  projectName?: string
}

/** 一条 inbound 任务记录 */
export interface InboundTask {
  /** A2A taskId */
  taskId: string
  /** 任务消息预览（已截断） */
  messagePreview: string
  /** 发起方标识（无透传时缺省） */
  caller?: InboundCaller
  /** 开始时间（ISO） */
  startedAt: string
  /** 任务状态 */
  state: 'running' | 'completed' | 'failed'
  /** 结束时间（ISO，终态后有） */
  endedAt?: string
  /** 耗时 ms（终态后有） */
  durationMs?: number
}

/** inbound 活动快照 */
export interface InboundActivity {
  /** 当前进行中的 inbound 任务数 */
  active: number
  /** 最近记录（新 -> 旧，有界） */
  recent: InboundTask[]
}

/** 环形日志：最新在头部 */
let inboundLog: InboundTask[] = []

/** 记录一个 inbound 任务开始 */
export function recordInboundStart(input: {
  taskId: string
  messagePreview: string
  startedAt: string
  caller?: InboundCaller
}): void {
  const entry: InboundTask = {
    taskId: input.taskId,
    messagePreview: input.messagePreview,
    startedAt: input.startedAt,
    state: 'running',
    ...(input.caller ? { caller: input.caller } : {}),
  }
  inboundLog.unshift(entry)
  if (inboundLog.length > INBOUND_LOG_MAX) {
    inboundLog.length = INBOUND_LOG_MAX
  }
}

/** 标记一个 inbound 任务结束（taskId 已被挤出时静默忽略） */
export function recordInboundEnd(
  taskId: string,
  result: { state: 'completed' | 'failed'; durationMs: number; endedAt: string },
): void {
  const entry = inboundLog.find((t) => t.taskId === taskId)
  if (!entry) return
  entry.state = result.state
  entry.durationMs = result.durationMs
  entry.endedAt = result.endedAt
}

/** 读取 inbound 活动快照 */
export function getInboundActivity(): InboundActivity {
  return {
    active: inboundLog.filter((t) => t.state === 'running').length,
    recent: inboundLog.map((t) => ({ ...t })),
  }
}

/** 清空 inbound 日志（测试隔离用） */
export function resetInboundActivity(): void {
  inboundLog = []
}
