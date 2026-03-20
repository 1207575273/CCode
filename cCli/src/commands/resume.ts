// src/commands/resume.ts

import type { Command, CommandResult } from '@commands/types.js'

/** /resume 指令 — 显示会话恢复面板 */
export class ResumeCommand implements Command {
  readonly name = 'resume'
  readonly description = 'Resume a previous session'

  execute(_args: string[]): CommandResult {
    return { handled: true, action: { type: 'show_resume_panel' } }
  }
}
