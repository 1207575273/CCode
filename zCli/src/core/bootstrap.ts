// src/core/bootstrap.ts

/**
 * 共享基础设施 — REPL 和 Pipe Mode 都需要的模块级单例和工厂函数。
 *
 * 职责：
 * - 构建包含全部内置工具的 ToolRegistry
 * - MCP 连接初始化（幂等）
 * - 模块级 SessionLogger / TokenMeter 单例
 * - getCurrentSessionId() 供退出时打印 resume 命令
 */

import { ToolRegistry } from '@tools/registry.js'
import { ReadFileTool } from '@tools/read-file.js'
import { WriteFileTool } from '@tools/write-file.js'
import { EditFileTool } from '@tools/edit-file.js'
import { GlobTool } from '@tools/glob.js'
import { GrepTool } from '@tools/grep.js'
import { BashTool } from '@tools/bash.js'
import { DispatchAgentTool } from '@tools/dispatch-agent.js'
import { AskUserQuestionTool } from '@tools/ask-user-question.js'
import { loadMcpConfigWithSources } from '@config/mcp-config.js'
import { McpManager } from '@mcp/mcp-manager.js'
import { SessionLogger, TokenMeter } from '@observability/index.js'
import { SkillStore } from '@skills/engine/store.js'
import { SkillTool } from '@skills/engine/skill-tool.js'
import { loadInstructions, formatInstructionsPrompt } from '@config/instructions-loader.js'
import type { LoadedInstruction } from '@config/instructions-loader.js'
import { HookManager } from '@hooks/hook-manager.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ═══ 模块级单例 ═══

let mcpManager: McpManager | null = null
let mcpInitialized = false

/** 模块级 SkillStore 实例 */
export const skillStore = new SkillStore()

/** 模块级 SessionLogger 实例，管理会话持久化和观测事件 */
export const sessionLogger = new SessionLogger()

/** 模块级 TokenMeter 实例，管理 token 计量和计费 */
export const tokenMeter = new TokenMeter()

/** 获取当前活跃的 sessionId（退出时用于打印 resume 命令） */
export function getCurrentSessionId(): string | null {
  return sessionLogger.sessionId
}

// ═══ 工厂函数 ═══

/** 构建包含全部内置工具的 ToolRegistry（含 skill 工具） */
export function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry()
  reg.register(new ReadFileTool())
  reg.register(new WriteFileTool())
  reg.register(new EditFileTool())
  reg.register(new GlobTool())
  reg.register(new GrepTool())
  reg.register(new BashTool())
  reg.register(new DispatchAgentTool())
  reg.register(new AskUserQuestionTool())
  reg.register(new SkillTool(skillStore))
  return reg
}

/** 确保 Skills 已发现（幂等） */
export async function ensureSkillsDiscovered(): Promise<void> {
  await skillStore.discover()
}

/** 获取 skills 的 system prompt 段落 */
export function getSkillsSystemPrompt(): string {
  return skillStore.buildSystemPromptSection()
}

// ═══ Hook 系统 ═══

/** 模块级 HookManager 实例 */
export const hookManager = new HookManager()

let hooksDiscovered = false

/**
 * 发现所有 hooks（从插件包 + 项目级 + 用户级，幂等）。
 * 需要在 ensureSkillsDiscovered() 之后调用，因为依赖插件目录列表。
 */
export async function ensureHooksDiscovered(): Promise<void> {
  if (hooksDiscovered) return
  hooksDiscovered = true

  // 1. 从已发现的插件包中收集 hooks
  for (const pluginDir of skillStore.getPluginDirs()) {
    const pluginName = pluginDir.replace(/\\/g, '/').split('/').pop() ?? ''
    await hookManager.discoverFromFile(
      join(pluginDir, 'hooks', 'hooks.json'),
      'plugin',
      pluginName,
    )
  }

  // 2. 项目级
  await hookManager.discoverFromFile(join(process.cwd(), '.zcli', 'hooks.json'), 'project')

  // 3. 用户级
  await hookManager.discoverFromFile(join(homedir(), '.zcli', 'hooks.json'), 'user')
}

/**
 * 执行 SessionStart hooks，返回合并的 additionalContext。
 * @param trigger 触发子类型：'startup' | 'resume' | 'compact'
 */
export async function runSessionStartHooks(trigger: string): Promise<string> {
  const results = await hookManager.run('SessionStart', {
    trigger,
    env: {
      ZCLI_CWD: process.cwd(),
      ZCLI_TRIGGER: trigger,
    },
  })

  const contexts: string[] = []
  for (const r of results) {
    if (!r) continue
    // 兼容 Claude Code 格式（hookSpecificOutput.additionalContext）和通用格式（additionalContext / additional_context）
    const hookOutput = r['hookSpecificOutput']
    const ctx = (typeof hookOutput === 'object' && hookOutput !== null
      ? (hookOutput as Record<string, unknown>)['additionalContext']
      : undefined)
      ?? r['additionalContext']
      ?? r['additional_context']
    if (typeof ctx === 'string' && ctx.trim()) {
      contexts.push(ctx)
    }
  }
  return contexts.join('\n\n')
}

// ═══ 指令文件（ZCLI.md / CLAUDE.md） ═══

let cachedInstructions: LoadedInstruction[] | null = null

/**
 * 加载多层级指令文件（幂等，只加载一次）。
 * 会话期间不热更新，重启生效。
 */
export function ensureInstructionsLoaded(): void {
  if (cachedInstructions != null) return
  cachedInstructions = loadInstructions(process.cwd())
}

/** 获取指令文件的 system prompt 段落 */
export function getInstructionsPrompt(): string {
  if (cachedInstructions == null) return ''
  return formatInstructionsPrompt(cachedInstructions)
}

/** 获取已加载的指令文件列表（诊断/调试用） */
export function getLoadedInstructions(): LoadedInstruction[] {
  return cachedInstructions ?? []
}

// ═══ System Prompt 一次构建 ═══

let cachedSystemPrompt: string | undefined

/**
 * 构建并缓存 system prompt（幂等，只构建一次）。
 *
 * 需要在 ensureSkillsDiscovered / ensureHooksDiscovered / ensureInstructionsLoaded 之后调用。
 * 构建后全程复用同一字符串引用，不再重新拼接：
 * - 利用 Anthropic API 的 prompt caching（前缀不变 → cache 命中率高）
 * - 指令文件超过 400 行自动截断，LLM 需要时自行 Read 完整内容
 *
 * @param hookContext SessionStart hook 注入的 additionalContext
 */
export function buildSystemPrompt(hookContext: string): void {
  if (cachedSystemPrompt !== undefined) return

  const instructionsPrompt = getInstructionsPrompt()
  const skillsPrompt = getSkillsSystemPrompt()
  const parts = [instructionsPrompt, skillsPrompt, hookContext].filter(Boolean)
  cachedSystemPrompt = parts.length > 0 ? parts.join('\n\n') : undefined
}

/** 获取已缓存的 system prompt（未构建时返回 undefined） */
export function getSystemPrompt(): string | undefined {
  return cachedSystemPrompt
}

/** 确保 MCP Server 已初始化连接（幂等，只连接一次） */
export async function ensureMcpInitialized(): Promise<void> {
  if (mcpInitialized) return
  mcpInitialized = true

  const config = loadMcpConfigWithSources()
  if (Object.keys(config.mcpServers).length === 0) return

  mcpManager = new McpManager(config)
  mcpManager.onConnect = (event) => sessionLogger.logMcpConnect(event)
  await mcpManager.connectAll()
}

/** 将 MCP 工具注册到 ToolRegistry（需先调用 ensureMcpInitialized） */
export function registerMcpTools(registry: ToolRegistry): void {
  if (mcpManager != null) {
    for (const tool of mcpManager.getTools()) {
      registry.register(tool)
    }
  }
}

/** 获取 MCP Server 状态信息（/mcp 指令用） */
export async function getMcpStatus() {
  await ensureMcpInitialized()
  if (mcpManager == null) return []
  return mcpManager.getStatus()
}
