// src/commands/registry.ts

/**
 * CommandRegistry — 指令注册与分发中心。
 *
 * 以 name 和 aliases 为键将指令存入 Map，dispatch() 负责解析
 * "/" 前缀输入并路由到对应指令实例。
 */

import type { Command, CommandResult } from './types.js'

/**
 * 指令注册表。
 * 支持按名称或别名查找，getAll() 自动去重返回唯一指令列表。
 */
export class CommandRegistry {
  /** name/alias → Command 的映射，同一 Command 可能对应多个键 */
  private readonly commands = new Map<string, Command>()

  /**
   * 注册一条指令。同时以 name 和所有 aliases 为键写入 Map，
   * 使得 dispatch("/m") 和 dispatch("/model") 都能找到同一实例。
   */
  register(cmd: Command): void {
    this.commands.set(cmd.name, cmd)
    for (const alias of cmd.aliases ?? []) {
      this.commands.set(alias, cmd)
    }
  }

  /**
   * 返回所有已注册的唯一指令（别名不产生重复项）。
   * 用于 /help 生成帮助文本和 CommandSuggestion 显示候选列表。
   */
  getAll(): Command[] {
    const seen = new Set<string>()
    return Array.from(this.commands.values()).filter(cmd => {
      if (seen.has(cmd.name)) return false
      seen.add(cmd.name)
      return true
    })
  }

  /**
   * 解析并分发斜杠指令输入。
   *
   * 解析规则：
   * - 非 "/" 开头 → { handled: false }（交由 LLM 处理）
   * - "/" 或 "/  " → { handled: false }（空指令视为普通输入）
   * - "/unknown" → { handled: true, action: { type: 'error' } }
   * - "/clear arg1 arg2" → ClearCommand.execute(['arg1', 'arg2'])
   */
  dispatch(input: string): CommandResult {
    if (!input.startsWith('/')) return { handled: false }

    const trimmed = input.slice(1).trim()
    // 纯斜线或斜线加空格：不触发指令，让用户继续输入
    if (!trimmed) return { handled: false }
    const parts = trimmed.split(/\s+/)
    const name = parts[0] ?? ''
    const args = parts.slice(1)

    const cmd = this.commands.get(name)
    if (!cmd) {
      return {
        handled: true,
        action: { type: 'error', message: `Unknown command: /${name}. Type /help for available commands.` },
      }
    }

    return cmd.execute(args)
  }
}
