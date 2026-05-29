// src/a2a/types.ts

/**
 * A2A 类型隔离层 — 唯一接触 @a2a-js/sdk 的边界。
 *
 * 设计依据：总体方案 §10 风险表「A2A v1.0 spec 仍可能小幅变更」
 * -> 隔离在本文件，升级 SDK 时只改这一层，下游全部依赖本文件而非直接 import sdk。
 *
 * 包含三部分：
 * 1. re-export SDK 协议类型（AgentCard / Task / Message 等）
 * 2. A2AEvent — 规范化的内部流式事件 union（独立于 SubagentEvent，符合 v2.3 D-4）
 * 3. 领域类型 — TrustedAgent（白名单条目）/ A2ADispatchResult（工具返回）
 */

import type {
  AgentCard,
  Task,
  Message,
  MessageSendParams,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  TaskState,
  Artifact,
  Part,
  TextPart,
} from '@a2a-js/sdk'

// ═══════════════════════════════════════════════
// 1. SDK 协议类型 re-export（下游只从这里导入）
// ═══════════════════════════════════════════════

export type {
  AgentCard,
  Task,
  Message,
  MessageSendParams,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  TaskState,
  Artifact,
  Part,
  TextPart,
}

/** sendMessageStream 的 yield union（SDK: A2AStreamEventData） */
export type A2AStreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent

/** sendMessage 的返回 union（SDK: SendMessageResult） */
export type A2ASendResult = Message | Task

// ═══════════════════════════════════════════════
// 2. A2AEvent — 规范化内部流式事件
// ═══════════════════════════════════════════════

/**
 * A2AEvent — 把 SDK 的 A2AStreamEvent 规范化后的内部事件。
 *
 * 独立于 SubagentEvent（v2.3 D-4：SubagentEvent 仅 spawn/progress/done 三态，
 * 承载不了 A2A 的 9 态生命周期 + artifact 增量）。
 *
 * - M1：dispatch_remote_agent 在工具边界把 A2AEvent 投影成 SubagentEvent，复用 CLI 现有渲染。
 * - M2：Web 端直接消费 A2AEvent，UI 适配器渲染完整 9 态时间轴。
 *
 * 每个事件都带 `ts`（毫秒时间戳），为 M2 的 WS 重连 catch-up 游标预留。
 */
export type A2AEvent =
  /** Task 首次创建 */
  | { kind: 'task-created'; taskId: string; contextId: string; state: TaskState; ts: number }
  /** Task 状态推进（working / input-required / completed / failed ...） */
  | {
      kind: 'status'
      taskId: string
      contextId: string
      state: TaskState
      /** 状态附带的文本（如 input-required 的提示、completed 的总结） */
      message?: string
      /** SDK 的 final 标记：true 表示流将结束 */
      final: boolean
      ts: number
    }
  /** Task 产物增量 */
  | {
      kind: 'artifact'
      taskId: string
      contextId: string
      artifact: Artifact
      /** SDK 的 lastChunk：true 表示该 artifact 推送完毕 */
      lastChunk: boolean
      ts: number
    }
  /** 远端直接返回 Message（非 Task 的轻量响应） */
  | { kind: 'message'; messageId: string; contextId?: string; text: string; ts: number }

/** A2A Task 是否进入终态（流应关闭） */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'completed',
  'failed',
  'canceled',
  'rejected',
])

/** A2A Task 是否进入中断态（等待外部输入） */
export const INTERRUPT_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'input-required',
  'auth-required',
])

// ═══════════════════════════════════════════════
// 3. 领域类型
// ═══════════════════════════════════════════════

/** AgentCard 鉴权方式（M1 仅支持 none / bearer） */
export type A2ASecurityScheme = 'none' | 'bearer'

/**
 * TrustedAgent — 受信任的远端 Agent 白名单条目。
 *
 * 设计依据：总体方案 §5.3 / D-5「服务发现分拉取与信任两步」。
 * M1 持久化到配置文件；M2 迁移到 libSQL agent_registry 表。
 */
export interface TrustedAgent {
  /** 稳定 id（uuid） */
  id: string
  /** AgentCard 发现 URL（baseUrl） */
  url: string
  /** 从 AgentCard.name 同步的展示名 */
  name: string
  /** 用户起的别名（可选） */
  alias?: string
  /** 鉴权方式 */
  securityScheme: A2ASecurityScheme
  /**
   * 鉴权 token 引用。
   * M1 简化：直接存 token 字符串（配置文件）；M2 改为 secrets 表引用。
   * 注意：任何日志/UI 输出都必须脱敏，不得明文回显。
   */
  authToken?: string
  /** 加入时间（ISO 字符串） */
  addedAt: string
}

/** dispatch_remote_agent 工具的结构化返回 payload（写入 ToolResult.output） */
export interface A2ADispatchResult {
  /** 调用是否抵达终态 completed */
  status: 'completed' | 'failed' | 'canceled' | 'rejected' | 'input-required' | 'auth-required'
  /** A2A taskId（若远端返回的是 Task） */
  taskId?: string
  /** A2A contextId */
  contextId?: string
  /** 最终文本输出（completed 时的总结 / 各 artifact 文本拼接） */
  output: string
  /** 产物清单摘要 */
  artifacts?: Array<{ artifactId: string; name?: string; preview: string }>
  /** 失败 / 中断原因 */
  reason?: string
}
