// src/commands/types.ts

/**
 * 斜杠指令系统的核心类型定义。
 *
 * CommandAction：指令执行结果的 discriminated union，涵盖所有可能的副作用。
 * CommandResult：指令处理结果，handled=false 表示非指令输入，交由 LLM 处理。
 * Command：所有具体指令类需实现的接口。
 */

/**
 * 指令执行后触发的副作用类型。
 * App.tsx 的 handleSubmit 根据 type 字段分支处理每种行为。
 */
export type CommandAction =
  | { type: 'clear_messages' }
  | { type: 'show_help'; content: string }
  | { type: 'show_model_picker' }
  /** provider 可为空字符串，由 App.tsx 从 config 中解析 */
  | { type: 'switch_model'; provider: string; model: string }
  | { type: 'show_mcp_status' }
  | { type: 'show_resume_panel' }
  | { type: 'show_fork_panel' }
  | { type: 'show_usage' }
  | { type: 'run_gc'; dryRun: boolean; days: number | null; target: 'sessions' | 'usage' | 'all' }
  | { type: 'list_skills' }
  | { type: 'load_skill'; name: string }
  | { type: 'bridge_status' }
  | { type: 'bridge_stop' }
  | { type: 'run_compact'; strategy?: string; focus?: string }
  | { type: 'show_context' }
  | { type: 'error'; message: string }

/**
 * dispatch() 的统一返回格式。
 * handled=false：输入不是斜杠指令，调用方应将其发送给 LLM。
 * handled=true：已被指令系统处理，action 描述具体行为。
 */
export interface CommandResult {
  handled: boolean
  action?: CommandAction
}

/**
 * 所有具体指令类必须实现的接口。
 * name 和 aliases 均用于 CommandRegistry 的路由键。
 */
export interface Command {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
  execute(args: string[]): CommandResult
}
