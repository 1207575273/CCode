// src/plugin/registry.ts

/**
 * PluginRegistry — Runtime Plugin 发现、加载、激活、管理。
 *
 * 发现来源（优先级从低到高）：
 * 1. npm 全局安装的 ccode-plugin-* 包
 * 2. 配置文件声明 config.plugins[]
 * 3. 用户级 ~/.ccode/plugins/<name>/runtime/index.js
 * 4. 项目级 <cwd>/.ccode/plugins/<name>/runtime/index.js
 *
 * 加载时机：bootstrapAll() 阶段，与 Skills/Hooks 发现并行。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ToolRegistry } from '@tools/core/registry.js'
import type { Tool } from '@tools/core/types.js'
import { eventBus } from '@core/event-bus.js'
import { createPluginStorage } from './storage.js'
import type {
  CCodePlugin,
  PluginContext,
  PluginCommand,
  InputAction,
  StatusBarItem,
  LoadedPluginInfo,
  Disposable,
} from './types.js'

/** 已加载的插件信息 */
interface LoadedPlugin {
  plugin: CCodePlugin
  source: 'npm' | 'user' | 'project' | 'config'
  commands: PluginCommand[]
  tools: Tool[]
  inputActions: InputAction[]
  statusBarItems: StatusBarItem[]
  disposables: Disposable[]
  error?: string
}

/** 外部回调：注入输入、提交输入、追加系统消息 */
export interface PluginBridge {
  injectInput(text: string): void
  submitInput(text: string): void
  appendSystemMessage(text: string): void
  getSessionId(): string | null
  getModel(): string
  getProvider(): string
}

export class PluginRegistry {
  #plugins = new Map<string, LoadedPlugin>()
  #bridge: PluginBridge | null = null

  /** 设置 UI 桥接（useChat mount 后调用） */
  setBridge(bridge: PluginBridge): void {
    this.#bridge = bridge
  }

  /**
   * 发现并加载所有插件。
   */
  async discover(toolRegistry: ToolRegistry): Promise<void> {
    const paths = this.#collectPluginPaths()

    for (const { path, source } of paths) {
      await this.#loadPlugin(path, source, toolRegistry)
    }
  }

  /** 获取所有已加载的插件信息（/plugins 命令用） */
  list(): LoadedPluginInfo[] {
    return [...this.#plugins.values()].map(p => ({
      name: p.plugin.name,
      version: p.plugin.version,
      description: p.plugin.description,
      source: p.source,
      status: p.error ? 'error' as const : 'active' as const,
      commands: p.commands.map(c => c.name),
      tools: p.tools.map(t => t.name),
      ...(p.error ? { error: p.error } : {}),
    }))
  }

  /** 获取插件注册的所有命令（合并到 CommandRegistry） */
  getCommands(): PluginCommand[] {
    const commands: PluginCommand[] = []
    for (const p of this.#plugins.values()) {
      commands.push(...p.commands)
    }
    return commands
  }

  /** 获取插件注册的所有 InputAction（UI 渲染用） */
  getInputActions(): InputAction[] {
    const actions: InputAction[] = []
    for (const p of this.#plugins.values()) {
      actions.push(...p.inputActions)
    }
    return actions
  }

  /** 获取插件注册的所有 StatusBarItem（UI 渲染用） */
  getStatusBarItems(): StatusBarItem[] {
    const items: StatusBarItem[] = []
    for (const p of this.#plugins.values()) {
      items.push(...p.statusBarItems)
    }
    return items
  }

  /** 停用所有插件（CCode 退出时调用） */
  async deactivateAll(): Promise<void> {
    for (const loaded of this.#plugins.values()) {
      try {
        // 释放所有 disposable
        for (const d of loaded.disposables) {
          try { d.dispose() } catch { /* ignore */ }
        }
        // 调用插件 deactivate
        await loaded.plugin.deactivate?.()
      } catch {
        // 停用失败不影响退出
      }
    }
    this.#plugins.clear()
  }

  // ═══════════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════════

  /** 收集所有插件路径 */
  #collectPluginPaths(): Array<{ path: string; source: 'npm' | 'user' | 'project' | 'config' }> {
    const paths: Array<{ path: string; source: 'npm' | 'user' | 'project' | 'config' }> = []

    // 1. 用户级插件目录
    const userPluginsDir = join(homedir(), '.ccode', 'plugins')
    if (existsSync(userPluginsDir)) {
      for (const entry of readdirSync(userPluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const runtimeEntry = join(userPluginsDir, entry.name, 'runtime', 'index.js')
        if (existsSync(runtimeEntry)) {
          paths.push({ path: runtimeEntry, source: 'user' })
        }
      }
    }

    // 2. 项目级插件目录
    const projectPluginsDir = join(process.cwd(), '.ccode', 'plugins')
    if (existsSync(projectPluginsDir)) {
      for (const entry of readdirSync(projectPluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const runtimeEntry = join(projectPluginsDir, entry.name, 'runtime', 'index.js')
        if (existsSync(runtimeEntry)) {
          paths.push({ path: runtimeEntry, source: 'project' })
        }
      }
    }

    return paths
  }

  /** 加载单个插件 */
  async #loadPlugin(
    pluginPath: string,
    source: 'npm' | 'user' | 'project' | 'config',
    toolRegistry: ToolRegistry,
  ): Promise<void> {
    const loaded: LoadedPlugin = {
      plugin: { name: 'unknown', version: '0.0.0', description: '', activate: () => {} },
      source,
      commands: [],
      tools: [],
      inputActions: [],
      statusBarItems: [],
      disposables: [],
    }

    try {
      // 动态 import 插件入口（Windows 需要 file:// URL）
      const { pathToFileURL } = await import('node:url')
      const mod = await import(pathToFileURL(pluginPath).href)
      const plugin: CCodePlugin = mod.default ?? mod

      if (!plugin.name || !plugin.activate) {
        throw new Error('插件必须导出 name 和 activate')
      }

      loaded.plugin = plugin

      // 构建 PluginContext
      const pluginDir = join(homedir(), '.ccode', 'plugins', plugin.name)
      const storagePath = join(pluginDir, 'storage.json')

      const context: PluginContext = {
        registerCommand: (cmd) => { loaded.commands.push(cmd) },
        registerTool: (tool) => {
          loaded.tools.push(tool)
          toolRegistry.register(tool)
        },
        onEvent: (type, handler) => {
          const unsub = eventBus.on((event) => {
            if ((event as Record<string, unknown>)['type'] === type) {
              handler(event)
            }
          })
          const disposable = { dispose: unsub }
          loaded.disposables.push(disposable)
          return disposable
        },
        emit: (event) => { eventBus.emit(event as any) },
        registerInputAction: (action) => { loaded.inputActions.push(action) },
        registerStatusBarItem: (item) => { loaded.statusBarItems.push(item) },
        injectInput: (text) => { this.#bridge?.injectInput(text) },
        submitInput: (text) => { this.#bridge?.submitInput(text) },
        appendSystemMessage: (text) => { this.#bridge?.appendSystemMessage(text) },
        getSessionId: () => this.#bridge?.getSessionId() ?? null,
        getCwd: () => process.cwd(),
        getModel: () => this.#bridge?.getModel() ?? 'unknown',
        getProvider: () => this.#bridge?.getProvider() ?? 'unknown',
        storage: createPluginStorage(storagePath),
      }

      // 激活
      await plugin.activate(context)
      this.#plugins.set(plugin.name, loaded)
    } catch (err) {
      loaded.error = err instanceof Error ? err.message : String(err)
      this.#plugins.set(loaded.plugin.name, loaded)
      // 插件加载失败不阻断 CCode 启动
      process.stderr.write(`[plugin] Failed to load "${loaded.plugin.name}": ${loaded.error}\n`)
    }
  }
}

/** 全局单例 */
export const pluginRegistry = new PluginRegistry()
