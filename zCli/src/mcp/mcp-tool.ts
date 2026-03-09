// src/mcp/mcp-tool.ts

import type { Client } from '@modelcontextprotocol/sdk/client'
import type { Tool, ToolContext, ToolResult } from '@tools/types.js'

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/**
 * 将 MCP Server 暴露的工具适配为 ZCli 内部 Tool 接口。
 * 命名格式: mcp__<serverName>__<toolName>
 */
export class McpTool implements Tool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly dangerous = true

  readonly #toolName: string
  readonly #client: Client

  constructor(serverName: string, def: McpToolDefinition, client: Client) {
    this.name = `mcp__${serverName}__${def.name}`
    this.description = def.description ?? ''
    this.parameters = def.inputSchema
    this.#toolName = def.name
    this.#client = client
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await this.#client.callTool({ name: this.#toolName, arguments: args })

      const contentArray = (result.content ?? []) as Array<{ type: string; text?: string }>
      const text = contentArray
        .filter((c) => c.type === 'text' && c.text !== undefined)
        .map((c) => c.text)
        .join('')

      if (result.isError) {
        return { success: false, output: '', error: text }
      }

      return { success: true, output: text }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, output: '', error: message }
    }
  }
}
