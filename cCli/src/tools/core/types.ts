// src/tools/types.ts

import type { LLMProvider } from '@providers/provider.js'

export interface ToolContext {
  cwd: string
  signal?: AbortSignal
  /** 当前 LLM provider 实例（子 Agent 场景需要） */
  provider?: LLMProvider
  /** 当前 provider 名称（日志用） */
  providerName?: string
  /** 当前模型名称（子 Agent 继承） */
  model?: string
  /** 工具注册表引用（子 Agent 需要 cloneWithout 构建受限工具集） */
  registry?: ToolRegistry
  /** 当前会话 ID（子 Agent JSONL 关联父会话用） */
  sessionId?: string
  /** 标记非交互模式（pipe），不可弹出用户交互 */
  nonInteractive?: boolean
  /** 配置快照（避免子 Agent 重复读磁盘） */
  config?: import('@config/config-manager.js').CCodeConfig
  /** 主 Agent 的 systemPrompt（子 Agent 继承前缀以命中 Prompt Cache） */
  systemPrompt?: string
  /** 主 Agent 的对话历史快照（只读，供 dispatch_agent 构建子 Agent 初始消息） */
  history?: ReadonlyArray<import('@core/types.js').Message>
  /**
   * 当前工具调用的 toolCallId — StreamableTool 需要它建立
   * "tool_start 事件 ↔ 自己 yield 的子事件" 的关联（例如 dispatch_agent
   * 在 subagent_spawn 事件里带上 parentToolCallId，供 UI 绑定子 Agent 卡片）。
   */
  toolCallId?: string
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
  /** 结构化元数据，UI 层用于渲染丰富展示（diff 预览、文件行数等） */
  meta?: ToolResultMeta
}

/** 工具结果元数据联合类型，按 type 字段区分 */
export type ToolResultMeta =
  | { type: 'edit'; path: string; addedLines: number; removedLines: number; diff: string }
  | { type: 'write'; path: string; totalLines: number; preview: string }
  | { type: 'read'; path: string; totalLines: number }
  | { type: 'bash'; exitCode: number; command: string; timedOut: boolean }
  | { type: 'grep'; totalMatches: number; displayedMatches: number; truncated: boolean; fileCount: number }
  | { type: 'glob'; fileCount: number }
  | { type: 'ask_user'; questionCount: number; answered: boolean; pairs?: Array<{ question: string; answer: string }> }
  | { type: 'git-status'; branch: string; staged: number; unstaged: number; untracked: number }
  | { type: 'git-diff'; filesChanged: number; insertions: number; deletions: number; truncated: boolean }
  | { type: 'git-log'; count: number }
  | { type: 'git-checkout'; branch: string; created: boolean }
  | { type: 'git-commit'; hash: string; message: string; filesChanged: number }
  | { type: 'git-merge'; target: string; success: boolean; conflicts: number }
  | { type: 'git-rebase'; target: string; success: boolean; replayed: number }
  | { type: 'git-stash'; action: string }
  | { type: 'git-tag'; name: string; action: 'create' | 'delete' | 'list' }
  | { type: 'git-reset'; ref: string; mode: string }
  | { type: 'dispatch-agent'; agentId: string; agentName: string; agentType: string; status: string }

export interface Tool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>  // JSON Schema
  readonly dangerous?: boolean

  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

/**
 * 流式工具接口 — 支持 yield 中间事件的长时间运行工具。
 *
 * 借鉴 LangChain Runnable 的 invoke/stream 分离思想：
 * - execute() = invoke，一次性返回最终结果
 * - stream() = stream，yield 中间事件，return 最终结果
 *
 * stream() 的 yield 类型为 unknown，AgentLoop 知道实际是 AgentEvent 并 yield* 透传。
 * 这样 tools/types.ts 不需要引用 core/agent-loop.ts，避免循环依赖。
 */
export interface StreamableTool extends Tool {
  stream(args: Record<string, unknown>, ctx: ToolContext): AsyncGenerator<unknown, ToolResult>
}

/** 类型守卫：判断工具是否支持流式执行 */
export function isStreamableTool(tool: Tool): tool is StreamableTool {
  return 'stream' in tool && typeof (tool as StreamableTool).stream === 'function'
}

// 避免循环引用：ToolContext.registry 引用的是接口类型，这里用 import type
import type { ToolRegistry } from './registry.js'
