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

import { ToolRegistry } from '@tools/core/registry.js'
import { ReadFileTool } from '@tools/core/read-file.js'
import { WriteFileTool } from '@tools/core/write-file.js'
import { EditFileTool } from '@tools/core/edit-file.js'
import { GlobTool } from '@tools/core/glob.js'
import { GrepTool } from '@tools/core/grep.js'
import { BashTool } from '@tools/core/bash.js'
import { KillShellTool } from '@tools/core/kill-shell.js'
import { TaskOutputTool } from '@tools/core/task-output.js'
import { TodoWriteTool } from '@tools/ext/todo-write.js'
import { DispatchAgentTool } from '@tools/ext/dispatch-agent.js'
import { AskUserQuestionTool } from '@tools/ext/ask-user-question.js'
import { loadMcpConfigWithSources } from '@config/mcp-config.js'
import { McpManager } from '@mcp/mcp-manager.js'
import { SessionLogger, TokenMeter } from '@observability/index.js'
import { SkillStore } from '@skills/engine/store.js'
import { SkillTool } from '@skills/engine/skill-tool.js'
import { loadInstructions, formatInstructionsPrompt } from '@config/instructions-loader.js'
import type { LoadedInstruction } from '@config/instructions-loader.js'
import { HookManager } from '@hooks/hook-manager.js'
import { FileIndex, FileWatcher, createIgnoreFilter } from '@file-index/index.js'
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
  reg.register(new KillShellTool())
  reg.register(new TaskOutputTool())
  reg.register(new TodoWriteTool())
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
  await hookManager.discoverFromFile(join(process.cwd(), '.ccode', 'hooks.json'), 'project')

  // 3. 用户级
  await hookManager.discoverFromFile(join(homedir(), '.ccode', 'hooks.json'), 'user')
}

/**
 * 执行 SessionStart hooks，返回合并的 additionalContext。
 * @param trigger 触发子类型：'startup' | 'resume' | 'compact'
 */
export async function runSessionStartHooks(trigger: string): Promise<string> {
  const results = await hookManager.run('SessionStart', {
    trigger,
    env: {
      CCODE_CWD: process.cwd(),
      CCODE_TRIGGER: trigger,
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

// ═══ 文件索引（@ Mention 用） ═══

/** 模块级 FileIndex 实例 */
export const fileIndex = new FileIndex(process.cwd())

let fileIndexReady = false
let fileWatcher: FileWatcher | null = null

/**
 * 初始化文件索引：全量扫描 + 启动监听（幂等）。
 * 异步执行，不阻塞首帧渲染。
 */
export async function ensureFileIndexReady(): Promise<void> {
  if (fileIndexReady) return
  fileIndexReady = true

  await fileIndex.scan()

  const ig = createIgnoreFilter(process.cwd())
  fileWatcher = new FileWatcher(process.cwd(), fileIndex, ig)
  fileWatcher.start()
}

/** 停止文件监听（app 退出时调用） */
export function stopFileWatcher(): void {
  fileWatcher?.stop()
}

// ═══ 指令文件（CCODE.md / CLAUDE.md） ═══

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

/** MCP 连接是否已完成（成功或无配置） */
let mcpReady = false
/** MCP 后台连接 Promise（供 getMcpStatus 等需要等待的场景使用） */
let mcpPromise: Promise<void> | null = null
/** MCP 后台连接耗时（毫秒），仅 dev 模式下记录 */
let mcpTimingMs = 0

/** 确保 MCP Server 已初始化连接（幂等，只连接一次） */
export async function ensureMcpInitialized(): Promise<void> {
  if (mcpInitialized) return
  mcpInitialized = true

  const config = loadMcpConfigWithSources()
  if (Object.keys(config.mcpServers).length === 0) {
    mcpReady = true
    return
  }

  mcpManager = new McpManager(config)
  mcpManager.onConnect = (event) => sessionLogger.logMcpConnect(event)
  await mcpManager.connectAll()
  mcpReady = true
}

/**
 * 后台启动 MCP 连接（fire-and-forget，不阻塞任何流程）。
 * App mount 时调用，用户对话不受 MCP 连接延迟影响。
 * MCP 就绪后 isMcpReady() 返回 true，submit 时自动注册工具。
 *
 * @param onReady 可选回调，MCP 就绪后触发（供 UI 更新 timing 显示）
 */
export function startMcpBackground(onReady?: () => void): void {
  if (mcpPromise) return
  const t = performance.now()
  mcpPromise = ensureMcpInitialized().then(() => {
    mcpTimingMs = performance.now() - t
    onReady?.()
  })
}

/** MCP 是否已连接就绪 */
export function isMcpReady(): boolean {
  return mcpReady
}

/** 获取 MCP 后台连接耗时（毫秒），未完成时返回 0 */
export function getMcpTiming(): number {
  return mcpTimingMs
}

/** 将 MCP 工具注册到 ToolRegistry（MCP 未就绪时静默跳过） */
export function registerMcpTools(registry: ToolRegistry): void {
  if (mcpManager != null) {
    for (const tool of mcpManager.getTools()) {
      registry.register(tool)
    }
  }
}

/** 获取 MCP Server 状态信息（/mcp 指令用，会等待连接完成） */
export async function getMcpStatus() {
  if (mcpPromise) await mcpPromise
  else await ensureMcpInitialized()
  if (mcpManager == null) return []
  return mcpManager.getStatus()
}

// ═══ 统一启动编排 ═══

/**
 * bootstrapAll() 返回结果，供调用方判断各子系统就绪状态。
 */
export interface BootstrapResult {
  /** Skills 是否已发现 */
  skillsReady: boolean
  /** 文件索引是否已就绪 */
  fileIndexReady: boolean
  /** System Prompt 是否已构建 */
  systemPromptReady: boolean
  /** 各模块耗时（毫秒），仅 dev 模式填充 */
  timings?: BootstrapTimings
}

/** 各模块启动耗时（毫秒），MCP 后台独立加载不计入 */
export interface BootstrapTimings {
  skills: number
  instructions: number
  hooks: number
  sessionStartHooks: number
  systemPrompt: number
  fileIndex: number
  total: number
}

let bootstrapPromise: Promise<BootstrapResult> | null = null

/** 是否 dev 模式（tsx 直接跑 .ts 文件） */
export const isDevMode = (process.argv[1] ?? '').endsWith('.ts')

/**
 * 统一启动编排 — 按依赖拓扑最大化并行（幂等，多次调用返回同一 Promise）。
 *
 * 两条独立链路并行执行，总耗时 = max(链A, 链B)：
 * - 链 A：Skills → Instructions → Hooks → SessionStartHooks → SystemPrompt
 * - 链 B：文件索引扫描（磁盘 IO）
 *
 * MCP 不在此编排内 — 通过 startMcpBackground() 后台静默加载，
 * 不阻塞启动和首次对话，就绪后 submit 时自动注册工具。
 */
export function bootstrapAll(): Promise<BootstrapResult> {
  if (bootstrapPromise) return bootstrapPromise

  bootstrapPromise = (async (): Promise<BootstrapResult> => {
    const t0 = performance.now()
    const timings: Record<string, number> = {}

    await Promise.all([
      // 链 A：Skills → Hooks → SessionStartHooks → SystemPrompt（串行依赖链）
      (async () => {
        let t = performance.now()
        await ensureSkillsDiscovered()
        timings['skills'] = performance.now() - t

        t = performance.now()
        ensureInstructionsLoaded()
        timings['instructions'] = performance.now() - t

        t = performance.now()
        await ensureHooksDiscovered()
        timings['hooks'] = performance.now() - t

        t = performance.now()
        const hookContext = await runSessionStartHooks('startup')
        timings['sessionStartHooks'] = performance.now() - t

        t = performance.now()
        buildSystemPrompt(hookContext)
        timings['systemPrompt'] = performance.now() - t
      })(),
      // 链 B：文件索引扫描（磁盘 IO，完全独立）
      (async () => {
        const t = performance.now()
        await ensureFileIndexReady()
        timings['fileIndex'] = performance.now() - t
      })(),
    ])

    timings['total'] = performance.now() - t0

    return {
      skillsReady: true,
      fileIndexReady: true,
      systemPromptReady: true,
      timings: timings as unknown as BootstrapTimings,
    }
  })()

  return bootstrapPromise
}

/**
 * 获取 bootstrap 进度的同步快照（供 UI 渲染判断各子系统是否就绪）。
 * 不触发初始化，只读取当前状态。
 */
export function getBootstrapStatus() {
  return {
    skillsReady: skillStore.isDiscovered(),
    fileIndexReady,
    systemPromptReady: cachedSystemPrompt !== undefined,
  }
}
