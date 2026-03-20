// src/commands/compact.ts

/**
 * /compact 指令 — 压缩对话上下文。
 *
 * 用法：
 *   /compact                    — 使用默认策略压缩
 *   /compact <focus>            — 压缩时聚焦特定方面
 *   /compact --strategy <name>  — 使用指定策略
 */

import type { Command, CommandResult } from '@commands/types.js'

export class CompactCommand implements Command {
  readonly name = 'compact'
  readonly description = 'Compact conversation context to free up space'

  execute(args: string[]): CommandResult {
    // 解析 --strategy 参数
    let strategy: string | undefined
    let focus: string | undefined
    const remaining: string[] = []

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--strategy' && args[i + 1]) {
        strategy = args[++i]
      } else {
        remaining.push(args[i]!)
      }
    }

    if (remaining.length > 0) {
      focus = remaining.join(' ')
    }

    return {
      handled: true,
      action: { type: 'run_compact', strategy, focus },
    }
  }
}
