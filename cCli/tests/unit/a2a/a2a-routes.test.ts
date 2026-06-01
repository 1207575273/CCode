// tests/unit/a2a/a2a-routes.test.ts
//
// A2A HTTP 路由测试 — TDD RED 阶段
// 协议依据：@a2a-js/sdk JsonRpcTransport 实际使用
//   sendMessage     -> POST /a2a/rpc  { jsonrpc:'2.0', method:'message/send',   params, id }
//   sendMessageStream -> POST /a2a/rpc { jsonrpc:'2.0', method:'message/stream', params, id }
//   Accept 头：application/json（非流） / text/event-stream（流）
// SSE 格式：每行 data: <JSON>，JSON 结构为 { jsonrpc:'2.0', id, result: <A2AStreamEvent> }

import { describe, it, expect, vi } from 'vitest'
import { createA2ARoutes } from '../../../src/server/a2a-routes.js'
import type { AgentCard, A2AStreamEvent, Task } from '../../../src/a2a/types.js'

// ──────────────────────────────────────────
// 测试用工具函数
// ──────────────────────────────────────────

/** 构造一个最简 AgentCard */
function fakeAgentCard(): AgentCard {
  return {
    name: 'TestAgent',
    description: '测试用 Agent',
    url: 'http://localhost:9900',
    version: '1.0.0',
    capabilities: {},
  } as unknown as AgentCard
}

/** fake runTask：依次 yield task -> status(working) -> artifact-update -> status(completed, final) */
async function* fakeRunTask(_params: { message: string; taskId: string; contextId: string; caller?: { port?: number; projectName?: string } }): AsyncGenerator<A2AStreamEvent> {
  yield {
    kind: 'task',
    id: _params.taskId,
    contextId: _params.contextId,
    status: { state: 'submitted', timestamp: new Date().toISOString() },
    history: [],
  } as unknown as A2AStreamEvent

  yield {
    kind: 'status-update',
    taskId: _params.taskId,
    contextId: _params.contextId,
    status: { state: 'working', timestamp: new Date().toISOString() },
    final: false,
  } as unknown as A2AStreamEvent

  yield {
    kind: 'artifact-update',
    taskId: _params.taskId,
    contextId: _params.contextId,
    artifact: {
      artifactId: `${_params.taskId}-result`,
      name: 'result.txt',
      parts: [{ kind: 'text', text: '任务结果' }],
    },
    lastChunk: true,
  } as unknown as A2AStreamEvent

  yield {
    kind: 'status-update',
    taskId: _params.taskId,
    contextId: _params.contextId,
    status: {
      state: 'completed',
      timestamp: new Date().toISOString(),
      message: {
        kind: 'message',
        messageId: `${_params.taskId}-done`,
        role: 'agent',
        parts: [{ kind: 'text', text: '完成' }],
      },
    },
    final: true,
  } as unknown as A2AStreamEvent
}

/** 构造合法 JSON-RPC 请求体（message/send） */
function buildRpcBody(method: string, id: number = 1, messageText = '你好'): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method,
    id,
    params: {
      message: {
        kind: 'message',
        messageId: 'msg-001',
        role: 'user',
        parts: [{ kind: 'text', text: messageText }],
      },
    },
  })
}

/** 从 SSE 响应文本中提取所有 data: 行，解析为 JSON */
function parseSseLines(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)))
}

// ──────────────────────────────────────────
// 测试用例
// ──────────────────────────────────────────

describe('createA2ARoutes', () => {
  // 1. GET /.well-known/agent-card.json
  it('should_return_agent_card_when_GET_well_known', async () => {
    const card = fakeAgentCard()
    const app = createA2ARoutes({
      getAgentCard: () => card,
      runTask: fakeRunTask,
      genId: () => 'fixed-id',
    })

    const res = await app.request('/.well-known/agent-card.json')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['name']).toBe('TestAgent')
  })

  // 2. message/send -> 200, result.kind==='task', result.status.state==='completed'
  it('should_return_completed_task_when_message_send', async () => {
    const app = createA2ARoutes({
      getAgentCard: fakeAgentCard,
      runTask: fakeRunTask,
      genId: () => 'task-001',
    })

    const res = await app.request('/a2a/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: buildRpcBody('message/send'),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { jsonrpc: string; id: number; result: Task }
    expect(body.jsonrpc).toBe('2.0')
    expect(body.id).toBe(1)
    expect(body.result.kind).toBe('task')
    expect(body.result.status.state).toBe('completed')
  })

  // 3. message/stream -> content-type text/event-stream, 每行 data 能解析出 {jsonrpc,id,result}
  it('should_stream_sse_events_when_message_stream', async () => {
    const app = createA2ARoutes({
      getAgentCard: fakeAgentCard,
      runTask: fakeRunTask,
      genId: () => 'task-002',
    })

    const res = await app.request('/a2a/rpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: buildRpcBody('message/stream', 42),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const text = await res.text()
    const events = parseSseLines(text)

    // 至少有 4 个事件（task + working + artifact + completed）
    expect(events.length).toBeGreaterThanOrEqual(4)

    // 每个事件必须含 jsonrpc / id / result
    for (const evt of events) {
      const e = evt as Record<string, unknown>
      expect(e['jsonrpc']).toBe('2.0')
      expect(e['id']).toBe(42)
      expect(e['result']).toBeDefined()
    }
  })

  // 4. 非法请求（缺 method）-> JSON-RPC error -32600
  it('should_return_error_32600_when_missing_method', async () => {
    const app = createA2ARoutes({
      getAgentCard: fakeAgentCard,
      runTask: fakeRunTask,
    })

    const res = await app.request('/a2a/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, params: {} }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { error: { code: number } }
    expect(body.error.code).toBe(-32600)
  })

  // 5. 未知 method -> error -32601
  it('should_return_error_32601_when_unknown_method', async () => {
    const app = createA2ARoutes({
      getAgentCard: fakeAgentCard,
      runTask: fakeRunTask,
    })

    const res = await app.request('/a2a/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'unknown/method', id: 1, params: {} }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { error: { code: number } }
    expect(body.error.code).toBe(-32601)
  })

  // 6. runTask 收到正确 message 文本（从 params.message.parts 提取）
  it('should_pass_correct_message_text_to_runTask', async () => {
    const runTask = vi.fn(fakeRunTask)
    const app = createA2ARoutes({
      getAgentCard: fakeAgentCard,
      runTask,
      genId: () => 'id-x',
    })

    await app.request('/a2a/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: buildRpcBody('message/send', 1, '执行任务A'),
    })

    expect(runTask).toHaveBeenCalledOnce()
    const callArg = runTask.mock.calls[0]?.[0]
    expect(callArg?.message).toBe('执行任务A')
  })

  // 7. 从 message.metadata['ccode:caller'] 提取发起方身份透传给 runTask
  it('should_extract_caller_from_message_metadata', async () => {
    const runTask = vi.fn(fakeRunTask)
    const app = createA2ARoutes({ getAgentCard: fakeAgentCard, runTask, genId: () => 'id-c' })

    await app.request('/a2a/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'message/send',
        id: 1,
        params: {
          message: {
            kind: 'message',
            messageId: 'm1',
            role: 'user',
            parts: [{ kind: 'text', text: 'hi' }],
            metadata: { 'ccode:caller': { port: 54751, projectName: 'web' } },
          },
        },
      }),
    })

    expect(runTask.mock.calls[0]?.[0]?.caller).toEqual({ port: 54751, projectName: 'web' })
  })

  // 8. 无 metadata 时 caller 为 undefined（不构造空对象）
  it('should_pass_undefined_caller_when_no_metadata', async () => {
    const runTask = vi.fn(fakeRunTask)
    const app = createA2ARoutes({ getAgentCard: fakeAgentCard, runTask, genId: () => 'id-n' })

    await app.request('/a2a/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: buildRpcBody('message/send', 1, '无来源'),
    })

    expect(runTask.mock.calls[0]?.[0]?.caller).toBeUndefined()
  })
})
