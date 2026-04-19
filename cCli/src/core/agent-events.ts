// src/core/agent-events.ts

/**
 * AgentLoop 事件类型定义 — 按语义拆分为 4 个子 union。
 *
 * 背景(docs/plans/20260420012229_agent-loop重构评审.md P1-01):
 * 重构前所有事件塞在单一 AgentEvent union 里,新增事件类型要穿透主 Agent /
 * dispatch_agent / useChat / SessionLogger / Web Bridge 全栈。拆分后:
 *
 * - 消费者(useChat / SessionLogger / Web Bridge)可以按语义分头订阅
 * - 类型系统能发现每个子类别的缺失分支(exhaustive switch)
 * - 保留 AgentEvent 聚合 union 供 AgentLoop.run() yield 类型使用,对外零破坏
 *
 * AgentEvent = BusinessEvent | ObservabilityEvent | SubagentEvent | PlanningEvent
 */

import type {ToolResultMeta} from '@tools/core/types.js'

// ═══════════════════════════════════════════════
// 公共类型(事件 payload 共享)
// ═══════════════════════════════════════════════

/** AskUserQuestion 工具 — 单个问题定义 */
export interface UserQuestion {
    /** 答案字段名,如 "domain", "focus" */
    key: string
    /** 问题标题 */
    title: string
    /** 问题类型 */
    type: 'select' | 'multiselect' | 'text'
    /** select/multiselect 时的选项列表 */
    options?: UserQuestionOption[]
    /** text 类型的输入提示 */
    placeholder?: string
}

export interface UserQuestionOption {
    label: string
    description?: string
}

/** AskUserQuestion 工具 — 用户回答结果 */
export interface UserQuestionResult {
    cancelled: boolean
    answers?: Record<string, string | string[]>
}

// ═══════════════════════════════════════════════
// 业务事件 — UI 直接消费
// ═══════════════════════════════════════════════

export type BusinessEvent =
    | { type: 'text'; text: string }
    | { type: 'thinking'; text: string }
    | { type: 'tool_start'; toolName: string; toolCallId: string; args: Record<string, unknown> }
    | {
    type: 'tool_done';
    toolName: string;
    toolCallId: string;
    durationMs: number;
    success: boolean;
    resultSummary?: string;
    resultFull?: string;
    meta?: ToolResultMeta
}
    | { type: 'permission_request'; toolName: string; args: Record<string, unknown>; resolve: (allow: boolean) => void }
    | { type: 'user_question_request'; questions: UserQuestion[]; resolve: (result: UserQuestionResult) => void }
    | { type: 'error'; error: string }
    | { type: 'done'; reason?: 'complete' | 'max_turns' | 'aborted' | 'stopped' }

// ═══════════════════════════════════════════════
// 观测事件 — SessionLogger 写入 JSONL
// ═══════════════════════════════════════════════

export type ObservabilityEvent =
    | { type: 'llm_start'; provider: string; model: string; messageCount: number; systemPrompt?: string }
    | {
    type: 'llm_done';
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    stopReason: string;
    ttftMs: number;
    e2eMs: number;
    tps: number
}
    | { type: 'llm_error'; error: string; partialOutputTokens?: number }
    | { type: 'tool_fallback'; toolName: string; fromLevel: string; toLevel: string; reason: string }
    | { type: 'post_tool_feedback'; toolName: string; toolCallId: string; feedback: string }
    | { type: 'permission_grant'; toolName: string; always: boolean }

// ═══════════════════════════════════════════════
// 子 Agent 事件 — dispatch_agent 的 stream() 通过 yield* 透传到主 AgentLoop
// ═══════════════════════════════════════════════

export type SubagentEvent =
    /**
     * 子 Agent 派生宣告 — dispatch_agent 生成 agentId 的瞬间 yield,
     * 建立 parentToolCallId ↔ agentId 关联,UI 据此在 running 期间就挂载卡片。
     */
    | {
    type: 'subagent_spawn';
    parentToolCallId: string;
    agentId: string;
    name: string;
    agentType: string;
    description: string;
    maxTurns: number
}
    | {
    type: 'subagent_progress';
    agentId: string;
    name: string;
    agentType: string;
    description: string;
    turn: number;
    maxTurns: number;
    currentTool?: string
}
    | { type: 'subagent_done'; agentId: string; name: string; description: string; success: boolean; output: string }

// ═══════════════════════════════════════════════
// 规划事件 — todo_write 工具执行后由 useChat 广播
// ═══════════════════════════════════════════════

export type PlanningEvent =
    | {
    type: 'todo_update';
    todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }>
}

// ═══════════════════════════════════════════════
// 聚合 union — AgentLoop.run() 的 yield 类型
// ═══════════════════════════════════════════════

/**
 * AgentEvent — AgentLoop 产出的事件联合类型。
 *
 * 消费者可按语义分头订阅子 union(SessionLogger 只看 ObservabilityEvent 等),
 * 也可以继续对整个 AgentEvent 做 switch,TypeScript 会检查穷尽性。
 */
export type AgentEvent = BusinessEvent | ObservabilityEvent | SubagentEvent | PlanningEvent
