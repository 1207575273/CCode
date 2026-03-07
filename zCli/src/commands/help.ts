// src/commands/help.ts

/**
 * /help 指令 — 动态生成并展示所有已注册指令的帮助文本。
 *
 * 通过构造函数依赖注入 getCommands() 回调，而非直接持有
 * CommandRegistry 引用，避免循环依赖并保持可独立测试。
 */

import type { Command, CommandResult } from '@commands/types.js'

/**
 * 帮助信息生成指令。
 * 每次执行时调用 getCommands() 获取最新指令列表，确保动态注册的指令也能显示。
 */
export class HelpCommand implements Command {
  readonly name = 'help'
  readonly description = 'Show available commands'

  /**
   * @param getCommands 返回全部已注册指令的工厂函数。
   *   调用方通常传入 `() => registry.getAll()`。
   */
  constructor(private readonly getCommands: () => Command[]) {}

  /** 枚举所有指令，生成格式化帮助文本后作为 system 消息展示。 */
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
