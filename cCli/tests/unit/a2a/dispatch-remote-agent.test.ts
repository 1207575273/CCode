// tests/unit/a2a/dispatch-remote-agent.test.ts

import { describe, it, expect, vi } from 'vitest'

// 默认让本地会话发现返回空，现有用例不触碰真实 ~/.ccode/instances 目录
vi.mock('../../../src/a2a/instance-registry.js', () => ({
  InstanceRegistry: class {
    discover(): unknown[] {
      return []
    }
  },
}))
import {
  DispatchRemoteAgentTool,
  type RemoteAgentClient,
  type TrustLookup,
} from '@tools/agent/dispatch-remote-agent.js'
import type { ToolContext } from '@tools/core/types.js'
import type { AgentEvent } from '@core/agent-loop.js'
import type { TrustedAgent, A2AStreamEvent } from '../../../src/a2a/types.js'

// ───────────────────────────────────────────────
// 测试夹具
// ───────────────────────────────────────────────

const TRUSTED: TrustedAgent = {
  id: 'agent-1',
  url: 'https://remote.example.com',
  name: 'Remote Sales Agent',
  alias: 'sales',
  securityScheme: 'none',
  addedAt: '2026-01-01T00:00:00Z',
}

function fakeTrustStore(agents: TrustedAgent[] = [TRUSTED]): TrustLookup {
  return {
    findByUrl: async (url) => agents.find((a) => a.url === url),
    list: async () => agents,
  }
}

function fakeClient(events: A2AStreamEvent[], opts?: { throwOnStream?: boolean }): RemoteAgentClient {
  return {
    async *sendMessageStream() {
      if (opts?.throwOnStream) throw new Error('网络中断')
      for (const e of events) yield e
    },
    async cancelTask() {},
  }
}

const CTX = { toolCallId: 'tc-1' } as unknown as ToolContext

async function collect(
  tool: DispatchRemoteAgentTool,
  args: Record<string, unknown>,
) {
  const gen = tool.stream(args, CTX)
  const events: AgentEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, result: next.value }
}

// A2A 流式事件构造器
function taskCreated(state = 'submitted'): A2AStreamEvent {
  return { kind: 'task', id: 't1', contextId: 'c1', status: { state } } as A2AStreamEvent
}
function statusUpdate(state: string, text?: string, final = false): A2AStreamEvent {
  return {
    kind: 'status-update',
    taskId: 't1',
    contextId: 'c1',
    status: {
      state,
      ...(text ? { message: { kind: 'message', messageId: 'm1', role: 'agent', parts: [{ kind: 'text', text }] } } : {}),
    },
    final,
  } as A2AStreamEvent
}
function artifactUpdate(text: string, name?: string): A2AStreamEvent {
  return {
    kind: 'artifact-update',
    taskId: 't1',
    contextId: 'c1',
    artifact: { artifactId: 'a1', ...(name ? { name } : {}), parts: [{ kind: 'text', text }] },
    lastChunk: true,
  } as A2AStreamEvent
}

// ───────────────────────────────────────────────
// 测试
// ───────────────────────────────────────────────

describe('DispatchRemoteAgentTool', () => {
  it('should_return_error_when_agent_is_empty', async () => {
    const tool = new DispatchRemoteAgentTool({ trustStore: fakeTrustStore() })
    const { result } = await collect(tool, { agent: '', message: 'hi' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('agent 不能为空')
  })

  it('should_return_error_when_message_is_empty', async () => {
    const tool = new DispatchRemoteAgentTool({ trustStore: fakeTrustStore() })
    const { result } = await collect(tool, { agent: 'sales', message: '  ' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('message 不能为空')
  })

  it('should_reject_when_agent_not_in_trust_whitelist', async () => {
    const tool = new DispatchRemoteAgentTool({ trustStore: fakeTrustStore() })
    const { result } = await collect(tool, { agent: 'https://evil.com', message: 'hi' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('不在信任白名单')
  })

  it('should_resolve_agent_by_alias_and_complete_full_lifecycle', async () => {
    const events = [
      taskCreated('submitted'),
      statusUpdate('working'),
      artifactUpdate('部分结果', 'result.txt'),
      statusUpdate('completed', 'done!', true),
    ]
    const tool = new DispatchRemoteAgentTool({
      trustStore: fakeTrustStore(),
      createClient: async () => fakeClient(events),
    })
    const { events: yielded, result } = await collect(tool, { agent: 'sales', message: '查一下销售额' })

    // 第一个 yield 应是 subagent_spawn
    expect(yielded[0]?.type).toBe('subagent_spawn')
    // 应有 subagent_done 收尾
    expect(yielded.some((e) => e.type === 'subagent_done')).toBe(true)

    expect(result.success).toBe(true)
    const payload = JSON.parse(result.output)
    expect(payload.status).toBe('completed')
    expect(payload.output).toBe('done!')
    expect(payload.taskId).toBe('t1')
    expect(payload.contextId).toBe('c1')
    expect(payload.artifacts).toHaveLength(1)
    expect(payload.artifacts[0].name).toBe('result.txt')
  })

  it('should_return_auth_required_when_remote_interrupts', async () => {
    const events = [taskCreated('submitted'), statusUpdate('auth-required', '需要认证', true)]
    const tool = new DispatchRemoteAgentTool({
      trustStore: fakeTrustStore(),
      createClient: async () => fakeClient(events),
    })
    const { result } = await collect(tool, { agent: 'sales', message: 'x' })
    const payload = JSON.parse(result.output)
    expect(payload.status).toBe('auth-required')
    expect(payload.reason).toContain('需要认证')
    expect(result.success).toBe(false)
  })

  it('should_return_failed_when_client_throws', async () => {
    const tool = new DispatchRemoteAgentTool({
      trustStore: fakeTrustStore(),
      createClient: async () => fakeClient([], { throwOnStream: true }),
    })
    const { result } = await collect(tool, { agent: 'sales', message: 'x' })
    expect(result.success).toBe(false)
    const payload = JSON.parse(result.output)
    expect(payload.status).toBe('failed')
    expect(payload.reason).toContain('网络中断')
  })

  it('should_resolve_agent_by_url', async () => {
    const tool = new DispatchRemoteAgentTool({
      trustStore: fakeTrustStore(),
      createClient: async () => fakeClient([statusUpdate('completed', 'ok', true)]),
    })
    const { result } = await collect(tool, { agent: 'https://remote.example.com', message: 'x' })
    expect(result.success).toBe(true)
  })

  it('should_resolve_local_instance_by_projectName_with_dynamic_port', async () => {
    const card = {
      sessionId: 'sess-abc',
      pid: 1,
      port: 9801,
      agentCardUrl: 'http://127.0.0.1:9801/.well-known/agent-card.json',
      projectName: 'data-pipeline',
      cwd: '/work/data-pipeline',
      hostname: 'host',
      osUser: 'user',
      startedAt: '2026-01-01T00:00:00Z',
      lastHeartbeat: '2026-01-01T00:00:00Z',
    }
    let calledUrl = ''
    const tool = new DispatchRemoteAgentTool({
      trustStore: fakeTrustStore([]), // 远程白名单为空，必须命中本地
      discoverLocal: () => [card],
      createClient: async (agent) => {
        calledUrl = agent.url
        return fakeClient([statusUpdate('completed', 'ok', true)])
      },
    })
    const { result } = await collect(tool, { agent: 'data-pipeline', message: 'x' })
    expect(result.success).toBe(true)
    expect(calledUrl).toBe('http://127.0.0.1:9801') // 端口从名片动态读取
  })

  it('should_prefer_local_instance_over_remote_when_both_match', async () => {
    const card = {
      sessionId: 'sess-xyz', pid: 1, port: 9802,
      agentCardUrl: 'http://127.0.0.1:9802/.well-known/agent-card.json',
      projectName: 'sales', cwd: '/x', hostname: 'h', osUser: 'u',
      startedAt: '2026-01-01T00:00:00Z', lastHeartbeat: '2026-01-01T00:00:00Z',
    }
    let calledUrl = ''
    const tool = new DispatchRemoteAgentTool({
      trustStore: fakeTrustStore(), // 远程也有 alias='sales'
      discoverLocal: () => [card],
      createClient: async (agent) => {
        calledUrl = agent.url
        return fakeClient([statusUpdate('completed', 'ok', true)])
      },
    })
    await collect(tool, { agent: 'sales', message: 'x' })
    expect(calledUrl).toBe('http://127.0.0.1:9802') // 本地优先
  })
})
