import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionLogger } from '@observability/session-logger.js'
import { SessionStore } from '@persistence/session-store.js'
import type { SessionEvent } from '@persistence/session-types.js'
import type { AgentEvent } from '@core/agent-loop.js'

let tempDir: string
let store: SessionStore
let logger: SessionLogger

/** 读取 JSONL 文件中的所有事件 */
function readEvents(): SessionEvent[] {
  const summaries = store.list({ limit: 1 })
  if (summaries.length === 0) return []
  const content = readFileSync(summaries[0]!.filePath, 'utf-8')
  return content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as SessionEvent)
}

/** 消费一个 AgentEvent 并返回新增的事件 */
function consumeAndRead(event: AgentEvent): SessionEvent[] {
  const before = readEvents().length
  logger.consume(event)
  const after = readEvents()
  return after.slice(before)
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'session-logger-test-'))
  store = new SessionStore(tempDir)
  logger = new SessionLogger(store)
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('SessionLogger.consume', () => {
  it('should_write_llm_call_start_event', () => {
    logger.ensureSession('anthropic', 'claude')
    const added = consumeAndRead({ type: 'llm_start', provider: 'anthropic', model: 'claude', messageCount: 5 })
    expect(added).toHaveLength(1)
    expect(added[0]!.type).toBe('llm_call_start')
    expect(added[0]!.provider).toBe('anthropic')
    expect(added[0]!.model).toBe('claude')
    expect(added[0]!.messageCount).toBe(5)
  })

  it('should_write_llm_call_end_event_with_tokens', () => {
    logger.ensureSession('anthropic', 'claude')
    const added = consumeAndRead({ type: 'llm_done', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn' })
    expect(added).toHaveLength(1)
    expect(added[0]!.type).toBe('llm_call_end')
    expect(added[0]!.inputTokens).toBe(100)
    expect(added[0]!.outputTokens).toBe(50)
    expect(added[0]!.stopReason).toBe('end_turn')
  })

  it('should_write_llm_call_end_with_error_on_llm_error', () => {
    logger.ensureSession('anthropic', 'claude')
    const added = consumeAndRead({ type: 'llm_error', error: 'rate limit', partialOutputTokens: 20 })
    expect(added).toHaveLength(1)
    expect(added[0]!.type).toBe('llm_call_end')
    expect(added[0]!.stopReason).toBe('error')
    expect(added[0]!.error).toBe('rate limit')
    expect(added[0]!.outputTokens).toBe(20)
  })

  it('should_write_tool_call_start_and_end_events', () => {
    logger.ensureSession('anthropic', 'claude')
    logger.consume({ type: 'tool_start', toolName: 'bash', toolCallId: 'tc1', args: { command: 'ls' } })
    logger.consume({ type: 'tool_done', toolName: 'bash', toolCallId: 'tc1', durationMs: 150, success: true, resultSummary: 'file1.txt' })
    const events = readEvents()
    // session_start + tool_call_start + tool_call_end
    const toolEvents = events.filter(e => e.type === 'tool_call_start' || e.type === 'tool_call_end')
    expect(toolEvents).toHaveLength(2)
    expect(toolEvents[0]!.type).toBe('tool_call_start')
    expect(toolEvents[0]!.toolName).toBe('bash')
    expect(toolEvents[1]!.type).toBe('tool_call_end')
    expect(toolEvents[1]!.durationMs).toBe(150)
    expect(toolEvents[1]!.success).toBe(true)
    expect(toolEvents[1]!.resultSummary).toBe('file1.txt')
  })

  it('should_write_tool_fallback_event', () => {
    logger.ensureSession('anthropic', 'claude')
    const added = consumeAndRead({ type: 'tool_fallback', toolName: 'bash', fromLevel: 'gitbash', toLevel: 'powershell', reason: 'not found' })
    expect(added).toHaveLength(1)
    expect(added[0]!.type).toBe('tool_fallback')
    expect(added[0]!.fromLevel).toBe('gitbash')
    expect(added[0]!.toLevel).toBe('powershell')
  })

  it('should_write_permission_grant_event', () => {
    logger.ensureSession('anthropic', 'claude')
    const added = consumeAndRead({ type: 'permission_grant', toolName: 'bash', always: true })
    expect(added).toHaveLength(1)
    expect(added[0]!.type).toBe('permission_grant')
    expect(added[0]!.toolName).toBe('bash')
    expect(added[0]!.always).toBe(true)
  })

  it('should_write_error_event', () => {
    logger.ensureSession('anthropic', 'claude')
    const added = consumeAndRead({ type: 'error', error: 'something broke' })
    expect(added).toHaveLength(1)
    expect(added[0]!.type).toBe('error')
    expect(added[0]!.error).toBe('something broke')
    expect(added[0]!.source).toBe('agent')
  })

  it('should_chain_parentUuid_correctly', () => {
    logger.ensureSession('anthropic', 'claude')
    logger.consume({ type: 'llm_start', provider: 'anthropic', model: 'claude', messageCount: 1 })
    logger.consume({ type: 'llm_done', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn' })
    const events = readEvents()
    // session_start → llm_call_start → llm_call_end
    expect(events).toHaveLength(3)
    expect(events[1]!.parentUuid).toBe(events[0]!.uuid)
    expect(events[2]!.parentUuid).toBe(events[1]!.uuid)
  })

  it('should_silently_ignore_events_when_no_session_bound', () => {
    // 不调用 ensureSession / bind，直接 consume
    logger.consume({ type: 'llm_start', provider: 'anthropic', model: 'claude', messageCount: 1 })
    // 没有文件被创建
    const summaries = store.list({ limit: 1 })
    expect(summaries).toHaveLength(0)
  })

  it('should_not_write_events_for_text_and_done', () => {
    logger.ensureSession('anthropic', 'claude')
    const before = readEvents().length
    logger.consume({ type: 'text', text: 'hello' })
    logger.consume({ type: 'done' })
    const after = readEvents().length
    expect(after).toBe(before) // 没有新增事件
  })
})

describe('SessionLogger.logUserMessage / logAssistantMessage', () => {
  it('should_write_user_and_assistant_events', () => {
    logger.ensureSession('anthropic', 'claude')
    logger.logUserMessage('hello')
    logger.logAssistantMessage('hi there', 'claude')
    const events = readEvents()
    const userEvent = events.find(e => e.type === 'user')
    const assistantEvent = events.find(e => e.type === 'assistant')
    expect(userEvent).toBeDefined()
    expect(userEvent!.message?.content).toBe('hello')
    expect(assistantEvent).toBeDefined()
    expect(assistantEvent!.message?.content).toBe('hi there')
    expect(assistantEvent!.message?.model).toBe('claude')
  })
})

describe('SessionLogger.logMcpConnect', () => {
  it('should_write_mcp_connect_start_event', () => {
    logger.ensureSession('anthropic', 'claude')
    logger.logMcpConnect({ phase: 'start', serverName: 'test-server', transport: 'stdio' })
    const events = readEvents()
    const mcpEvent = events.find(e => e.type === 'mcp_connect_start')
    expect(mcpEvent).toBeDefined()
    expect(mcpEvent!.serverName).toBe('test-server')
    expect(mcpEvent!.transport).toBe('stdio')
  })

  it('should_write_mcp_connect_end_success_event', () => {
    logger.ensureSession('anthropic', 'claude')
    logger.logMcpConnect({ phase: 'end', serverName: 'test-server', transport: 'stdio', success: true, toolCount: 3, durationMs: 200 })
    const events = readEvents()
    const mcpEvent = events.find(e => e.type === 'mcp_connect_end')
    expect(mcpEvent).toBeDefined()
    expect(mcpEvent!.success).toBe(true)
    expect(mcpEvent!.toolCount).toBe(3)
    expect(mcpEvent!.durationMs).toBe(200)
  })

  it('should_write_mcp_connect_end_error_event', () => {
    logger.ensureSession('anthropic', 'claude')
    logger.logMcpConnect({ phase: 'end', serverName: 'bad-server', transport: 'sse', success: false, error: 'connection refused', durationMs: 50 })
    const events = readEvents()
    const mcpEvent = events.find(e => e.type === 'mcp_connect_end')
    expect(mcpEvent).toBeDefined()
    expect(mcpEvent!.success).toBe(false)
    expect(mcpEvent!.error).toBe('connection refused')
  })
})

describe('SessionLogger.finalize', () => {
  it('should_write_session_end_with_accumulated_stats', () => {
    logger.ensureSession('anthropic', 'claude')
    // 模拟一轮对话
    logger.consume({ type: 'llm_start', provider: 'anthropic', model: 'claude', messageCount: 1 })
    logger.consume({ type: 'llm_done', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn' })
    logger.consume({ type: 'tool_start', toolName: 'bash', toolCallId: 'tc1', args: {} })
    logger.consume({ type: 'tool_done', toolName: 'bash', toolCallId: 'tc1', durationMs: 100, success: true })
    logger.consume({ type: 'error', error: 'test error' })
    logger.finalize()

    const events = readEvents()
    const endEvent = events.find(e => e.type === 'session_end')
    expect(endEvent).toBeDefined()
    expect(endEvent!.totalInputTokens).toBe(100)
    expect(endEvent!.totalOutputTokens).toBe(50)
    expect(endEvent!.totalLlmCalls).toBe(1)
    expect(endEvent!.totalToolCalls).toBe(1)
    expect(endEvent!.totalErrors).toBe(1) // error event
    expect(endEvent!.totalDurationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('SessionLogger.bind', () => {
  it('should_bind_to_existing_session_and_continue_writing', () => {
    // 先创建一个 session
    const sid = store.create(process.cwd(), 'anthropic', 'claude')
    logger.bind(sid)
    logger.logUserMessage('resumed message')
    const events = readEvents()
    const userEvent = events.find(e => e.type === 'user')
    expect(userEvent).toBeDefined()
    expect(userEvent!.message?.content).toBe('resumed message')
  })
})
