// src/mcp/mcp-manager.ts

import type { McpConfig, McpServerConfig } from '@config/mcp-config'
import { McpTool } from '@mcp/mcp-tool'
import type { McpToolDefinition } from '@mcp/mcp-tool'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

interface ConnectedServer {
  name: string
  client: Client
  tools: McpTool[]
}

/**
 * MCP Server 连接生命周期管理器。
 * 读取配置 → 连接所有 Server → 收集工具 → 优雅关闭。
 */
export class McpManager {
  private readonly config: McpConfig
  private readonly servers: ConnectedServer[] = []

  constructor(config: McpConfig) {
    this.config = config
  }

  /** 连接所有配置的 MCP Server，单个失败不影响其余 */
  async connectAll(): Promise<void> {
    const entries = Object.entries(this.config.mcpServers)

    for (const [serverName, serverConfig] of entries) {
      try {
        const client = new Client({ name: 'zcli', version: '0.1.0' })
        const transport = this.createTransport(serverConfig)

        await client.connect(transport)

        const listResult = await client.listTools()
        const tools = (listResult.tools ?? []).map((toolDef) => {
          const definition: McpToolDefinition = {
            name: toolDef.name,
            ...(toolDef.description !== undefined ? { description: toolDef.description } : {}),
            inputSchema: toolDef.inputSchema as Record<string, unknown>,
          }
          return new McpTool(serverName, definition, client)
        })

        this.servers.push({ name: serverName, client, tools })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[McpManager] Failed to connect server "${serverName}": ${message}`)
      }
    }
  }

  /** 返回所有已连接 Server 的工具列表 */
  getTools(): McpTool[] {
    return this.servers.flatMap((s) => s.tools)
  }

  /** 获取所有已连接 Server 的状态摘要 */
  getStatus(): Array<{ name: string; toolCount: number; toolNames: string[] }> {
    return this.servers.map(s => ({
      name: s.name,
      toolCount: s.tools.length,
      toolNames: s.tools.map(t => t.name),
    }))
  }

  /** 断开所有连接，忽略单个关闭错误 */
  async disconnectAll(): Promise<void> {
    for (const server of this.servers) {
      try {
        await server.client.close()
      } catch {
        // 静默忽略关闭错误
      }
    }
    this.servers.length = 0
  }

  /** 根据 ServerConfig 创建对应的 Transport */
  private createTransport(config: McpServerConfig): Transport {
    // Stdio: command 存在
    if (config.command) {
      return new StdioClientTransport({
        command: config.command,
        ...(config.args !== undefined ? { args: config.args } : {}),
        env: { ...process.env, ...config.env } as Record<string, string>,
      }) as Transport
    }

    // SSE: 显式指定 type=sse 且有 url
    if (config.type === 'sse' && config.url) {
      return new SSEClientTransport(new URL(config.url)) as Transport
    }

    // Streamable HTTP: 显式指定 type=streamable-http 且有 url
    if (config.type === 'streamable-http' && config.url) {
      return new StreamableHTTPClientTransport(new URL(config.url)) as Transport
    }

    // 有 url 但未指定 type → 默认 StreamableHTTP
    if (config.url) {
      return new StreamableHTTPClientTransport(new URL(config.url)) as Transport
    }

    throw new Error('Cannot determine transport: need either "command" or "url" in server config')
  }
}
