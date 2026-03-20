// src/plugin/types.ts

/**
 * CCode Runtime Plugin 类型定义。
 *
 * 插件是一个 npm 包或本地目录，默认导出一个实现 CCodePlugin 接口的对象。
 * CCode 启动时发现并加载插件，调用 activate() 注册能力。
 */

import type { Tool } from '@tools/core/types.js'

// ═══════════════════════════════════════════════
// 核心接口
// ═══════════════════════════════════════════════

/** Runtime Plugin 主接口 */
export interface CCodePlugin {
  /** 插件名称（唯一标识） */
  name: string
  /** 版本号 */
  version: string
  /** 描述 */
  description: string

  /** 激活 — CCode 启动时调用，插件在此注册能力 */
  activate(context: PluginContext): void | Promise<void>

  /** 停用 — CCode 退出时调用，清理资源 */
  deactivate?(): void | Promise<void>
}

/** 可释放资源 */
export interface Disposable {
  dispose(): void
}

// ═══════════════════════════════════════════════
// 插件上下文（扩展点）
// ═══════════════════════════════════════════════

/** 插件可用的扩展点 */
export interface PluginContext {
  // ── 命令扩展 ──

  /** 注册斜杠命令（出现在 /help 和命令建议浮层） */
  registerCommand(command: PluginCommand): void

  // ── 工具扩展 ──

  /** 注册 Tool（LLM 可调用） */
  registerTool(tool: Tool): void

  // ── 事件扩展 ──

  /** 监听事件 */
  onEvent(type: string, handler: (event: unknown) => void): Disposable

  /** 发布事件 */
  emit(event: Record<string, unknown>): void

  // ── UI 扩展点 ──

  /** 在 InputBar 旁注册操作按钮 */
  registerInputAction(action: InputAction): void

  /** 在状态栏注册信息项 */
  registerStatusBarItem(item: StatusBarItem): void

  /** 注入文本到输入框（不发送） */
  injectInput(text: string): void

  /** 直接提交文本（等同用户按 Enter） */
  submitInput(text: string): void

  /** 追加系统消息（仅 UI 显示） */
  appendSystemMessage(text: string): void

  // ── 状态访问 ──

  getSessionId(): string | null
  getCwd(): string
  getModel(): string
  getProvider(): string

  // ── 持久化存储 ──

  /** 插件专属 key-value 存储 */
  storage: PluginStorage
}

// ═══════════════════════════════════════════════
// 子类型
// ═══════════════════════════════════════════════

/** 插件注册的斜杠命令 */
export interface PluginCommand {
  name: string
  description: string
  aliases?: string[]
  execute(args: string[]): void | Promise<void>
}

/** InputBar 旁的操作按钮 */
export interface InputAction {
  id: string
  label: string
  shortcut?: string
  tooltip?: string
  handler(): void | Promise<void>
}

/** 状态栏信息项 */
export interface StatusBarItem {
  id: string
  getText(): string
  getColor?(): string | undefined
  onClick?(): void
}

/** 插件持久化存储 */
export interface PluginStorage {
  get<T>(key: string, defaultValue?: T): T | undefined
  set<T>(key: string, value: T): void
  delete(key: string): void
  keys(): string[]
}

/** 已加载插件的元信息（/plugins 命令展示用） */
export interface LoadedPluginInfo {
  name: string
  version: string
  description: string
  source: 'npm' | 'user' | 'project' | 'config'
  status: 'active' | 'error'
  commands: string[]
  tools: string[]
  error?: string
}
