// src/commands/model.ts
import type { Command, CommandResult } from '@commands/types.js'

export class ModelCommand implements Command {
  readonly name = 'model'
  readonly aliases = ['m'] as const
  readonly description = 'Switch AI model (/model <name> | /model info)'

  constructor(
    private readonly currentProvider: string,
    private readonly currentModel: string,
  ) {}

  execute(args: string[]): CommandResult {
    // /model — no args → open interactive picker
    if (args.length === 0) {
      return { handled: true, action: { type: 'show_model_picker' } }
    }

    // /model info → show current model info as system message
    if (args[0] === 'info') {
      const content = `Current model: ${this.currentModel} (${this.currentProvider})`
      return { handled: true, action: { type: 'show_help', content } }
    }

    // /model <name> → direct switch; provider resolution is delegated to App.tsx
    // which has access to the full config and can scan providers for the model name.
    // Use a local variable to satisfy noUncheckedIndexedAccess — length check above
    // guarantees args[0] is defined, but TS cannot narrow array element types.
    const modelName = args[0] ?? ''
    return {
      handled: true,
      action: { type: 'switch_model', provider: '', model: modelName },
    }
  }
}
