// src/tools/agent/definition-registry.ts

/**
 * AgentDefinitionRegistry — Agent 类型注册表。
 *
 * 管理所有 Agent 定义（内置 + 自定义 + 插件），
 * 供 dispatch_agent 工具按 subagent_type 查找配置。
 *
 * 注册顺序（后覆盖先）：
 * 1. 内置（general / explore / plan）
 * 2. 全局自定义 ~/.ccode/agents/*.md
 * 3. 项目自定义 .ccode/agents/*.md
 * 4. 插件（预留）
 */

import type { AgentDefinition, AgentSource } from './types.js'

const SOURCE_ORDER: Record<AgentSource, number> = {
  'built-in': 0,
  'custom': 1,
  'plugin': 2,
}

export class AgentDefinitionRegistry {
  readonly #definitions = new Map<string, AgentDefinition>()

  /** 注册 Agent 定义（同名覆盖，实现 custom > built-in 的优先级） */
  register(def: AgentDefinition): void {
    this.#definitions.set(def.agentType, def)
  }

  /** 获取指定类型的定义 */
  get(agentType: string): AgentDefinition | undefined {
    return this.#definitions.get(agentType)
  }

  /** 获取所有已注册定义（按 source 排序：built-in → custom → plugin） */
  getAll(): AgentDefinition[] {
    return [...this.#definitions.values()].sort(
      (a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source],
    )
  }

  /** 获取所有类型名列表（用于 dispatch_agent 参数 enum） */
  getTypeNames(): string[] {
    return [...this.#definitions.keys()]
  }

  /** 生成 LLM 可读的类型说明文本 */
  buildTypeDescriptions(): string {
    return this.getAll()
      .map(d => `- ${d.agentType}: ${d.whenToUse}`)
      .join('\n')
  }
}

/** 模块级单例 */
export const agentDefinitionRegistry = new AgentDefinitionRegistry()
