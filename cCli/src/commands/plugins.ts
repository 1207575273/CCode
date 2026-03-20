// src/commands/plugins.ts

/**
 * /plugins 指令 — 列出已加载的 Runtime Plugin。
 */

import type { Command, CommandResult } from '@commands/types.js'

export class PluginsCommand implements Command {
  readonly name = 'plugins'
  readonly description = 'List loaded runtime plugins'

  execute(_args: string[]): CommandResult {
    return {
      handled: true,
      action: { type: 'list_plugins' },
    }
  }
}
