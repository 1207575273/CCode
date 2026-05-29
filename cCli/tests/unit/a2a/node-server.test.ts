// tests/unit/a2a/node-server.test.ts

import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { startA2ANode, type A2ANodeHandle } from '../../../src/a2a/node-server.js'
import { InstanceRegistry } from '../../../src/a2a/instance-registry.js'
import type { AgentEvent } from '@core/agent-loop.js'

const dirs: string[] = []
const handles: A2ANodeHandle[] = []

function tmpDir(): string {
  const d = join(tmpdir(), `a2a-node-${randomUUID()}`)
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const h of handles.splice(0)) {
    try { h.stop() } catch { /* ignore */ }
  }
  for (const d of dirs.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
})

function fakeRunLoop(text: string): (m: string, s: AbortSignal) => AsyncGenerator<AgentEvent> {
  return async function* () {
    yield { type: 'text', text } as unknown as AgentEvent
    yield { type: 'done' } as unknown as AgentEvent
  }
}

describe('startA2ANode', () => {
  it('should_serve_agentcard_and_write_lockfile_on_start', async () => {
    const reg = new InstanceRegistry({ dir: tmpDir() })
    const node = startA2ANode({
      sessionId: 'sess-1',
      cwd: '/work/proj',
      projectName: 'proj',
      version: '1.0.0',
      getToolNames: () => ['read_file', 'bash'],
      runLoop: fakeRunLoop('hi'),
      registry: reg,
    })
    handles.push(node)

    expect(node.port).toBeGreaterThan(0)

    const res = await fetch(`http://127.0.0.1:${node.port}/.well-known/agent-card.json`)
    expect(res.status).toBe(200)
    const card = (await res.json()) as { name: string; url: string; skills: unknown[] }
    expect(card.name).toContain('proj')
    expect(card.url).toBe(`http://127.0.0.1:${node.port}`)
    expect(card.skills).toHaveLength(2)

    // lockfile 已写入，能被发现
    const found = reg.discover('other-session')
    expect(found.some((c) => c.sessionId === 'sess-1')).toBe(true)
  })

  it('should_remove_lockfile_and_close_server_on_stop', async () => {
    const reg = new InstanceRegistry({ dir: tmpDir() })
    const node = startA2ANode({
      sessionId: 'sess-2',
      cwd: '/x',
      projectName: 'p2',
      version: '1.0.0',
      getToolNames: () => [],
      runLoop: fakeRunLoop('x'),
      registry: reg,
    })
    const port = node.port
    node.stop()

    // lockfile 删除
    expect(reg.discover('other').some((c) => c.sessionId === 'sess-2')).toBe(false)

    // server 关闭后连接失败
    let connectFailed = false
    try {
      await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`, {
        signal: AbortSignal.timeout(1000),
      })
    } catch {
      connectFailed = true
    }
    expect(connectFailed).toBe(true)
  })

  it('should_run_task_via_rpc_message_send', async () => {
    const reg = new InstanceRegistry({ dir: tmpDir() })
    const node = startA2ANode({
      sessionId: 'sess-3',
      cwd: '/x',
      projectName: 'p3',
      version: '1.0.0',
      getToolNames: () => [],
      runLoop: fakeRunLoop('任务结果'),
      registry: reg,
    })
    handles.push(node)

    const res = await fetch(`http://127.0.0.1:${node.port}/a2a/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: '干活' }] } },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { kind: string; status: { state: string } } }
    expect(body.result.kind).toBe('task')
    expect(body.result.status.state).toBe('completed')
  })
})
