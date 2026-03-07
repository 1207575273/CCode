// src/commands/clear.ts
import type { Command, CommandResult } from '@commands/types.js'

export class ClearCommand implements Command {
  readonly name = 'clear'
  readonly description = 'Clear current conversation'

  execute(_args: string[]): CommandResult {
    return { handled: true, action: { type: 'clear_messages' } }
  }
}
