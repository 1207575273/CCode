// src/config/permissions.ts

/**
 * 项目级权限管理 — 读取 .ccode/settings.local.json 的 permissions.allow 白名单，
 * 判断工具调用是否预授权（免确认直接执行）。
 *
 * 规则格式：
 *   - "Bash(*)"                → 友好名匹配：在注册工具中查找以 "bash" 开头的工具名
 *   - "Read(*)"                → 匹配 read_file（"read" 前缀命中）
 *   - "mcp__*"                 → 前缀通配符：匹配所有 MCP 工具
 *   - "mcp__server__tool"      → 精确匹配特定 MCP 工具
 *   - "bash"                   → 精确匹配内部工具名
 *
 * 友好名解析规则：提取 "FriendlyName(*)" 中的名称，转小写后，
 * 在已注册工具列表中查找 name === 小写名 或 name.startsWith(小写名 + "_") 的工具。
 * 这样 "Read" 能匹配 "read_file"，"Bash" 能匹配 "bash"，无需硬编码映射表。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

interface LocalSettings {
  permissions?: {
    allow?: string[]
  }
}

/**
 * 将友好名（如 "Read"）解析为实际工具名。
 * 在 registeredTools 中查找：精确匹配 或 前缀+下划线匹配。
 */
function resolveFriendlyName(friendly: string, registeredTools: string[]): string | null {
  const lower = friendly.toLowerCase()
  // 精确匹配：bash → bash
  if (registeredTools.includes(lower)) return lower
  // 前缀匹配：read → read_file, edit → edit_file
  const prefixMatch = registeredTools.find(name => name.startsWith(lower + '_'))
  return prefixMatch ?? null
}

/**
 * 解析单条规则为匹配函数。
 */
function parseRule(rule: string, registeredTools: string[]): ((toolName: string) => boolean) | null {
  // 格式1: FriendlyName(*) — 如 Bash(*), Read(*)
  const parenMatch = rule.match(/^(\w+)\(\*\)$/)
  if (parenMatch) {
    const resolved = resolveFriendlyName(parenMatch[1]!, registeredTools)
    if (!resolved) return null // 无法解析的友好名，忽略该规则
    return (name) => name === resolved
  }

  // 格式2: 通配符后缀 — 如 mcp__*
  if (rule.endsWith('*')) {
    const prefix = rule.slice(0, -1)
    return (name) => name.startsWith(prefix)
  }

  // 格式3: 精确匹配（内部工具名）
  return (name) => name === rule
}

export class PermissionManager {
  readonly #matchers: Array<(toolName: string) => boolean>

  constructor(rules: string[], registeredTools: string[] = []) {
    this.#matchers = rules
      .map(r => parseRule(r, registeredTools))
      .filter((m): m is NonNullable<typeof m> => m !== null)
  }

  /** 判断工具是否在白名单中（预授权，跳过确认） */
  isAllowed(toolName: string): boolean {
    return this.#matchers.some(match => match(toolName))
  }

  /**
   * 从项目目录加载 settings.local.json，构建 PermissionManager。
   * @param registeredTools 当前已注册的工具名列表，用于解析友好名
   */
  static fromProjectDir(projectDir: string = process.cwd(), registeredTools: string[] = []): PermissionManager {
    const settingsPath = join(projectDir, '.ccode', 'settings.local.json')

    if (!existsSync(settingsPath)) {
      return new PermissionManager([], registeredTools)
    }

    try {
      const raw = readFileSync(settingsPath, 'utf-8')
      const settings = JSON.parse(raw) as LocalSettings
      const rules = settings.permissions?.allow ?? []
      return new PermissionManager(rules, registeredTools)
    } catch {
      return new PermissionManager([], registeredTools)
    }
  }
}
