// src/commands/gc.ts

import type { Command, CommandResult } from './types.js'

export class GcCommand implements Command {
  readonly name = 'gc'
  readonly aliases = ['cleanup'] as const
  readonly description = '清理过期会话文件和用量记录'

  execute(args: string[]): CommandResult {
    let dryRun = false
    let days: number | null = null
    let target: 'sessions' | 'usage' | 'all' = 'all'

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (arg === '--dry-run') {
        dryRun = true
      } else if (arg === '--days' && args[i + 1]) {
        const n = parseInt(args[i + 1]!, 10)
        if (!isNaN(n) && n >= 0) {
          days = n
          i++
        }
      } else if (arg === 'sessions') {
        target = 'sessions'
      } else if (arg === 'usage') {
        target = 'usage'
      }
    }

    return { handled: true, action: { type: 'run_gc', dryRun, days, target } }
  }
}
