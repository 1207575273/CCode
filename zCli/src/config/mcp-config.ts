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

const EMPTY_CONFIG: McpConfig = { mcpServers: {} }

export const DEFAULT_MCP_CONFIG_PATH = join(homedir(), '.zcli', 'mcp.json')

export function loadMcpConfig(configPath: string = DEFAULT_MCP_CONFIG_PATH): McpConfig {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch {
    return { ...EMPTY_CONFIG }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...EMPTY_CONFIG }
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('mcpServers' in parsed) ||
    typeof (parsed as Record<string, unknown>)['mcpServers'] !== 'object'
  ) {
    return { ...EMPTY_CONFIG }
  }

  return parsed as McpConfig
}
