// src/commands/fork.ts

import type { Command, CommandResult } from '@commands/types.js'

/** /fork 指令 — 从当前对话中选择分叉点 */
export class ForkCommand implements Command {
  readonly name = 'fork'
  readonly description = 'Fork conversation from a specific point'

  execute(_args: string[]): CommandResult {
    return { handled: true, action: { type: 'show_fork_panel' } }
  }
}
