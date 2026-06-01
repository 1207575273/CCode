// tests/unit/a2a/a2a-dashboard-api.test.ts

import { describe, it, expect, vi } from 'vitest'
import { createA2aDashboardRoutes } from '../../../src/server/dashboard/a2a-dashboard-api.js'
import type { InstanceCard } from '../../../src/a2a/instance-registry.js'
import type { InboundActivity } from '../../../src/a2a/node-status.js'
import type { TrustedAgent } from '../../../src/a2a/types.js'

function fakeCard(over: Partial<InstanceCard> = {}): InstanceCard {
  return {
    sessionId: 's1',
    pid: 100,
    port: 9801,
    agentCardUrl: 'http://127.0.0.1:9801/.well-known/agent-card.json',
    projectName: 'cCli',
    cwd: '/d/work/cCli',
    hostname: 'host',
    osUser: 'me',
    startedAt: '2026-06-01T00:00:00.000Z',
    lastHeartbeat: '2026-06-01T00:00:10.000Z',
    ...over,
  }
}

describe('createA2aDashboardRoutes /agents', () => {
  it('should_attach_inbound_activity_to_each_local_instance', async () => {
    const card = fakeCard({ port: 9802 })
    const inbound: InboundActivity = {
      active: 1,
      recent: [{ taskId: 't1', messagePreview: 'hi', state: 'running', startedAt: '2026-06-01T00:00:00.000Z' }],
    }
    const fetchInbound = vi.fn(async (port: number) => (port === 9802 ? inbound : null))

    const app = createA2aDashboardRoutes({
      discoverLocal: () => [card],
      listRemote: async () => [],
      fetchInbound,
    })

    const res = await app.request('/agents')
    const body = await res.json() as { local: Array<InstanceCard & { inbound?: InboundActivity }>; remote: unknown[] }

    expect(fetchInbound).toHaveBeenCalledWith(9802)
    expect(body.local[0]!.inbound).toEqual(inbound)
  })

  it('should_omit_inbound_when_fetch_returns_null', async () => {
    const app = createA2aDashboardRoutes({
      discoverLocal: () => [fakeCard()],
      listRemote: async () => [],
      fetchInbound: async () => null,
    })

    const res = await app.request('/agents')
    const body = await res.json() as { local: Array<InstanceCard & { inbound?: InboundActivity }> }
    expect(body.local[0]!.inbound).toBeUndefined()
  })

  it('should_redact_remote_token', async () => {
    const remote: TrustedAgent = {
      id: 'r1',
      url: 'https://x.example.com',
      name: 'X',
      securityScheme: 'bearer',
      authToken: 'super-secret',
      addedAt: '2026-06-01T00:00:00.000Z',
    }
    const app = createA2aDashboardRoutes({
      discoverLocal: () => [],
      listRemote: async () => [remote],
      fetchInbound: async () => null,
    })

    const res = await app.request('/agents')
    const body = await res.json() as { remote: Array<{ hasToken: boolean; authToken?: string }> }
    expect(body.remote[0]!.hasToken).toBe(true)
    expect(body.remote[0]!.authToken).toBeUndefined()
  })

  it('should_not_fail_when_discover_throws', async () => {
    const app = createA2aDashboardRoutes({
      discoverLocal: () => { throw new Error('lockfile error') },
      listRemote: async () => [],
      fetchInbound: async () => null,
    })
    const res = await app.request('/agents')
    const body = await res.json() as { local: unknown[]; remote: unknown[] }
    expect(body.local).toEqual([])
  })
})
