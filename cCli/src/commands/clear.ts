// src/commands/clear.ts

/**
 * /clear 指令 — 清空当前会话消息列表。
 *
 * 不接受参数，执行后返回 clear_messages action，
 * 由 App.tsx 调用 useChat.clearMessages() 清空消息。
 */

import type { Command, CommandResult } from '@commands/types.js'

/** 清空会话历史的指令实现。 */
export class ClearCommand implements Command {
  readonly name = 'clear'
  readonly description = 'Clear current conversation'

  /** 忽略所有参数，始终返回 clear_messages action。 */
  execute(_args: string[]): CommandResult {
    return { handled: true, action: { type: 'clear_messages' } }
  }
}
