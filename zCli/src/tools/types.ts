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
  | { type: 'grep'; matchCount: number; fileCount: number }
  | { type: 'glob'; fileCount: number }
  | { type: 'ask_user'; questionCount: number; answered: boolean; pairs?: Array<{ question: string; answer: string }> }

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
