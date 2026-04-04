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
import { DispatchAgentTool } from '@tools/agent/dispatch-agent.js'
import { registerBuiltInAgents } from '@tools/agent/built-in.js'
import { AskUserQuestionTool } from '@tools/ext/ask-user-question.js'
import { VerifyCodeTool } from '@tools/ext/verify-code.js'
import { loadMcpConfigWithSources } from '@config/mcp-config.js'
import { McpManager } from '@mcp/mcp-manager.js'
import { SessionLogger, TokenMeter } from '@observability/index.js'
import { SkillStore } from '@skills/engine/store.js'
import { SkillTool } from '@skills/engine/skill-tool.js'
import { loadInstructions, formatInstructionsPrompt } from '@config/instructions-loader.js'
import type { LoadedInstruction } from '@config/instructions-loader.js'
import { HookManager } from '@hooks/hook-manager.js'
import { FileIndex, FileWatcher, createIgnoreFilter } from '@file-index/index.js'
import { pluginRegistry } from '@plugin/registry.js'
import { MemoryManager } from '@memory/core/memory-manager.js'
import { MemoryWriteTool } from '@memory/tools/memory-write-tool.js'
import { MemorySearchTool } from '@memory/tools/memory-search-tool.js'
import { MemoryDeleteTool } from '@memory/tools/memory-delete-tool.js'
import { NoopEmbedding } from '@memory/rag/embedding/noop-embedding.js'
import { ProviderEmbedding } from '@memory/rag/embedding/provider-embedding.js'
import { LibsqlVectorStore } from '@memory/storage/libsql-vector-store.js'
import { configManager } from '@config/config-manager.js'
import { startSnapshotCreation, cleanupSnapshot } from '@platform/shell-snapshot.js'
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

/** 模块级 MemoryManager 实例（bootstrapAll 中初始化） */
let memoryManagerInstance: MemoryManager | null = null

/** 获取 MemoryManager 实例（未初始化时返回 null） */
export function getMemoryManager(): MemoryManager | null {
  return memoryManagerInstance
}

// ═══ 工厂函数 ═══

/** 构建包含全部内置工具的 ToolRegistry（含 skill 工具 + memory 工具） */
function buildRegistry(): ToolRegistry {
  // 确保内置 Agent 定义已注册（幂等，DispatchAgentTool 依赖 registry 生成参数 enum）
  registerBuiltInAgents()

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
  reg.register(new VerifyCodeTool())
  reg.register(new SkillTool(skillStore))
  // Memory 工具（MemoryManager 初始化后注册）
  if (memoryManagerInstance) {
    reg.register(new MemoryWriteTool(memoryManagerInstance))
    reg.register(new MemorySearchTool(memoryManagerInstance))
    reg.register(new MemoryDeleteTool(memoryManagerInstance))
  }
  return reg
}

/** 会话级 registry 单例（工具实例无状态，安全复用） */
let _registryCache: ToolRegistry | null = null

/** 获取 ToolRegistry 单例，首次调用时构建，MCP 工具注册后 invalidate 重建 */
export function getRegistry(): ToolRegistry {
  if (!_registryCache) {
    _registryCache = buildRegistry()
  }
  return _registryCache
}

/** 标记 registry 需要重建（MemoryManager 延迟初始化完成后调用） */
export function invalidateRegistry(): void {
  _registryCache = null
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

// ═══ Runtime Plugin ═══

let pluginsLoaded = false

/** 发现并加载 Runtime Plugin（幂等） */
async function ensurePluginsLoaded(): Promise<void> {
  if (pluginsLoaded) return
  pluginsLoaded = true
  const registry = getRegistry()
  await pluginRegistry.discover(registry)
}

/** 导出 pluginRegistry 供 UI 层使用 */
export { pluginRegistry }

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

/** System Prompt 各段元信息 */
export interface SystemPromptSection {
  name: string
  charLength: number
}
let cachedSections: SystemPromptSection[] = []

/**
 * 构建并缓存 system prompt（幂等，只构建一次）。
 *
 * 需要在 ensureSkillsDiscovered / ensureHooksDiscovered / ensureInstructionsLoaded 之后调用。
 * 构建后全程复用同一字符串引用，不再重新拼接：
 * - 利用 Anthropic API 的 prompt caching（前缀不变 → cache 命中率高）
 * - 指令文件超过 400 行自动截断，LLM 需要时自行 Read 完整内容
 *
 * @param hookContext SessionStart hook 注入的 additionalContext
 * @param memoryContext 记忆系统冷启动上下文（可选）
 */
export function buildSystemPrompt(hookContext: string, memoryContext?: string): void {
  if (cachedSystemPrompt !== undefined) return

  const instructionsPrompt = getInstructionsPrompt()
  const skillsPrompt = getSkillsSystemPrompt()

  // 保存各段元信息（供记忆全景面板展示）
  cachedSections = []
  if (instructionsPrompt) cachedSections.push({ name: 'Instructions', charLength: instructionsPrompt.length })
  if (skillsPrompt) cachedSections.push({ name: 'Skills', charLength: skillsPrompt.length })
  if (hookContext) cachedSections.push({ name: 'Hooks', charLength: hookContext.length })
  if (memoryContext) cachedSections.push({ name: 'Memory', charLength: memoryContext.length })

  /**
   * 内置行为指导 — 告诉 LLM "该怎么干活"。
   *
   * 对比 Claude Code CLI 发现：cCli 之前只注入了 Instructions（用户规则）和 Skills（工具列表），
   * 缺少对 LLM 工作方式的核心行为约束，导致 LLM 容易"干到一半停下来"或"说了不做"。
   *
   * 这段提示词解决五个问题：
   *   1. 完成承诺 — 不要半途而废，做完再报告
   *   2. 验证闭环 — 报告完成前先验证（跑命令、看输出）
   *   3. 错误恢复 — 失败了先诊断再换方案，不要盲目重试或放弃
   *   4. 工具优先 — 优先用专用工具（Read/Write/Edit/Grep），bash 只用于系统命令
   *   5. 执行效率 — 独立的工具调用并行执行，不要串行等待
   */
  const behaviorGuidance = [
    '# Task Execution Rules',
    '',
    '- Complete the task fully. Do NOT leave it half-done. Do NOT just describe what to do — actually do it by calling tools.',
    '- Before reporting a task as complete, verify it actually works: run the code, check the output, confirm no errors.',
    '- If an approach fails, diagnose WHY before switching tactics — read the error, check your assumptions, try a focused fix. Do not retry blindly, but do not abandon a viable approach after a single failure either.',
    '- Use dedicated tools when available: Read (not cat), Write (not echo), Edit (not sed), Grep (not grep), Glob (not find). Use Bash only for system commands and operations that require shell execution.',
    '- When multiple tool calls are independent, make them all in a single response to maximize parallelism.',
    '- Keep working until the task is genuinely done. If you output text without tool calls, you are signaling that you are finished. Only do this when all work is verified complete.',
  ].join('\n')

  const parts = [behaviorGuidance, instructionsPrompt, skillsPrompt, hookContext, memoryContext].filter(Boolean)
  if (behaviorGuidance) cachedSections.unshift({ name: 'Behavior', charLength: behaviorGuidance.length })
  cachedSystemPrompt = parts.length > 0 ? parts.join('\n\n') : undefined
}

/** 获取已缓存的 system prompt（未构建时返回 undefined） */
export function getSystemPrompt(): string | undefined {
  return cachedSystemPrompt
}

/** 获取 System Prompt 各段元信息 */
export function getSystemPromptSections(): SystemPromptSection[] {
  return cachedSections
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
  /** 各模块耗时（毫秒） */
  timings?: BootstrapTimings
  /** 启动过程中的降级/警告信息（会在 UI 中短暂显示） */
  warnings: string[]
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
 * 4 条并行链 + 屏障 + 后台 embed：
 * - 链 A'：Skills → Instructions → Hooks → SessionStartHooks（产出 hookContext）
 * - 链 B'：文件索引扫描（磁盘 IO）
 * - 链 C'：Runtime Plugin 发现
 * - 链 D'：MemoryManager.initialize()（扫描文件 + 加载已有索引 + 建 BM25，毫秒级）
 * ── 屏障：等 A' + D' 都完成 ──
 * → buildSystemPrompt(hookContext, memoryContext)
 * → 后台：MemoryManager.embedPending()（增量 embed，不阻塞首次对话）
 *
 * MCP 不在此编排内 — 通过 startMcpBackground() 后台静默加载。
 */
export function bootstrapAll(): Promise<BootstrapResult> {
  if (bootstrapPromise) return bootstrapPromise

  bootstrapPromise = (async (): Promise<BootstrapResult> => {
    const t0 = performance.now()
    const timings: Record<string, number> = {}

    // 链 A' 产出的 hookContext，需要跨 Promise.all 传递
    let hookContext = ''

    await Promise.all([
      // 链 A'：Skills → Hooks → SessionStartHooks（不含 SystemPrompt，屏障后构建）
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
        hookContext = await runSessionStartHooks('startup')
        timings['sessionStartHooks'] = performance.now() - t
      })(),
      // 链 B'：文件索引扫描（磁盘 IO，完全独立）
      (async () => {
        const t = performance.now()
        await ensureFileIndexReady()
        timings['fileIndex'] = performance.now() - t
      })(),
      // 链 C'：Runtime Plugin 发现与激活（独立于 Skills/Hooks）
      (async () => {
        const t = performance.now()
        await ensurePluginsLoaded()
        timings['plugins'] = performance.now() - t
      })(),
      // 链 D'：MemoryManager 同步阶段（扫描文件 + BM25，毫秒级）
      (async () => {
        const t = performance.now()
        await ensureMemoryInitialized()
        timings['memory'] = performance.now() - t
      })(),
      // 链 E'：Shell 快照创建（完全独立，后续 bash 命令 source 快照跳过 login shell）
      (async () => {
        const t = performance.now()
        await startSnapshotCreation()
        timings['shellSnapshot'] = performance.now() - t
      })(),
    ])

    // ── 屏障：A' + D' 都完成 ──
    // 合并 hookContext + memoryContext 构建 SystemPrompt
    const t = performance.now()
    let memoryContext: string | undefined
    if (memoryManagerInstance) {
      memoryContext = await memoryManagerInstance.getRelevantContext(process.cwd())
    }
    buildSystemPrompt(hookContext, memoryContext || undefined)
    timings['systemPrompt'] = performance.now() - t

    // 后台：增量 embed（不阻塞启动和首次对话）
    if (memoryManagerInstance) {
      memoryManagerInstance.embedPending().catch(() => { /* embed 失败不影响启动 */ })
    }

    // 退出时清理 shell 快照文件
    process.on('exit', () => { void cleanupSnapshot() })

    timings['total'] = performance.now() - t0

    return {
      skillsReady: true,
      fileIndexReady: true,
      systemPromptReady: true,
      timings: timings as unknown as BootstrapTimings,
      warnings: [...bootstrapWarnings],
    }
  })()

  return bootstrapPromise
}

// ═══ 记忆系统初始化 ═══

let memoryInitialized = false
/** 启动过程中收集的警告（在 UI 中显示） */
const bootstrapWarnings: string[] = []

/**
 * 初始化 MemoryManager（幂等）。
 * 读取 config.json 中的 memory 配置，构建 MemoryManager 实例。
 */
async function ensureMemoryInitialized(): Promise<void> {
  if (memoryInitialized) return
  memoryInitialized = true

  try {
    const config = configManager.load()
    const memoryConfig = (config as unknown as Record<string, unknown>)['memory'] as
      | { enabled?: boolean; embedding?: { provider?: string; model?: string } }
      | undefined

    // memory.enabled 默认 false
    if (!memoryConfig?.enabled) return

    // 构建 EmbeddingProvider：独立配置，不依赖 providers
    // config.json: memory.embedding = { apiKey, baseURL, model, dimension }
    // 模板默认值（未修改 = 未配置 = 降级纯 BM25）
    const embConfig = memoryConfig.embedding as
      | { apiKey?: string; baseURL?: string; model?: string; dimension?: number }
      | undefined
    let embedding: import('@memory/types.js').EmbeddingProvider
    let vectorStore: import('@memory/types.js').IVectorStore | null = null

    const isTemplateDefault = !embConfig
      || !embConfig.apiKey || embConfig.apiKey === 'your-embedding-api-key'
      || !embConfig.baseURL || embConfig.baseURL === 'https://your-embedding-api-base-url/v4'
      || !embConfig.model || embConfig.model === 'your-embedding-model'

    if (!isTemplateDefault) {
      // 用户已配置真实的 Embedding，探测连通性
      const dimension = embConfig!.dimension ?? 1024
      const candidate = new ProviderEmbedding({
        providerName: 'embedding',
        apiKey: embConfig!.apiKey!,
        baseURL: embConfig!.baseURL!,
        model: embConfig!.model!,
        dimension,
      })
      // 连通性探测：调一次 isAvailable()（内部用极短文本测试 API）
      let embAvailable = false
      try {
        embAvailable = await candidate.isAvailable()
      } catch { /* 探测异常视为不可用 */ }

      if (embAvailable) {
        embedding = candidate
        try {
          vectorStore = new LibsqlVectorStore(dimension)
          await vectorStore.initialize()
        } catch (err) {
          bootstrapWarnings.push('Embedding 向量存储初始化失败，记忆系统降级为纯 BM25 关键词检索')
          vectorStore = null
        }
      } else {
        bootstrapWarnings.push('Embedding API 不可达，记忆系统降级为纯 BM25 关键词检索（检查 config.json memory.embedding 配置）')
        embedding = new NoopEmbedding()
      }
    } else {
      // 未配置或模板默认值 → 纯 BM25（记忆功能可用，只是检索精度下降）
      embedding = new NoopEmbedding()
    }

    memoryManagerInstance = new MemoryManager({
      cwd: process.cwd(),
      embedding,
      vectorStore,
    })

    await memoryManagerInstance.initialize()

    // 注入 CompactBridge — 压缩上下文时自动提取关键信息到记忆
    const { CompactBridge } = await import('@memory/core/compact-bridge.js')
    const { contextManager } = await import('./context-manager.js')
    contextManager.setCompactBridge(new CompactBridge(memoryManagerInstance))
  } catch (err) {
    // 记忆系统初始化失败不阻塞启动
    bootstrapWarnings.push(`记忆系统初始化失败: ${err instanceof Error ? err.message : String(err)}`)
    memoryManagerInstance = null
  }
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
