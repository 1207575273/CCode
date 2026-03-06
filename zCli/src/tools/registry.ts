// src/tools/registry.ts
import type { Tool, ToolContext, ToolResult } from './types.js'
import type { ToolDefinition } from '@providers/provider.js'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  isDangerous(name: string): boolean {
    return this.tools.get(name)?.dangerous === true
  }

  toToolDefinitions(): ToolDefinition[] {
    return this.getAll().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, output: '', error: `未知工具: "${name}"` }
    }
    try {
      return await tool.execute(args, ctx)
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
