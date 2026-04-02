// src/commands/remember.ts

/**
 * /remember 命令 — 用户主动管理记忆的快捷入口。
 *
 * 用法：
 *   /remember <content>           — 快速写入记忆（content 作为正文）
 *   /remember list [scope]        — 列出记忆（可选 global/project）
 *   /remember search <query>      — 搜索记忆
 *   /remember delete <id>         — 删除记忆
 *   /remember rebuild             — 重建向量索引
 */

import type { Command, CommandResult } from './types.js'

export class RememberCommand implements Command {
  readonly name = 'remember'
  readonly aliases = ['mem', 'memory'] as const
  readonly description = '管理记忆（list/search/delete/rebuild 或直接输入内容写入）'

  execute(args: string[]): CommandResult {
    if (args.length === 0) {
      return {
        handled: true,
        action: {
          type: 'error',
          message: '用法: /remember <content> | /remember list [scope] | /remember search <query> | /remember delete <id> | /remember rebuild',
        },
      }
    }

    const sub = args[0]!

    switch (sub) {
      case 'list': {
        const scope = args[1]
        return { handled: true, action: scope ? { type: 'memory_list', scope } : { type: 'memory_list' } }
      }

      case 'search': {
        const query = args.slice(1).join(' ')
        if (!query) {
          return { handled: true, action: { type: 'error', message: '/remember search 需要查询内容' } }
        }
        return { handled: true, action: { type: 'memory_search', query } }
      }

      case 'delete': {
        const id = args[1]
        if (!id) {
          return { handled: true, action: { type: 'error', message: '/remember delete 需要记忆 ID（使用 /remember list 查看）' } }
        }
        return { handled: true, action: { type: 'memory_delete', id } }
      }

      case 'rebuild':
        return { handled: true, action: { type: 'memory_rebuild' } }

      default: {
        // 不是子命令 → 整行作为记忆内容写入
        const content = args.join(' ')
        return { handled: true, action: { type: 'memory_write', content } }
      }
    }
  }
}
