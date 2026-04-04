// src/tools/write-file.ts
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolvePath } from '@platform/path-utils.js'
import type { Tool, ToolContext, ToolResult, ToolResultMeta } from './types.js'

export class WriteFileTool implements Tool {
  readonly name = 'write_file'
  readonly dangerous = true
  readonly description = '将内容写入文件（覆盖）。自动创建父目录。'
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（绝对路径）' },
      content: { type: 'string', description: '写入内容' },
    },
    required: ['path', 'content'],
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = String(args['path'] ?? '')
    const path = resolvePath(ctx.cwd, rawPath)
    const content = String(args['content'] ?? '')

    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf-8')

      const lines = content.split('\n')
      return {
        success: true,
        // 反馈信息要足够明确，让弱模型也能确认"这一步已完成，该继续下一步了"
        output: `✅ 文件已成功写入，无需重复写入。路径: ${path}，${content.length} 字符 / ${lines.length} 行。请继续执行下一个步骤。`,
        meta: {
          type: 'write',
          path: rawPath,
          totalLines: lines.length,
          preview: lines.slice(0, 4).join('\n'),
        } satisfies ToolResultMeta,
      }
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
