/**
 * SessionLogger 端到端测试 — 模拟完整对话链路，验证 JSONL 中的事件序列和配对关系。
 *
 * 场景覆盖：
 * 1. 纯文本对话（llm_call_start → llm_call_end → user → assistant）
 * 2. 工具调用（tool_call_start → tool_call_end）
 * 3. MCP 连接（mcp_connect_start → mcp_connect_end）
 * 4. 错误场景（llm_error → error）
 * 5. session_end 汇总统计
 * 6. parentUuid 链完整性
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionLogger } from '@observability/session-logger.js'
import { SessionStore } from '@persistence/session-store.js'
import type { SessionEvent, SessionEventType } from '@persistence/session-types.js'
import type { AgentEvent } from '@core/agent-loop.js'

let tempDir: string
let store: SessionStore
let logger: SessionLogger

function readAllEvents(): SessionEvent[] {
  const summaries = store.list({ limit: 1 })
  if (summaries.length === 0) return []
  const content = readFileSync(summaries[0]!.filePath, 'utf-8')
  return content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as SessionEvent)
}

function eventTypes(events: SessionEvent[]): SessionEventType[] {
  return events.map(e => e.type)
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'logger-e2e-'))
  store = new SessionStore(tempDir)
  logger = new SessionLogger(store)
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('E2E: 完整对话链路', () => {

  it('纯文本对话 — session_start → user → llm_start/end → assistant → session_end', () => {
    // 模拟: 用户发消息 → LLM 回复 → 退出
    logger.ensureSession('anthropic', 'claude')
    logger.logUserMessage('你好')

    // LLM 调用
    logger.consume({ type: 'llm_start', provider: 'anthropic', model: 'claude', messageCount: 1 })
    logger.consume({ type: 'text', text: '你好！' })  // text 不写日志
    logger.consume({ type: 'llm_usage', inputTokens: 100, outputTokens: 50, stopReason: 'end_turn' })
    logger.consume({ type: 'done' })  // done 不写日志

    logger.logAssistantMessage('你好！', 'claude')
    logger.finalize()

    const events = readAllEvents()
    const types = eventTypes(events)

    // 验证事件序列
    expect(types).toEqual([
      'session_start',
      'user',
      'llm_call_start',
      'llm_call_end',
      'assistant',
      'session_end',
    ])

    // 验证 session_end 汇总
    const endEvent = events.find(e => e.type === 'session_end')!
    expect(endEvent.totalInputTokens).toBe(100)
    expect(endEvent.totalOutputTokens).toBe(50)
    expect(endEvent.totalLlmCalls).toBe(1)
    expect(endEvent.totalToolCalls).toBe(0)
    expect(endEvent.totalErrors).toBe(0)
  })

  it('工具调用链路 — llm → tool_start/end → llm → assistant', () => {
    logger.ensureSession('anthropic', 'claude')
    logger.logUserMessage('帮我看看文件')

    // 第一轮 LLM：决定调用工具
    logger.consume({ type: 'llm_start', provider: 'anthropic', model: 'claude', messageCount: 1 })
    logger.consume({ type: 'llm_usage', inputTokens: 200, outputTokens: 30, stopReason: 'end_turn' })

    // 工具执行
    logger.consume({ type: 'tool_start', toolName: 'read_file', toolCallId: 'tc1', args: { path: 'foo.ts' } })
    logger.consume({ type: 'tool_done', toolName: 'read_file', toolCallId: 'tc1', durationMs: 50, success: true, resultSummary: 'export function foo()...' })

    // 第二轮 LLM：根据工具结果回复
    logger.consume({ type: 'llm_start', provider: 'anthropic', model: 'claude', messageCount: 3 })
    logger.consume({ type: 'llm_usage', inputTokens: 500, outputTokens: 100, stopReason: 'end_turn' })
    logger.consume({ type: 'done' })

    logger.logAssistantMessage('文件内容是...', 'claude')
    logger.finalize()

    const events = readAllEvents()
    const types = eventTypes(events)

    expect(types).toEqual([
      'session_start',
      'user',
      'llm_call_start',
      'llm_call_end',
      'tool_call_start',
      'tool_call_end',
      'llm_call_start',
      'llm_call_end',
      'assistant',
      'session_end',
    ])

    // 验证汇总
    const endEvent = events.find(e => e.type === 'session_end')!
    expect(endEvent.totalInputTokens).toBe(700)   // 200 + 500
    expect(endEvent.totalOutputTokens).toBe(130)   // 30 + 100
    expect(endEvent.totalLlmCalls).toBe(2)
    expect(endEvent.totalToolCalls).toBe(1)
  })

  it('MCP 连接事件 — 在 LLM 调用前触发', () => {
    logger.ensureSession('anthropic', 'claude')
    logger.logUserMessage('hello')

    // MCP 连接（多个 server 并行）
    logger.logMcpConnect({ phase: 'start', serverName: 'mysql', transport: 'stdio' })
    logger.logMcpConnect({ phase: 'start', serverName: 'puppeteer', transport: 'stdio' })
    logger.logMcpConnect({ phase: 'end', serverName: 'mysql', transport: 'stdio', success: true, toolCount: 1, durationMs: 2000 })
    logger.logMcpConnect({ phase: 'end', serverName: 'puppeteer', transport: 'stdio', success: false, error: 'timeout', durationMs: 5000 })

    // LLM 调用
    logger.consume({ type: 'llm_start', provider: 'anthropic', model: 'claude', messageCount: 1 })
    logger.consume({ type: 'llm_usage', inputTokens: 50, outputTokens: 20, stopReason: 'end_turn' })
    logger.consume({ type: 'done' })

    logger.logAssistantMessage('hi', 'claude')

    const events = readAllEvents()

    // MCP 事件配对检查
    const mcpStarts = events.filter(e => e.type === 'mcp_connect_start')
    const mcpEnds = events.filter(e => e.type === 'mcp_connect_end')
    expect(mcpStarts).toHaveLength(2)
    expect(mcpEnds).toHaveLength(2)

    // 失败的 MCP 连接有 error
    const failedMcp = mcpEnds.find(e => e.serverName === 'puppeteer')!
    expect(failedMcp.success).toBe(false)
    expect(failedMcp.error).toBe('timeout')
  })

  it('LLM 错误场景 — llm_start → llm_call_end(error) → error', () => {
    logger.ensureSession('anthropic', 'claude')
    logger.logUserMessage('test')

    logger.consume({ type: 'llm_start', provider: 'anthropic', model: 'claude', messageCount: 1 })
    logger.consume({ type: 'llm_error', error: 'rate limit exceeded', partialOutputTokens: 10 })
    logger.consume({ type: 'error', error: 'rate limit exceeded' })

    logger.finalize()

    const events = readAllEvents()
    const types = eventTypes(events)

    expect(types).toContain('llm_call_start')
    expect(types).toContain('llm_call_end')  // llm_error 映射为 llm_call_end
    expect(types).toContain('error')
    expect(types).toContain('session_end')

    // llm_call_end 应有 error 标记
    const llmEnd = events.find(e => e.type === 'llm_call_end')!
    expect(llmEnd.stopReason).toBe('error')
    expect(llmEnd.error).toBe('rate limit exceeded')
    expect(llmEnd.outputTokens).toBe(10)

    // session_end 应计入错误
    const endEvent = events.find(e => e.type === 'session_end')!
    expect(endEvent.totalErrors).toBe(2)  // llm_error + error
  })

  it('parentUuid 链完整性 — 所有事件形成单链', () => {
    logger.ensureSession('anthropic', 'claude')
    logger.logUserMessage('test')
    logger.consume({ type: 'llm_start', provider: 'anthropic', model: 'claude', messageCount: 1 })
    logger.consume({ type: 'llm_usage', inputTokens: 10, outputTokens: 5, stopReason: 'end_turn' })
    logger.consume({ type: 'tool_start', toolName: 'bash', toolCallId: 'tc1', args: { command: 'ls' } })
    logger.consume({ type: 'tool_done', toolName: 'bash', toolCallId: 'tc1', durationMs: 100, success: true, resultSummary: 'files' })
    logger.logAssistantMessage('done', 'claude')
    logger.finalize()

    const events = readAllEvents()
    const uuidSet = new Set(events.map(e => e.uuid))

    // 每个事件的 parentUuid 必须指向一个存在的 uuid（session_start 除外，它的 parentUuid 是 null）
    for (const event of events) {
      if (event.parentUuid !== null) {
        expect(uuidSet.has(event.parentUuid), `${event.type} parentUuid (${event.parentUuid.slice(0,8)}...) should exist`).toBe(true)
      }
    }

    // 只有 session_start 的 parentUuid 为 null
    const nullParents = events.filter(e => e.parentUuid === null)
    expect(nullParents).toHaveLength(1)
    expect(nullParents[0]!.type).toBe('session_start')

    // 每个 uuid 都是唯一的
    expect(uuidSet.size).toBe(events.length)
  })

  it('start/end 配对完整性 — 每种 start 都有对应的 end', () => {
    logger.ensureSession('anthropic', 'claude')
    logger.logUserMessage('test')

    // MCP
    logger.logMcpConnect({ phase: 'start', serverName: 's1', transport: 'stdio' })
    logger.logMcpConnect({ phase: 'end', serverName: 's1', transport: 'stdio', success: true, toolCount: 2, durationMs: 100 })

    // LLM
    logger.consume({ type: 'llm_start', provider: 'a', model: 'm', messageCount: 1 })
    logger.consume({ type: 'llm_usage', inputTokens: 10, outputTokens: 5, stopReason: 'end_turn' })

    // Tool
    logger.consume({ type: 'tool_start', toolName: 'bash', toolCallId: 'tc1', args: {} })
    logger.consume({ type: 'tool_done', toolName: 'bash', toolCallId: 'tc1', durationMs: 50, success: true })

    // 再一轮 LLM
    logger.consume({ type: 'llm_start', provider: 'a', model: 'm', messageCount: 3 })
    logger.consume({ type: 'llm_usage', inputTokens: 20, outputTokens: 10, stopReason: 'end_turn' })
    logger.consume({ type: 'done' })

    logger.logAssistantMessage('ok', 'm')

    const events = readAllEvents()
    const count = (t: SessionEventType) => events.filter(e => e.type === t).length

    // 配对检查
    expect(count('llm_call_start')).toBe(count('llm_call_end'))
    expect(count('tool_call_start')).toBe(count('tool_call_end'))
    expect(count('mcp_connect_start')).toBe(count('mcp_connect_end'))

    // 具体数量
    expect(count('llm_call_start')).toBe(2)
    expect(count('tool_call_start')).toBe(1)
    expect(count('mcp_connect_start')).toBe(1)
  })
})
