// src/commands/types.ts

export type CommandAction =
  | { type: 'clear_messages' }
  | { type: 'show_help'; content: string }
  | { type: 'show_model_picker' }
  | { type: 'switch_model'; provider: string; model: string }
  | { type: 'error'; message: string }

export interface CommandResult {
  handled: boolean
  action?: CommandAction
}

export interface Command {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
  execute(args: string[]): CommandResult
}
