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
