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
// general — 通用型
// ═══════════════════════════════════════════════

const generalAgent: BuiltInAgentDefinition = {
  agentType: 'general',
  source: 'built-in',
  whenToUse: 'Full toolset, complex multi-step tasks: code implementation, file modification, build & verify',
  toolPolicy: { mode: 'exclude', tools: [] },
  maxTurns: 25,
  modelHint: 'balanced',
  contextPolicy: { mode: 'trimmed', maxMessages: 20, maxTokenEstimate: 8000 },
  minTurns: 5,

  getSystemPrompt() {
    return [
      'You are a sub-agent executing a task autonomously. Work step by step using tools until fully done.',
      '',
      'Workflow: read → plan → execute → verify → report.',
      'Call tools for each step. When a step is done, move to the next immediately.',
      'If a tool fails, try a different approach.',
      'Only write your final summary after all work is verified complete.',
    ].join('\n')
  },
}

// ═══════════════════════════════════════════════
// explore — 探索型
// ═══════════════════════════════════════════════

const exploreAgent: BuiltInAgentDefinition = {
  agentType: 'explore',
  source: 'built-in',
  whenToUse: 'Read-only exploration: code search, definition lookup, call chain analysis, directory structure',
  toolPolicy: {
    mode: 'include',
    tools: ['read_file', 'grep', 'glob', 'bash', 'task_output'],
  },
  maxTurns: 15,
  modelHint: 'fast',
  contextPolicy: { mode: 'trimmed', maxMessages: 10, maxTokenEstimate: 4000 },
  minTurns: 2,

  getSystemPrompt() {
    return [
      'You are a code exploration specialist. Search, read, and analyze code — never modify it.',
      '',
      'Workflow: use grep/glob to find files → read_file to examine → analyze and report.',
      'Keep searching until you have a complete answer.',
      'Use only read-only tools (read_file, grep, glob, bash with read-only commands like cat/find/git log).',
      'Output: file paths with line numbers + relevant code snippets + concise analysis.',
    ].join('\n')
  },
}

// ═══════════════════════════════════════════════
// plan — 规划型
// ═══════════════════════════════════════════════

const planAgent: BuiltInAgentDefinition = {
  agentType: 'plan',
  source: 'built-in',
  whenToUse: 'Architecture analysis and implementation planning: design proposals, impact assessment, refactoring plans. Read-only, no execution',
  toolPolicy: {
    mode: 'include',
    tools: ['read_file', 'grep', 'glob'],
  },
  maxTurns: 15,
  modelHint: 'strong',
  contextPolicy: { mode: 'trimmed', maxMessages: 30, maxTokenEstimate: 12000 },
  minTurns: 2,

  getSystemPrompt() {
    return [
      'You are a software architect. Analyze requirements, read existing code, and produce implementation plans.',
      '',
      'Workflow: use grep/glob/read_file to understand the codebase → design the plan → report.',
      'Read enough code to make informed decisions. Reference exact file paths and line numbers.',
      'Output: steps, file list, key design decisions, risks, dependencies.',
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
