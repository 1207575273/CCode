// tests/unit/a2a/agent-card-builder.test.ts

import { describe, it, expect } from 'vitest'
import type { AgentCard } from '../../../src/a2a/types.js'
import { buildLocalAgentCard } from '../../../src/a2a/agent-card-builder.js'
import type { LocalAgentCardInput } from '../../../src/a2a/agent-card-builder.js'

// 基础测试输入，各用例按需覆盖
const baseInput: LocalAgentCardInput = {
  sessionId: 'abcdef1234567890',
  port: 12345,
  cwd: '/workspace/my-project',
  projectName: 'my-project',
  toolNames: ['read_file', 'write_file', 'bash'],
  version: '0.13.0',
}

// ─────────────────────────────────────────────────────────────────────
// Case 1：name 包含 projectName 和 sessionId 前 6 位
// ─────────────────────────────────────────────────────────────────────
describe('buildLocalAgentCard - name', () => {
  it('should_contain_projectName_port_and_full_sessionId_when_built', () => {
    const card = buildLocalAgentCard(baseInput)

    expect(card.name).toContain(baseInput.projectName)
    // 端口 + 完整 sessionId 都展示，两种标识 dispatch 都能用于精确调用
    expect(card.name).toContain(String(baseInput.port))
    expect(card.name).toContain(baseInput.sessionId)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Case 2：url 使用传入的 port
// ─────────────────────────────────────────────────────────────────────
describe('buildLocalAgentCard - url', () => {
  it('should_use_given_port_when_generating_url', () => {
    const card = buildLocalAgentCard({ ...baseInput, port: 9999 })

    expect(card.url).toBe('http://127.0.0.1:9999')
  })
})

describe('buildLocalAgentCard - 标准传输声明', () => {
  it('should_declare_preferredTransport_jsonrpc', () => {
    const card = buildLocalAgentCard(baseInput)
    expect(card.preferredTransport).toBe('JSONRPC')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Case 3a：description 含 cwd；有 gitBranch 时含分支
// ─────────────────────────────────────────────────────────────────────
describe('buildLocalAgentCard - description with gitBranch', () => {
  it('should_contain_cwd_and_branch_when_gitBranch_provided', () => {
    const card = buildLocalAgentCard({ ...baseInput, gitBranch: 'main' })

    expect(card.description).toContain(baseInput.cwd)
    expect(card.description).toContain('main')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Case 3b：无 gitBranch 时 description 不含"分支"字样
// ─────────────────────────────────────────────────────────────────────
describe('buildLocalAgentCard - description without gitBranch', () => {
  it('should_not_contain_branch_info_when_gitBranch_absent', () => {
    // baseInput 没有 gitBranch 字段
    const card = buildLocalAgentCard(baseInput)

    expect(card.description).toContain(baseInput.cwd)
    // 不含分支相关文字
    expect(card.description).not.toContain('分支')
    expect(card.description).not.toContain('branch')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Case 4：skills 数量 == toolNames 数量，且每个 skill.id == 对应 toolName
// ─────────────────────────────────────────────────────────────────────
describe('buildLocalAgentCard - skills', () => {
  it('should_map_each_toolName_to_skill_with_matching_id', () => {
    const card = buildLocalAgentCard(baseInput)

    expect(card.skills).toHaveLength(baseInput.toolNames.length)
    baseInput.toolNames.forEach((toolName, idx) => {
      expect(card.skills[idx]!.id).toBe(toolName)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────
// Case 5：capabilities.streaming === true
// ─────────────────────────────────────────────────────────────────────
describe('buildLocalAgentCard - capabilities', () => {
  it('should_set_streaming_true_in_capabilities', () => {
    const card = buildLocalAgentCard(baseInput)

    expect(card.capabilities.streaming).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Case 6：返回值可赋给 AgentCard 类型（编译期保证；运行时断言必填字段存在）
// ─────────────────────────────────────────────────────────────────────
describe('buildLocalAgentCard - AgentCard type conformance', () => {
  it('should_satisfy_all_required_AgentCard_fields_when_built', () => {
    // 类型兼容性由 TypeScript 编译器保证（tsc --noEmit）
    // 此处运行时断言所有 AgentCard 必填字段非空
    const card: AgentCard = buildLocalAgentCard(baseInput)

    expect(typeof card.name).toBe('string')
    expect(typeof card.description).toBe('string')
    expect(typeof card.url).toBe('string')
    expect(typeof card.version).toBe('string')
    expect(typeof card.protocolVersion).toBe('string')
    expect(Array.isArray(card.defaultInputModes)).toBe(true)
    expect(Array.isArray(card.defaultOutputModes)).toBe(true)
    expect(Array.isArray(card.skills)).toBe(true)
    expect(typeof card.capabilities).toBe('object')
  })
})
