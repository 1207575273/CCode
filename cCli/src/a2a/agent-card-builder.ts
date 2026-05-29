// src/a2a/agent-card-builder.ts
/**
 * 动态 AgentCard 生成器 — 纯函数实现。
 *
 * 职责：把当前 CCode 会话的运行时信息（工具列表、端口、项目目录等）
 * 映射成符合 A2A 协议规范的 AgentCard，供其他 Agent 节点通过
 * /.well-known/agent.json 发现并了解本节点能力。
 *
 * 设计依据：总体方案 §5.2 AgentCard 动态生成。
 */

import type { AgentCard } from './types.js'

/** A2A 协议版本（与 @a2a-js/sdk ^0.3.x 对齐） */
const A2A_PROTOCOL_VERSION = '0.3.0'

/**
 * buildLocalAgentCard 的输入参数。
 *
 * - gitBranch 为可选字段，遵循 exactOptionalPropertyTypes：
 *   有值时在 description 中拼入，无值时不出现任何分支相关字样。
 */
export interface LocalAgentCardInput {
  /** 当前会话唯一 ID（UUID），截取前 6 位作为 name 后缀 */
  sessionId: string
  /** 本地 A2A HTTP 服务监听端口 */
  port: number
  /** 当前工作目录（绝对路径） */
  cwd: string
  /** 项目名称（通常取自 package.json name 或目录名） */
  projectName: string
  /** 当前 Git 分支（可选，不存在时 description 不含分支信息） */
  gitBranch?: string
  /** 本会话 ToolRegistry 的工具名列表，每项映射为一个 AgentSkill */
  toolNames: string[]
  /** CCode 版本（取自 package.json version） */
  version: string
}

/**
 * 根据会话运行时信息动态生成 AgentCard。
 *
 * 返回值完全符合 AgentCard 接口——所有必填字段都已填写，
 * tsc --noEmit 通过即为类型正确的证明。
 */
export function buildLocalAgentCard(input: LocalAgentCardInput): AgentCard {
  const { sessionId, port, cwd, projectName, gitBranch, toolNames, version } = input

  // description：含项目名 + cwd，有 gitBranch 时追加分支，无则省略
  const branchPart = gitBranch !== undefined ? ` | 分支: ${gitBranch}` : ''
  const description =
    `CCode 会话 Agent | 项目: ${projectName} | 目录: ${cwd}${branchPart}`

  // skills：每个工具名映射为一条 AgentSkill（必填字段：id / name / description / tags）
  const skills = toolNames.map((toolName) => ({
    id: toolName,
    name: toolName,
    description: `工具 ${toolName}`,
    tags: ['tool'] as string[],
  }))

  return {
    name: `${projectName} #${sessionId.slice(0, 6)}`,
    description,
    url: `http://127.0.0.1:${port}`,
    version,
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
  }
}
