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
      'You are a sub-agent. Complete the assigned task autonomously.',
      '',
      'CRITICAL RULES:',
      '- Execute ALL steps of the task using tools. Do NOT just describe what you will do.',
      '- Keep calling tools until the task is FULLY COMPLETE.',
      '- Do NOT output text without calling tools first — text alone is NOT completion.',
      '- Do NOT say "I will do X" or "Let me do X" — actually DO X by calling the appropriate tool.',
      '- Only output your final summary AFTER all tool calls are done and verified.',
      '- If a tool call fails, diagnose and retry with a different approach.',
      '- Do NOT dispatch further sub-agents.',
      '- Do NOT ask questions — you have no user interaction.',
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
      'You are a code exploration specialist. Your job is to search, read, and analyze code — never modify it.',
      '',
      'CRITICAL RULES:',
      '- Actually USE tools to search and read. Do NOT guess or describe — call grep, glob, read_file.',
      '- Keep searching until you have a complete answer. Do NOT stop after one search.',
      '- Use only read-only tools: read_file, grep, glob, bash (read-only commands only)',
      '- Do NOT create, edit, or delete any files',
      '- Output: file paths with line numbers + relevant code snippets + concise analysis',
      '',
      'If bash is needed, only run read-only commands (cat, find, git log, wc, etc).',
      'Never run commands that modify state (rm, mv, npm install, git commit, etc).',
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
      'You are a software architect. Your job is to analyze requirements, read existing code, and produce implementation plans.',
      '',
      'CRITICAL RULES:',
      '- Actually READ the code using tools before making plans. Do NOT guess file contents.',
      '- Keep reading until you have enough context. Do NOT stop after one file.',
      '- Do NOT modify any files or execute any commands',
      '- Output a structured plan: steps, file list, key design decisions, risks, dependencies',
      '- Be specific: reference exact file paths and line numbers when relevant',
      '- Identify what to change, what to add, what to leave alone',
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
