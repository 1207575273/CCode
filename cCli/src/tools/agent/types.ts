// src/tools/agent/types.ts

/**
 * Agent 类型系统 — 统一接口定义。
 *
 * 三种来源共享 AgentDefinition 接口：
 * - built-in：内置（general / explore / plan）
 * - custom：自定义（.ccode/agents/*.md）
 * - plugin：插件（预留）
 */

// ═══════════════════════════════════════════════
// Agent 定义接口
// ═══════════════════════════════════════════════

/** Agent 定义来源 */
export type AgentSource = 'built-in' | 'custom' | 'plugin'

/** 工具策略：白名单或黑名单 */
export type ToolPolicy =
  | { mode: 'exclude'; tools: string[] }
  | { mode: 'include'; tools: string[] }

/**
 * Agent 定义 — 描述一种 Agent 的"模板"。
 *
 * 当 LLM 调用 dispatch_agent({ subagent_type: 'explore' }) 时，
 * 框架查找对应 AgentDefinition 来配置系统提示、工具集、轮次上限。
 */
export interface AgentDefinition {
  /** 类型标识（唯一键），如 "general"、"explore"、"security-reviewer" */
  readonly agentType: string

  /** 来源 */
  readonly source: AgentSource

  /** 一行说明 — LLM 看到的类型描述，决策选哪个类型时参考 */
  readonly whenToUse: string

  /**
   * 系统提示词。
   * 方法而非字段 — 内置类型可根据上下文动态生成。
   */
  getSystemPrompt(): string

  /**
   * 工具策略 — 该类型的额外工具约束。
   *
   * dispatch_agent 和 ask_user_question 在执行层硬编码排除，
   * 此处不需要重复声明。
   */
  readonly toolPolicy: ToolPolicy

  /** 默认最大轮次 */
  readonly maxTurns: number

  /** 模型建议（hint，不强制覆盖 LLM 传入的 model） */
  readonly modelHint?: 'fast' | 'balanced' | 'strong'

  /** 上下文继承策略（默认 trimmed，子 Agent 继承主 Agent 裁剪后的对话历史） */
  readonly contextPolicy?: import('./context-utils.js').ContextPolicy

  /** 最少执行轮次（防止弱模型提前退出，仅 SubAgent 模式生效） */
  readonly minTurns?: number

  // ── 预留字段 ──
  // readonly skills?: string[]
  // readonly background?: boolean
  // readonly isolation?: 'worktree'
  // readonly omitInstructions?: boolean
  // readonly hooks?: HooksSettings
}

/** 内置 Agent 定义 */
export interface BuiltInAgentDefinition extends AgentDefinition {
  readonly source: 'built-in'
}

/** 自定义 Agent 定义 — .ccode/agents/*.md */
export interface CustomAgentDefinition extends AgentDefinition {
  readonly source: 'custom'
  /** 定义文件路径（调试/报错用） */
  readonly filePath: string
}

/** 插件 Agent 定义 — 预留 */
export interface PluginAgentDefinition extends AgentDefinition {
  readonly source: 'plugin'
  readonly pluginName: string
}

// ═══════════════════════════════════════════════
// dispatch_agent 结构化输出
// ═══════════════════════════════════════════════

/** 同步完成 */
export interface AgentCompletedOutput {
  status: 'completed'
  agentId: string
  name: string
  agentType: string
  model: string
  prompt: string
  result: string
}

/** 异步启动 */
export interface AgentAsyncLaunchedOutput {
  status: 'async_launched'
  agentId: string
  name: string
  agentType: string
  model: string
  description: string
}

/** 失败 */
export interface AgentErrorOutput {
  status: 'error'
  agentId: string
  name: string
  agentType: string
  error: string
  partialResult?: string
}

/** dispatch_agent 输出联合类型 */
export type AgentOutput = AgentCompletedOutput | AgentAsyncLaunchedOutput | AgentErrorOutput
