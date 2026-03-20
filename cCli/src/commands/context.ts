// src/commands/context.ts

/**
 * /context 指令 — 显示上下文窗口使用情况。
 */

import type { Command, CommandResult } from '@commands/types.js'

export class ContextCommand implements Command {
  readonly name = 'context'
  readonly description = 'Show context window usage'

  execute(_args: string[]): CommandResult {
    return {
      handled: true,
      action: { type: 'show_context' },
    }
  }
}
