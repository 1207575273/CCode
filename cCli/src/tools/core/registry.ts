// src/tools/registry.ts
import type { Tool, ToolContext, ToolResult } from './types.js'
import type { ToolDefinition } from '@providers/provider.js'

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>()
  #cachedDefinitions: ToolDefinition[] | null = null

  register(tool: Tool): void {
    this.#tools.set(tool.name, tool)
    this.#cachedDefinitions = null  // 注册新工具时失效缓存
  }

  getAll(): Tool[] {
    return Array.from(this.#tools.values())
  }

  has(name: string): boolean {
    return this.#tools.has(name)
  }

  /** 获取原始 Tool 实例（用于 isStreamableTool 判断等） */
  get(name: string): Tool | undefined {
    return this.#tools.get(name)
  }

  /**
   * 克隆当前 registry，排除指定工具（黑名单）。
   * 用于构建子 Agent 的受限工具集（如排除 dispatch_agent 防递归）。
   */
  cloneWithout(...names: string[]): ToolRegistry {
    const excludeSet = new Set(names)
    const cloned = new ToolRegistry()
    for (const tool of this.#tools.values()) {
      if (!excludeSet.has(tool.name)) {
        cloned.register(tool)
      }
    }
    return cloned
  }

  /**
   * 克隆当前 registry，只保留指定工具（白名单）。
   * 用于构建子 Agent 白名单工具集（如 explore 只保留只读工具）。
   */
  cloneWith(...names: string[]): ToolRegistry {
    const includeSet = new Set(names)
    const cloned = new ToolRegistry()
    for (const tool of this.#tools.values()) {
      if (includeSet.has(tool.name)) {
        cloned.register(tool)
      }
    }
    return cloned
  }

  isDangerous(name: string): boolean {
    return this.#tools.get(name)?.dangerous === true
  }

  toToolDefinitions(): ToolDefinition[] {
    if (!this.#cachedDefinitions) {
      this.#cachedDefinitions = this.getAll().map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }))
    }
    return this.#cachedDefinitions
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.#tools.get(name)
    if (!tool) {
      return { success: false, output: '', error: `未知工具: "${name}"` }
    }
    try {
      return await tool.execute(args, ctx)
    } catch (err) {
      // 【雷区二】传完整 stack 让 LLM 能定位到文件和行号自我纠错
      return {
        success: false,
        output: '',
        error: err instanceof Error
          ? `${err.message}\n${err.stack ?? ''}`
          : String(err),
      }
    }
  }
}
