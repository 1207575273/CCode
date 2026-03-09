// src/config/mcp-config.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: 'stdio' | 'sse' | 'streamable-http'
  url?: string
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
}

/**
 * MCP 配置文件搜索路径（按优先级从高到低）：
 * 1. ~/.zcli/mcp.json   — 项目专属配置，优先级最高
 * 2. ~/.mcp.json         — 用户全局配置（兼容 Claude Code 等工具）
 *
 * 同名 server 出现在多个文件时，高优先级文件覆盖低优先级。
 */
export const MCP_CONFIG_PATHS = [
  join(homedir(), '.zcli', 'mcp.json'),
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
