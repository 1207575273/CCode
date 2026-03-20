// src/hooks/types.ts

/** Hook 事件类型 */
export type HookEventType = 'SessionStart' | 'PreToolUse' | 'PostToolUse'

/** hooks.json 中的单个 hook 动作 */
export interface HookAction {
  type: 'command'
  command: string
  timeout?: number // 毫秒，默认 10000
}

/** hooks.json 中的一组 hook 规则 */
export interface HookRule {
  matcher: string // 正则表达式字符串
  hooks: HookAction[]
}

/** hooks.json 的完整结构 */
export interface HooksConfig {
  hooks: Partial<Record<HookEventType, HookRule[]>>
}

/** 已解析的 hook 条目（内部使用） */
export interface ResolvedHookEntry {
  source: 'plugin' | 'project' | 'user'
  pluginName?: string
  event: HookEventType
  matcher: RegExp
  action: HookAction
  /** hook 脚本的工作目录（hooks.json 所在目录） */
  cwd: string
}

/** Hook 执行上下文 */
export interface HookContext {
  trigger: string
  env?: Record<string, string>
  stdin?: string
}

/** SessionStart hook 返回 */
export interface SessionStartHookResult {
  additionalContext?: string
  userMessage?: string
}

/** PreToolUse hook 返回 */
export interface PreToolUseHookResult {
  decision: 'allow' | 'block' | 'modify'
  reason?: string
  modifiedArgs?: Record<string, unknown>
}

/** PostToolUse hook 返回 */
export interface PostToolUseHookResult {
  additionalContext?: string
  userMessage?: string
}
