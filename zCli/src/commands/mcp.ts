// src/commands/mcp.ts

import type { Command, CommandResult } from '@commands/types.js'

/** /mcp 指令 — 显示 MCP Server 连接状态和工具列表 */
export class McpCommand implements Command {
  readonly name = 'mcp'
  readonly description = 'Show MCP server status and tools'

  execute(_args: string[]): CommandResult {
    return { handled: true, action: { type: 'show_mcp_status' } }
  }
}
