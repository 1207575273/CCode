// src/commands/help.ts
import type { Command, CommandResult } from '@commands/types.js'

export class HelpCommand implements Command {
  readonly name = 'help'
  readonly description = 'Show available commands'

  constructor(private readonly getCommands: () => Command[]) {}

  execute(_args: string[]): CommandResult {
    const lines = ['Available commands:']
    for (const cmd of this.getCommands()) {
      const aliases = cmd.aliases?.length ? ` (${cmd.aliases.join(', ')})` : ''
      lines.push(`  /${cmd.name}${aliases}  ${cmd.description}`)
    }
    return {
      handled: true,
      action: { type: 'show_help', content: lines.join('\n') },
    }
  }
}
