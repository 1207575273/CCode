// src/memory/tools/memory-delete-tool.ts

/**
 * memory_delete 工具 — LLM 调用删除记忆。
 *
 * 支持按 id 精确删除，或按标题模糊匹配删除。
 */

import type { Tool, ToolContext, ToolResult } from '@tools/core/types.js'
import type { MemoryManager } from '@memory/core/memory-manager.js'

export class MemoryDeleteTool implements Tool {
  readonly name = 'memory_delete'
  readonly dangerous = false
  readonly description = '从记忆系统中删除指定记忆。可通过 id 精确删除，或通过 title 模糊匹配删除。删除前建议先用 memory_search 确认目标。'
  readonly parameters = {
    type: 'object',
    properties: {
      id: { type: 'string', description: '记忆 ID（如 "global:胜总是谁" 或 "project:insights/认证中间件重构"），精确匹配' },
      title: { type: 'string', description: '记忆标题关键词，模糊匹配（当 id 不确定时使用）' },
    },
  }

  private readonly getManager: () => MemoryManager | null

  // 惰性获取 manager:解耦「工具注册时序」与「记忆系统初始化时序」。
  // 注册时 manager 可能尚未就绪(启动竞态),execute 时(对话期)再取,届时必已初始化。
  constructor(getManager: () => MemoryManager | null) {
    this.getManager = getManager
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const manager = this.getManager()
    if (!manager) {
      return { success: false, output: '', error: '记忆系统尚未就绪（初始化中或未启用），请稍后重试' }
    }

    const id = String(args['id'] ?? '').trim()
    const title = String(args['title'] ?? '').trim()

    if (!id && !title) {
      return { success: false, output: '', error: '需要提供 id 或 title 参数' }
    }

    try {
      // 按 id 精确删除
      if (id) {
        const entries = await manager.list('all')
        const target = entries.find(e => e.id === id)
        if (!target) {
          return { success: false, output: '', error: `未找到 id="${id}" 的记忆` }
        }
        await manager.delete(id)
        return {
          success: true,
          output: `已删除记忆: "${target.title}" (${target.scope}/${target.type})`,
        }
      }

      // 按 title 模糊匹配
      const entries = await manager.list('all')
      const keyword = title.toLowerCase()
      const matches = entries.filter(e => e.title.toLowerCase().includes(keyword))

      if (matches.length === 0) {
        return { success: false, output: '', error: `未找到标题包含 "${title}" 的记忆` }
      }

      if (matches.length > 1) {
        const list = matches.map(e => `  - ${e.id}: "${e.title}" (${e.scope})`).join('\n')
        return {
          success: false,
          output: '',
          error: `匹配到 ${matches.length} 条记忆，请用 id 精确指定:\n${list}`,
        }
      }

      // 唯一匹配，直接删除
      const target = matches[0]!
      await manager.delete(target.id)
      return {
        success: true,
        output: `已删除记忆: "${target.title}" (${target.scope}/${target.type})`,
      }
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
