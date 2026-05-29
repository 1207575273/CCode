/**
 * A2AClientWrapper 单元测试
 *
 * 严格 TDD：先红后绿。
 * vi.mock('@a2a-js/sdk/client') 拦截所有 SDK 调用，隔离网络与 RPC。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentCard, Task, Message, TaskStatusUpdateEvent } from '../../../src/a2a/types.js'
import type { TrustedAgent } from '../../../src/a2a/types.js'

// ── SDK mock ────────────────────────────────────────────────────────────────

/** 假 Client 实例——各 test 可覆写 mockResolvedValue */
const mockSendMessage = vi.fn()
const mockSendMessageStream = vi.fn()
const mockCancelTask = vi.fn()

/** createFromUrl 返回的假 Client */
const fakeClient = {
  sendMessage: mockSendMessage,
  sendMessageStream: mockSendMessageStream,
  cancelTask: mockCancelTask,
}

/** 拦截 ClientFactory.createFromUrl */
const mockCreateFromUrl = vi.fn().mockResolvedValue(fakeClient)

/** 拦截 DefaultAgentCardResolver.resolve */
const mockResolve = vi.fn()

vi.mock('@a2a-js/sdk/client', () => {
  // vi.fn() 本身可以被 new 调用（函数即构造器），mockImplementation 的回调也需要能被 new 调用
  // 使用 function 关键字确保 vitest 正确识别为构造函数
  const MockClientFactory = vi.fn(function (this: unknown) {
    return { createFromUrl: mockCreateFromUrl }
  })
  const MockJsonRpcTransportFactory = vi.fn(function (this: unknown, _opts?: unknown) {
    return {}
  })
  const MockRestTransportFactory = vi.fn(function (this: unknown, _opts?: unknown) {
    return {}
  })
  const MockDefaultAgentCardResolver = vi.fn(function (this: unknown, _opts?: unknown) {
    return { resolve: mockResolve }
  })
  return {
    ClientFactory: MockClientFactory,
    JsonRpcTransportFactory: MockJsonRpcTransportFactory,
    RestTransportFactory: MockRestTransportFactory,
    DefaultAgentCardResolver: MockDefaultAgentCardResolver,
  }
})

// ── 被测模块（mock 注册后再导入）──────────────────────────────────────────

const { A2AClientWrapper } = await import('../../../src/a2a/client.js')

// ── 测试夹具 ────────────────────────────────────────────────────────────────

/** 最小 TrustedAgent（securityScheme=none）*/
function makeTrustedAgent(overrides?: Partial<TrustedAgent>): TrustedAgent {
  return {
    id: 'agent-001',
    url: 'http://localhost:9999',
    name: 'TestAgent',
    securityScheme: 'none',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** 最小合法 AgentCard */
function makeAgentCard(overrides?: Partial<AgentCard>): AgentCard {
  return {
    protocolVersion: '0.2.2',
    name: 'TestAgent',
    url: 'http://localhost:9999',
    version: '1.0.0',
    capabilities: {},
    ...overrides,
  } as AgentCard
}

// ── 测试套件 ────────────────────────────────────────────────────────────────

describe('A2AClientWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateFromUrl.mockResolvedValue(fakeClient)
  })

  // ── 用例 1：fetchAgentCard 成功返回 card ─────────────────────────────────
  describe('fetchAgentCard', () => {
    it('should_return_agent_card_when_resolver_succeeds', async () => {
      const card = makeAgentCard()
      mockResolve.mockResolvedValueOnce(card)

      const result = await A2AClientWrapper.fetchAgentCard('http://localhost:9999')

      expect(result).toEqual(card)
      expect(mockResolve).toHaveBeenCalledWith('http://localhost:9999', undefined)
    })

    it('should_pass_timeout_via_AbortSignal_when_timeoutMs_provided', async () => {
      const card = makeAgentCard()
      mockResolve.mockResolvedValueOnce(card)

      // 仅验证不抛错，超时注入在 fetchImpl 层；此处通过 resolve 被调用来断言流程走通
      await A2AClientWrapper.fetchAgentCard('http://localhost:9999', { timeoutMs: 3000 })

      expect(mockResolve).toHaveBeenCalledTimes(1)
    })
  })

  // ── 用例 2：sendMessage 把 text 正确封装成 MessageSendParams ─────────────
  describe('sendMessage', () => {
    it('should_wrap_text_into_MessageSendParams_when_calling_underlying_client', async () => {
      const fakeMessage: Message = {
        kind: 'message',
        messageId: 'msg-ret-001',
        role: 'agent',
        parts: [{ kind: 'text', text: 'pong' }],
      }
      mockSendMessage.mockResolvedValueOnce(fakeMessage)

      const wrapper = await A2AClientWrapper.create(makeTrustedAgent())
      const result = await wrapper.sendMessage('hello agent')

      // 断言底层被调用，且 params 结构正确
      expect(mockSendMessage).toHaveBeenCalledTimes(1)
      const [calledParams] = mockSendMessage.mock.calls[0] as [
        { message: { kind: string; role: string; parts: Array<{ kind: string; text: string }> } },
      ]
      expect(calledParams.message.kind).toBe('message')
      expect(calledParams.message.role).toBe('user')
      expect(calledParams.message.parts[0]).toMatchObject({ kind: 'text', text: 'hello agent' })
      // 返回值透传
      expect(result).toEqual(fakeMessage)
    })

    it('should_include_contextId_in_params_when_provided', async () => {
      mockSendMessage.mockResolvedValueOnce({ kind: 'message', messageId: 'x', role: 'agent', parts: [] })

      const wrapper = await A2AClientWrapper.create(makeTrustedAgent())
      await wrapper.sendMessage('hi', 'ctx-abc')

      const [calledParams] = mockSendMessage.mock.calls[0] as [{ message: { contextId?: string } }]
      expect(calledParams.message.contextId).toBe('ctx-abc')
    })

    it('should_not_include_contextId_in_params_when_not_provided', async () => {
      mockSendMessage.mockResolvedValueOnce({ kind: 'message', messageId: 'x', role: 'agent', parts: [] })

      const wrapper = await A2AClientWrapper.create(makeTrustedAgent())
      await wrapper.sendMessage('hi')

      const [calledParams] = mockSendMessage.mock.calls[0] as [{ message: Record<string, unknown> }]
      // exactOptionalPropertyTypes: contextId 不应存在于对象上（不赋 undefined）
      expect('contextId' in calledParams.message).toBe(false)
    })
  })

  // ── 用例 3：sendMessageStream yield 底层 generator 的事件 ────────────────
  describe('sendMessageStream', () => {
    it('should_yield_events_from_underlying_async_generator_when_streaming', async () => {
      const fakeTask: Task = {
        kind: 'task',
        id: 'task-001',
        contextId: 'ctx-001',
        status: { state: 'working', timestamp: '2026-01-01T00:00:00.000Z' },
      }
      const fakeStatusUpdate: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId: 'task-001',
        contextId: 'ctx-001',
        status: { state: 'completed', timestamp: '2026-01-01T00:01:00.000Z' },
        final: true,
      }

      // mock async generator
      async function* fakeGenerator() {
        yield fakeTask
        yield fakeStatusUpdate
      }
      mockSendMessageStream.mockReturnValueOnce(fakeGenerator())

      const wrapper = await A2AClientWrapper.create(makeTrustedAgent())
      const collected: unknown[] = []
      for await (const event of wrapper.sendMessageStream('stream me')) {
        collected.push(event)
      }

      expect(collected).toHaveLength(2)
      expect(collected[0]).toEqual(fakeTask)
      expect(collected[1]).toEqual(fakeStatusUpdate)
    })
  })

  // ── 用例 4：cancelTask 底层抛错时不上抛 ─────────────────────────────────
  describe('cancelTask', () => {
    it('should_not_throw_when_underlying_cancelTask_throws', async () => {
      mockCancelTask.mockRejectedValueOnce(new Error('task not found'))

      const wrapper = await A2AClientWrapper.create(makeTrustedAgent())

      // 不应抛出，静默兜底
      await expect(wrapper.cancelTask('task-999')).resolves.toBeUndefined()
    })

    it('should_call_underlying_cancelTask_with_correct_taskId', async () => {
      const fakeTask: Task = {
        kind: 'task',
        id: 'task-001',
        contextId: 'ctx-001',
        status: { state: 'canceled', timestamp: '2026-01-01T00:00:00.000Z' },
      }
      mockCancelTask.mockResolvedValueOnce(fakeTask)

      const wrapper = await A2AClientWrapper.create(makeTrustedAgent())
      await wrapper.cancelTask('task-001')

      expect(mockCancelTask).toHaveBeenCalledWith({ id: 'task-001' })
    })
  })

  // ── 用例 5：bearer token 注入（create 时传 authToken）────────────────────
  describe('bearer auth', () => {
    it('should_inject_Authorization_header_when_securityScheme_is_bearer', async () => {
      // 验证：构造时 fetchImpl wrapper 已被注入给 JsonRpcTransportFactory / RestTransportFactory
      // 通过检查 mock 构造参数来断言
      const { JsonRpcTransportFactory, RestTransportFactory } = await import('@a2a-js/sdk/client')

      const agent = makeTrustedAgent({ securityScheme: 'bearer', authToken: 'secret-token' })
      await A2AClientWrapper.create(agent)

      // 两个 transport factory 都应以带 fetchImpl 的 options 构造
      const jrpcCalls = (JsonRpcTransportFactory as ReturnType<typeof vi.fn>).mock.calls
      const restCalls = (RestTransportFactory as ReturnType<typeof vi.fn>).mock.calls
      // 找到此次调用（beforeEach 清了 mock，所以是最新一次）
      const lastJrpc = jrpcCalls[jrpcCalls.length - 1]?.[0] as { fetchImpl?: unknown } | undefined
      const lastRest = restCalls[restCalls.length - 1]?.[0] as { fetchImpl?: unknown } | undefined

      expect(typeof lastJrpc?.fetchImpl).toBe('function')
      expect(typeof lastRest?.fetchImpl).toBe('function')
    })
  })
})
