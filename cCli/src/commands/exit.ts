// src/commands/exit.ts

/**
 * /exit 指令 — 强制退出 cCli 进程。
 *
 * 别名 /quit。直接调用 process.exit(0) 终止进程，
 * 不等待 Ink 异步卸载（解决某些场景下 exit() 挂起的问题）。
 * ccli.ts 的 process.on('exit') 会确保清理工作仍然执行。
 */

import type { Command, CommandResult } from '@commands/types.js'

export class ExitCommand implements Command {
  readonly name = 'exit'
  readonly aliases = ['quit'] as const
  readonly description = 'Exit the application'

  execute(_args: string[]): CommandResult {
    // 返回专用 action，由 App.tsx 处理强制退出
    return { handled: true, action: { type: 'force_exit' } }
  }
}
