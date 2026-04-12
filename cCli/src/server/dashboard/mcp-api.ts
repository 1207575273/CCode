// src/server/dashboard/mcp-api.ts

/**
 * MCP Server 管理 API
 *
 * GET  /api/mcp/servers      — 已配置的 MCP Server 列表（合并多层来源）
 * POST /api/mcp/servers/add  — 添加 MCP Server（写入 ~/.ccode/.mcp.json）
 * POST /api/mcp/servers/delete — 删除 MCP Server
 */

import { Hono } from 'hono'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { dbg } from '../../debug.js'

/** MCP 配置文件搜索路径（按优先级从高到低） */
const MCP_CONFIG_PATHS = [
  { path: () => join(homedir(), '.ccode', '.mcp.json'), label: '~/.ccode/.mcp.json', writable: true },
  { path: () => join(homedir(), '.claude.json'), label: '~/.claude.json', writable: false },
  { path: () => join(homedir(), '.mcp.json'), label: '~/.mcp.json', writable: false },
]

interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: string
  url?: string
  headers?: Record<string, string>
}

interface McpServerInfo {
  name: string
  config: McpServerConfig
  source: string
  writable: boolean
}

export function createMcpRoutes(): Hono {
  const api = new Hono()

  // ═══ MCP Server 列表 ═══
  api.get('/servers', (c) => {
    try {
      const servers = loadAllMcpServers()
      return c.json({ servers })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ═══ 添加 MCP Server ═══
  api.post('/servers/add', async (c) => {
    try {
      const body = await c.req.json() as { name: string; config: McpServerConfig }
      const ccodeMcpPath = MCP_CONFIG_PATHS[0]!.path()

      // 读取现有配置
      let data: { mcpServers: Record<string, McpServerConfig> } = { mcpServers: {} }
      if (existsSync(ccodeMcpPath)) {
        data = JSON.parse(readFileSync(ccodeMcpPath, 'utf-8'))
      }

      if (data.mcpServers[body.name]) {
        return c.json({ error: `MCP Server "${body.name}" 已存在` }, 400)
      }

      data.mcpServers[body.name] = body.config
      mkdirSync(join(homedir(), '.ccode'), { recursive: true })
      writeFileSync(ccodeMcpPath, JSON.stringify(data, null, 2), 'utf-8')

      return c.json({ success: true })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ═══ 删除 MCP Server ═══
  api.post('/servers/delete', async (c) => {
    try {
      const body = await c.req.json() as { name: string }
      const ccodeMcpPath = MCP_CONFIG_PATHS[0]!.path()

      if (!existsSync(ccodeMcpPath)) {
        return c.json({ error: '~/.ccode/.mcp.json 不存在' }, 400)
      }

      const data = JSON.parse(readFileSync(ccodeMcpPath, 'utf-8'))
      if (!data.mcpServers?.[body.name]) {
        return c.json({ error: `只能删除 ~/.ccode/.mcp.json 中的 Server（其他来源的配置请手动编辑）` }, 400)
      }

      delete data.mcpServers[body.name]
      writeFileSync(ccodeMcpPath, JSON.stringify(data, null, 2), 'utf-8')

      return c.json({ success: true })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  return api
}

/** 加载所有 MCP 配置源，合并去重 */
function loadAllMcpServers(): McpServerInfo[] {
  const servers: McpServerInfo[] = []
  const seen = new Set<string>()

  for (const source of MCP_CONFIG_PATHS) {
    const filePath = source.path()
    if (!existsSync(filePath)) continue

    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      const mcpServers = data.mcpServers ?? {}

      for (const [name, config] of Object.entries(mcpServers)) {
        if (seen.has(name)) continue // 高优先级已覆盖
        seen.add(name)
        servers.push({
          name,
          config: config as McpServerConfig,
          source: source.label,
          writable: source.writable,
        })
      }
    } catch (err) {
      dbg(`[McpAPI] MCP 配置解析失败 source=${source.label}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  return servers
}
