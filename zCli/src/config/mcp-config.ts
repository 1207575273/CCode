// src/config/mcp-config.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: 'stdio' | 'sse' | 'streamable-http' | 'http'
  url?: string
  /** HTTP 传输的自定义请求头（如 Authorization），兼容 .claude.json 格式 */
  headers?: Record<string, string>
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
}

/**
 * MCP 配置文件搜索路径（按优先级从高到低）：
 * 1. ~/.ccode/mcp.json   — ZCli 专属配置，优先级最高
 * 2. ~/.claude.json      — Claude Code 用户配置（含 mcpServers 字段）
 * 3. ~/.mcp.json         — 用户全局配置（通用 MCP 配置格式）
 *
 * 同名 server 出现在多个文件时，高优先级文件覆盖低优先级。
 */
export const MCP_CONFIG_PATHS = [
  join(homedir(), '.ccode', '.mcp.json'),
  join(homedir(), '.claude.json'),
  join(homedir(), '.mcp.json'),
]

/** 从单个文件读取 MCP 配置，失败返回 null */
function loadSingleConfig(configPath: string): McpConfig | null {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('mcpServers' in parsed) ||
    typeof (parsed as Record<string, unknown>)['mcpServers'] !== 'object'
  ) {
    return null
  }

  return parsed as McpConfig
}

/**
 * 加载并合并 MCP 配置。
 * 按 MCP_CONFIG_PATHS 顺序扫描，高优先级文件的同名 server 覆盖低优先级。
 * 也可传入自定义路径列表（测试用）。
 */
export function loadMcpConfig(configPaths: string[] = MCP_CONFIG_PATHS): McpConfig {
  const merged: Record<string, McpServerConfig> = {}

  // 从低优先级到高优先级遍历，后写入的覆盖先写入的
  for (let i = configPaths.length - 1; i >= 0; i--) {
    const config = loadSingleConfig(configPaths[i]!)
    if (config != null) {
      Object.assign(merged, config.mcpServers)
    }
  }

  return { mcpServers: merged }
}

/** 带来源信息的加载结果 */
export interface McpConfigWithSources {
  mcpServers: Record<string, McpServerConfig>
  /** server name → 来源配置文件路径 */
  serverSources: Record<string, string>
}

/**
 * 加载并合并 MCP 配置，同时追踪每个 server 的来源文件。
 * 高优先级文件的同名 server 覆盖低优先级。
 */
export function loadMcpConfigWithSources(configPaths: string[] = MCP_CONFIG_PATHS): McpConfigWithSources {
  const merged: Record<string, McpServerConfig> = {}
  const serverSources: Record<string, string> = {}

  // 从低优先级到高优先级遍历，后写入的覆盖先写入的
  for (let i = configPaths.length - 1; i >= 0; i--) {
    const filePath = configPaths[i]!
    const config = loadSingleConfig(filePath)
    if (config != null) {
      for (const serverName of Object.keys(config.mcpServers)) {
        merged[serverName] = config.mcpServers[serverName]!
        serverSources[serverName] = filePath
      }
    }
  }

  return { mcpServers: merged, serverSources }
}
