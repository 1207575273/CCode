// src/memory/tools/memory-search-tool.ts

/**
 * memory_search 工具 — LLM 调用检索记忆。
 *
 * 设计文档：§4.1
 */

import type { Tool, ToolContext, ToolResult } from '@tools/core/types.js'
import type { MemoryManager } from '@memory/core/memory-manager.js'
import type { MemoryType, MemoryScope } from '@memory/types.js'

export class MemorySearchTool implements Tool {
  readonly name = 'memory_search'
  readonly dangerous = false
  readonly description = '从记忆系统中检索相关信息。用于回忆之前的工作、偏好、决策、项目约定等。'
  readonly parameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索查询，自然语言描述' },
      scope: { type: 'string', enum: ['global', 'project', 'all'], description: '搜索范围，默认 all' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签过滤' },
      type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference', 'session-summary'], description: '按类型过滤' },
      topK: { type: 'number', description: '返回条数，默认 5' },
    },
    required: ['query'],
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

    const query = String(args['query'] ?? '')
    if (!query.trim()) {
      return { success: false, output: '', error: '查询不能为空' }
    }

    const scope = args['scope'] as MemoryScope | 'all' | undefined
    const tags = Array.isArray(args['tags']) ? (args['tags'] as string[]) : undefined
    const type = args['type'] as MemoryType | undefined
    const topK = typeof args['topK'] === 'number' ? args['topK'] : 5

    try {
      const results = await manager.search({
        query: query.trim(),
        ...(scope !== undefined ? { scope } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(type !== undefined ? { type } : {}),
        topK,
      })

      if (results.length === 0) {
        return { success: true, output: '未找到相关记忆。' }
      }

      const lines = results.map((r, i) => {
        const entry = r.entry
        return [
          `[${i + 1}] **${entry.title}** (score: ${r.score.toFixed(2)})`,
          `    范围: ${entry.scope} | 类型: ${entry.type} | 标签: [${entry.tags.join(', ')}]`,
          `    更新: ${entry.updated}`,
          `    摘要: ${r.snippet}`,
          `    文件: ${entry.filePath}`,
        ].join('\n')
      })

      return {
        success: true,
        output: `找到 ${results.length} 条相关记忆：\n\n${lines.join('\n\n')}`,
      }
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
