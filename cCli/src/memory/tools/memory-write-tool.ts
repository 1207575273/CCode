// src/memory/tools/memory-write-tool.ts

/**
 * memory_write 工具 — LLM 调用写入/更新记忆。
 *
 * 设计文档：§4.1
 */

import type { Tool, ToolContext, ToolResult } from '@tools/core/types.js'
import type { MemoryManager } from '@memory/core/memory-manager.js'
import type { MemoryType, MemorySource } from '@memory/types.js'

const VALID_TYPES = new Set(['user', 'feedback', 'project', 'reference'])
const VALID_SCOPES = new Set(['global', 'project'])

export class MemoryWriteTool implements Tool {
  readonly name = 'memory_write'
  readonly dangerous = false
  readonly description = '将重要信息保存到记忆系统，跨会话持久保留。用于记录用户偏好、项目决策、技术发现等。'
  readonly parameters = {
    type: 'object',
    properties: {
      title: { type: 'string', description: '记忆标题，简洁描述主题' },
      content: { type: 'string', description: '记忆内容，Markdown 格式' },
      type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: '记忆类型' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，用于分类过滤' },
      scope: { type: 'string', enum: ['global', 'project'], description: '记忆范围，默认 project' },
    },
    required: ['title', 'content', 'type'],
  }

  private manager: MemoryManager

  constructor(manager: MemoryManager) {
    this.manager = manager
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const title = String(args['title'] ?? '')
    const content = String(args['content'] ?? '')
    const type = String(args['type'] ?? 'project')
    const tags = Array.isArray(args['tags']) ? (args['tags'] as string[]) : []
    const scope = String(args['scope'] ?? 'project')

    if (!title.trim()) {
      return { success: false, output: '', error: '标题不能为空' }
    }
    if (!content.trim()) {
      return { success: false, output: '', error: '内容不能为空' }
    }
    if (!VALID_TYPES.has(type)) {
      return { success: false, output: '', error: `无效的类型: ${type}，可选: ${[...VALID_TYPES].join(', ')}` }
    }
    if (!VALID_SCOPES.has(scope)) {
      return { success: false, output: '', error: `无效的范围: ${scope}，可选: global, project` }
    }

    try {
      const entry = await this.manager.write({
        scope: scope as 'global' | 'project',
        title: title.trim(),
        content: content.trim(),
        type: type as MemoryType,
        tags,
        source: 'agent' as MemorySource,
        filePath: '',
      })

      return {
        success: true,
        output: `记忆已保存: "${entry.title}" (${entry.scope}/${entry.type}, tags: [${entry.tags.join(', ')}])\n文件: ${entry.filePath}`,
      }
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
