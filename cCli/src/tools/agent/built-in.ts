// src/tools/agent/built-in.ts

/**
 * 内置 Agent 定义 — general / explore / plan。
 *
 * 每个定义描述一种 Agent 的行为模板：
 * - 系统提示词（约束子 Agent 行为边界）
 * - 工具策略（白名单/黑名单）
 * - 最大轮次
 * - 模型建议
 */

import type { BuiltInAgentDefinition } from './types.js'
import { agentDefinitionRegistry } from './definition-registry.js'

// ═══════════════════════════════════════════════
// 超时常量
// ═══════════════════════════════════════════════

/** 通用型 Agent 超时：15 分钟（代码实现 + 构建 + 验证）
 *  2026-04-19 从 10 分钟上调至 15 分钟 — scaffold + install + 多文件改的组合任务在 10 分钟内
 *  经常临门一脚被 kill；依赖同批次 write_file 文案修复消除弱模型死循环诱因(否则多烧的 5 分钟
 *  只会让死循环烧更多 token)。详见 docs/plans/20260419225347_...诊断.md §9.3 Fix-4 */
const TIMEOUT_GENERAL_MS = 15 * 60 * 1000
/** 探索/规划型 Agent 超时：5 分钟（只读搜索 + 分析） */
const TIMEOUT_READONLY_MS = 5 * 60 * 1000

// ═══════════════════════════════════════════════
// general — 通用型
// ═══════════════════════════════════════════════

/**
 * general — 通用型子 Agent，负责代码实现、文件修改、构建验证等多步任务。
 *
 * 提示词设计要点（参考 Claude Code CLI + 弱模型适配经验）：
 *   1. 明确禁止"说了不做" — GLM 等模型最常见的问题是描述计划但不调工具
 *   2. 禁止工具调用间插入长文本 — 浪费 token 且稀释注意力
 *   3. 完成前必须验证 — 跑命令确认而非"我觉得应该没问题"
 *   4. 失败时诊断而非放弃 — 读错误信息，换参数重试
 *   5. 工作流清晰 — read → plan → execute → verify → report
 */
const generalAgent: BuiltInAgentDefinition = {
  agentType: 'general',
  source: 'built-in',
  whenToUse: 'Full toolset, complex multi-step tasks: code implementation, file modification, build & verify',
  toolPolicy: { mode: 'exclude', tools: [] },
  maxTurns: 50,
  modelHint: 'balanced',
  contextPolicy: { mode: 'trimmed', maxMessages: 20, maxTokenEstimate: 8000 },
  minTurns: 5,
  /** 10 分钟超时（重任务：代码实现 + 构建 + 验证） */
  timeoutMs: TIMEOUT_GENERAL_MS,

  getSystemPrompt() {
    return [
      'You are a sub-agent executing a SINGLE assigned task autonomously.',
      '',
      '=== SCOPE CONSTRAINT (HIGHEST PRIORITY) ===',
      'You are delegated ONE specific task. Do ONLY what the task description asks.',
      '- Do NOT expand scope beyond what is explicitly requested.',
      '- Do NOT refactor, optimize, or "improve" code outside the task boundary.',
      '- Do NOT explore unrelated files or fix unrelated issues you happen to notice.',
      '- If the task is ambiguous, do the MINIMAL reasonable interpretation, not the maximal one.',
      '',
      '=== RULES (MUST FOLLOW) ===',
      '1. USE TOOLS for every step. Do NOT just describe what to do — actually call tools to do it.',
      '2. Do NOT output text between tool calls. Call the next tool immediately. Save all commentary for the final summary.',
      '3. Before reporting done, VERIFY your work: run the code, check the output, confirm no errors.',
      '4. If a tool fails, read the error message carefully, diagnose the cause, and retry with a different approach. Do NOT give up after one failure.',
      '5. Keep calling tools until the task is FULLY complete. Partial work is not acceptable.',
      '6. When a tool returns success, that step is DONE. Move to the next step immediately. NEVER call the same tool with the same arguments twice — repeating a successful operation wastes resources and achieves nothing.',
      '',
      '=== WORKFLOW ===',
      'read (understand the codebase) → plan (decide what to do) → execute (call tools) → verify (run & check) → report (final summary).',
      '',
      'Only output your final summary AFTER all work is done and verified. If you output text without calling tools, the system treats it as task completion.',
    ].join('\n')
  },
}

// ═══════════════════════════════════════════════
// explore — 探索型
// ═══════════════════════════════════════════════

/**
 * explore — 探索型子 Agent，只读搜索和分析代码，绝不修改。
 *
 * 提示词设计要点：
 *   1. 开篇强调 READ-ONLY（参考 Claude Code 的 CRITICAL 标注方式）
 *   2. 明确禁止写操作列表，防止弱模型误调
 *   3. 要求输出带文件路径和行号，便于定位
 */
const exploreAgent: BuiltInAgentDefinition = {
  agentType: 'explore',
  source: 'built-in',
  whenToUse: 'Read-only exploration: code search, definition lookup, call chain analysis, directory structure',
  toolPolicy: {
    mode: 'include',
    tools: ['read_file', 'grep', 'glob', 'bash', 'task_output'],
  },
  maxTurns: 50,
  modelHint: 'fast',
  contextPolicy: { mode: 'trimmed', maxMessages: 10, maxTokenEstimate: 4000 },
  minTurns: 2,
  /** 5 分钟超时（轻量只读搜索） */
  timeoutMs: TIMEOUT_READONLY_MS,

  getSystemPrompt() {
    return [
      '=== CRITICAL: READ-ONLY MODE — NO FILE MODIFICATIONS ===',
      '',
      'You are a code exploration specialist.',
      '',
      'FORBIDDEN: write_file, edit_file, bash commands that modify files (rm, mv, cp, mkdir, touch, echo >).',
      'ALLOWED: read_file, grep, glob, bash with read-only commands (cat, find, ls, git log, git diff, wc).',
      '',
      'Workflow:',
      '1. Use grep/glob to locate relevant files.',
      '2. Use read_file to examine contents.',
      '3. Keep searching until you have a COMPLETE answer — do not stop after the first match.',
      '',
      'Output format: file_path:line_number + relevant code snippet + concise analysis.',
      'Do NOT output text between tool calls. Call the next search tool immediately.',
    ].join('\n')
  },
}

// ═══════════════════════════════════════════════
// plan — 规划型
// ═══════════════════════════════════════════════

/**
 * plan — 规划型子 Agent，读代码做架构分析和实施计划，只读不执行。
 *
 * 提示词设计要点：
 *   1. 强制输出结构化内容（步骤 + 文件清单 + 关键决策）
 *   2. 要求引用精确的文件路径和行号，不允许凭记忆
 *   3. 必须读足够多的代码再做设计，不凭假设
 */
const planAgent: BuiltInAgentDefinition = {
  agentType: 'plan',
  source: 'built-in',
  whenToUse: 'Architecture analysis and implementation planning: design proposals, impact assessment, refactoring plans. Read-only, no execution',
  toolPolicy: {
    mode: 'include',
    tools: ['read_file', 'grep', 'glob'],
  },
  maxTurns: 50,
  modelHint: 'strong',
  contextPolicy: { mode: 'trimmed', maxMessages: 30, maxTokenEstimate: 12000 },
  minTurns: 2,
  /** 5 分钟超时（只读分析 + 规划输出） */
  timeoutMs: 5 * 60 * 1000,

  getSystemPrompt() {
    return [
      'You are a software architect. Analyze requirements, read existing code, and produce implementation plans.',
      '',
      '=== RULES ===',
      '1. Read enough code FIRST before designing. Do NOT assume — use grep/glob/read_file to verify.',
      '2. Reference exact file paths and line numbers in your plan. Every claim about the code must be backed by what you actually read.',
      '3. Do NOT output text between tool calls. Read all the code you need first, then produce the plan in one final output.',
      '',
      '=== REQUIRED OUTPUT FORMAT ===',
      'Your final output MUST include:',
      '- Implementation steps (ordered, with dependencies)',
      '- Files to create or modify (exact paths)',
      '- Key design decisions and their rationale',
      '- Risks and edge cases',
      '- Critical files for implementation (paths + line ranges)',
    ].join('\n')
  },
}

// ═══════════════════════════════════════════════
// 注册
// ═══════════════════════════════════════════════

/** 注册所有内置 Agent 定义到全局注册表 */
export function registerBuiltInAgents(): void {
  agentDefinitionRegistry.register(generalAgent)
  agentDefinitionRegistry.register(exploreAgent)
  agentDefinitionRegistry.register(planAgent)
}
