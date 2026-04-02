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

  private manager: MemoryManager

  constructor(manager: MemoryManager) {
    this.manager = manager
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const query = String(args['query'] ?? '')
    if (!query.trim()) {
      return { success: false, output: '', error: '查询不能为空' }
    }

    const scope = args['scope'] as MemoryScope | 'all' | undefined
    const tags = Array.isArray(args['tags']) ? (args['tags'] as string[]) : undefined
    const type = args['type'] as MemoryType | undefined
    const topK = typeof args['topK'] === 'number' ? args['topK'] : 5

    try {
      const results = await this.manager.search({
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
