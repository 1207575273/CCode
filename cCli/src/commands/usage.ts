// src/commands/usage.ts

/**
 * /usage 指令 — 展示当前会话、今日、本月的 Token 消耗和费用统计。
 */

import type { Command, CommandResult } from './types.js'

export class UsageCommand implements Command {
  readonly name = 'usage'
  readonly aliases = ['cost'] as const
  readonly description = '显示 Token 消耗和费用统计'

  execute(_args: string[]): CommandResult {
    return { handled: true, action: { type: 'show_usage' } }
  }
}
