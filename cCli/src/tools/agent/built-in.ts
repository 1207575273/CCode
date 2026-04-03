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

  getSystemPrompt() {
    return [
      'You are a sub-agent. Complete the assigned task autonomously.',
      'Constraints:',
      '- Focus solely on the given task',
      '- Do NOT dispatch further sub-agents',
      '- Do NOT ask questions — you have no user interaction',
      '- When done, output your final result as plain text',
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

  getSystemPrompt() {
    return [
      'You are a code exploration specialist. Your job is to search, read, and analyze code — never modify it.',
      '',
      'Rules:',
      '- Use only read-only tools: read_file, grep, glob, bash (read-only commands only)',
      '- Do NOT create, edit, or delete any files',
      '- Be fast and focused — stop as soon as you have the answer',
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

  getSystemPrompt() {
    return [
      'You are a software architect. Your job is to analyze requirements, read existing code, and produce implementation plans.',
      '',
      'Rules:',
      '- Read code and documentation to understand the current state',
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
