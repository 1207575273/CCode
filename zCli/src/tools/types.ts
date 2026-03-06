// src/tools/types.ts

export interface ToolContext {
  cwd: string
  signal?: AbortSignal
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
}

export interface Tool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>  // JSON Schema
  readonly dangerous?: boolean

  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}
