// src/mcp/mcp-manager.ts

import { APP_VERSION } from '../version.js'
import type { McpServerConfig, McpConfigWithSources } from '@config/mcp-config.js'
import { McpTool } from '@mcp/mcp-tool.js'
import type { McpToolDefinition } from '@mcp/mcp-tool.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

export type ServerStatus = 'connected' | 'failed'

export interface ServerInfo {
  name: string
  status: ServerStatus
  /** 来源配置文件路径 */
  source: string
  toolCount: number
  toolNames: string[]
  /** 连接失败时的错误信息 */
  error?: string
}

interface ConnectedServer {
  name: string
  client: Client
  tools: McpTool[]
}

/** F9: MCP 连接事件，供 SessionLogger 记录 */
export interface McpConnectEvent {
  phase: 'start' | 'end'
  serverName: string
  transport: string    // 'stdio' | 'sse' | 'streamable-http'
  success?: boolean
  toolCount?: number
  durationMs?: number
  error?: string
}

/**
 * MCP Server 连接生命周期管理器。
 * 读取配置 → 连接所有 Server → 收集工具 → 优雅关闭。
 */
export class McpManager {
  readonly #mcpServers: Record<string, McpServerConfig>
  readonly #serverSources: Record<string, string>
  readonly #servers: ConnectedServer[] = []
  /** 所有 server 的状态信息（含失败的），按 connectAll 顺序填充 */
  readonly #allServerInfo: ServerInfo[] = []
  /** F9: 连接事件回调，用于观测日志 */
  onConnect?: (event: McpConnectEvent) => void

  constructor(config: McpConfigWithSources) {
    this.#mcpServers = config.mcpServers
    this.#serverSources = config.serverSources
  }

  /** 连接所有配置的 MCP Server（并行），单个失败不影响其余 */
  async connectAll(): Promise<void> {
    const entries = Object.entries(this.#mcpServers)

    const results = await Promise.allSettled(
      entries.map(async ([serverName, serverConfig]) => {
        const source = this.#serverSources[serverName] ?? 'unknown'
        const transportType = this.#detectTransportType(serverConfig)
        const startTime = Date.now()

        // F9: 连接前通知
        this.onConnect?.({ phase: 'start', serverName, transport: transportType })

        try {
          const client = new Client({ name: 'ccode', version: APP_VERSION })
          const transport = this.#createTransport(serverConfig)

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

          // F9: 连接后通知（成功）
          this.onConnect?.({ phase: 'end', serverName, transport: transportType, success: true, toolCount: tools.length, durationMs: Date.now() - startTime })

          return {
            server: { name: serverName, client, tools } as ConnectedServer,
            info: {
              name: serverName,
              status: 'connected' as ServerStatus,
              source,
              toolCount: tools.length,
              toolNames: tools.map(t => t.name),
            },
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)

          // F9: 连接后通知（失败）
          this.onConnect?.({ phase: 'end', serverName, transport: transportType, success: false, error: message, durationMs: Date.now() - startTime })

          return {
            server: null,
            info: {
              name: serverName,
              status: 'failed' as ServerStatus,
              source,
              toolCount: 0,
              toolNames: [],
              error: message,
            },
          }
        }
      }),
    )

    // 按原始配置顺序收集结果
    for (const result of results) {
      // Promise.allSettled + 内部 try/catch → 永远是 fulfilled
      if (result.status !== 'fulfilled') continue
      const { server, info } = result.value
      if (server) {
        this.#servers.push(server)
      }
      this.#allServerInfo.push(info)
    }
  }

  /** 返回所有已连接 Server 的工具列表 */
  getTools(): McpTool[] {
    return this.#servers.flatMap((s) => s.tools)
  }

  /** 获取所有 Server 的状态摘要（含连接失败的） */
  getStatus(): ServerInfo[] {
    return [...this.#allServerInfo]
  }

  /** 断开所有连接，忽略单个关闭错误 */
  async disconnectAll(): Promise<void> {
    for (const server of this.#servers) {
      try {
        await server.client.close()
      } catch {
        // 静默忽略关闭错误
      }
    }
    this.#servers.length = 0
  }

  /** 检测 transport 类型（用于观测日志） */
  #detectTransportType(config: McpServerConfig): string {
    if (config.command) return 'stdio'
    if (config.type === 'sse') return 'sse'
    return 'streamable-http'
  }

  /** 根据 ServerConfig 创建对应的 Transport */
  #createTransport(config: McpServerConfig): Transport {
    // Stdio: command 存在
    if (config.command) {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries({ ...process.env, ...config.env })) {
        if (v !== undefined) env[k] = v
      }
      return new StdioClientTransport({
        command: config.command,
        ...(config.args !== undefined ? { args: config.args } : {}),
        env,
        // 抑制子进程 stderr 输出，防止 Python INFO 等日志泄漏到终端
        stderr: 'pipe',
      })
    }

    // SSE: 显式指定 type=sse 且有 url
    if (config.type === 'sse' && config.url) {
      return new SSEClientTransport(new URL(config.url))
    }

    // Streamable HTTP / HTTP: type=streamable-http 或 type=http（.claude.json 格式）
    if ((config.type === 'streamable-http' || config.type === 'http') && config.url) {
      const requestInit: RequestInit = {}
      if (config.headers) {
        requestInit.headers = config.headers
      }
      // as Transport: exactOptionalPropertyTypes 导致 sessionId 类型不兼容
      return new StreamableHTTPClientTransport(new URL(config.url), { requestInit }) as Transport
    }

    // 有 url 但未指定 type → 默认 StreamableHTTP
    if (config.url) {
      const requestInit: RequestInit = {}
      if (config.headers) {
        requestInit.headers = config.headers
      }
      // as Transport: exactOptionalPropertyTypes 导致 sessionId 类型不兼容
      return new StreamableHTTPClientTransport(new URL(config.url), { requestInit }) as Transport
    }

    throw new Error('Cannot determine transport: need either "command" or "url" in server config')
  }
}
