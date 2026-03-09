// src/tools/bash.ts
import { execa, ExecaError } from 'execa'
import { resolveShell } from '@platform/shell-resolver.js'
import type { Tool, ToolContext, ToolResult } from './types.js'

const TIMEOUT_MS = 30_000

export class BashTool implements Tool {
  readonly name = 'bash'
  readonly dangerous = true
  readonly description = '执行 Shell 命令。Windows 上优先使用 Git Bash，找不到则用 PowerShell。'
  readonly parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      cwd: { type: 'string', description: '工作目录，默认为当前目录' },
    },
    required: ['command'],
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = String(args['command'] ?? '')
    const cwd = String(args['cwd'] ?? ctx.cwd)
    const shell = resolveShell()

    try {
      const { stdout, stderr } = await execa(shell.path, [...shell.args, command], {
        cwd,
        timeout: TIMEOUT_MS,
        reject: true,
      })
      const output = [stdout, stderr].filter(Boolean).join('\n')
      return { success: true, output: output || '(no output)' }
    } catch (err: unknown) {
      if (err instanceof ExecaError) {
        const output = [err.stdout, err.stderr].filter(Boolean).join('\n')
        return { success: false, output: output || '', error: err.message }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, output: '', error: message }
    }
  }
}
