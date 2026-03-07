// src/commands/registry.ts
import type { Command, CommandResult } from './types.js'

export class CommandRegistry {
  private readonly commands = new Map<string, Command>()

  register(cmd: Command): void {
    this.commands.set(cmd.name, cmd)
    for (const alias of cmd.aliases ?? []) {
      this.commands.set(alias, cmd)
    }
  }

  getAll(): Command[] {
    const seen = new Set<string>()
    return Array.from(this.commands.values()).filter(cmd => {
      if (seen.has(cmd.name)) return false
      seen.add(cmd.name)
      return true
    })
  }

  dispatch(input: string): CommandResult {
    if (!input.startsWith('/')) return { handled: false }

    const parts = input.slice(1).trim().split(/\s+/)
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
