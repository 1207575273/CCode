// src/server/dashboard/a2a-dashboard-api.ts

/**
 * A2A Dashboard API — 给 Web 控制台提供 Agent 网格视图数据。
 *
 * 注意：与 `src/server/a2a-routes.ts`（A2A 协议端点 /a2a/rpc）区分开。
 * 本模块是 Dashboard 的只读列表接口（/api/a2a/agents），不参与 A2A 协议。
 *
 * 数据源：
 * - local：本机 lockfile 发现的活跃 CCode 会话（InstanceRegistry）
 *   - 每个会话的 inbound 被调活动跨进程聚合：并行拉取各节点的
 *     `/a2a/inbound-activity` 端点（inbound 状态是各会话进程内态，dashboard
 *     自身进程拿不到别的会话的，必须 HTTP 聚合）。
 * - remote：受信任的远程 Agent 白名单（A2ATrustStore，token 脱敏后返回）
 */

import { Hono } from 'hono'
import { InstanceRegistry } from '../../a2a/instance-registry.js'
import type { InstanceCard } from '../../a2a/instance-registry.js'
import { A2ATrustStore } from '../../config/a2a-config.js'
import type { TrustedAgent } from '../../a2a/types.js'
import type { InboundActivity } from '../../a2a/node-status.js'

/** 单个节点 inbound 拉取超时（localhost，留足余量即可） */
const INBOUND_FETCH_TIMEOUT_MS = 1500

/** 可注入依赖（默认走真实实现，测试可替换） */
export interface A2aDashboardDeps {
  /** 发现本机活跃会话（默认 InstanceRegistry.discover('')） */
  discoverLocal?: () => InstanceCard[]
  /** 列出远程已信任 Agent（默认 A2ATrustStore.list()） */
  listRemote?: () => Promise<TrustedAgent[]>
  /** 拉取某端口节点的 inbound 活动（默认 HTTP 拉 /a2a/inbound-activity，失败返回 null） */
  fetchInbound?: (port: number) => Promise<InboundActivity | null>
}

/** 默认 inbound 拉取：HTTP 访问本机节点端点，任何异常都降级为 null */
async function fetchInboundDefault(port: number): Promise<InboundActivity | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/a2a/inbound-activity`, {
      signal: AbortSignal.timeout(INBOUND_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return (await res.json()) as InboundActivity
  } catch {
    // 节点不可达 / 超时 / 解析失败：该节点 inbound 缺省，不影响整体列表
    return null
  }
}

export function createA2aDashboardRoutes(deps: A2aDashboardDeps = {}): Hono {
  const discoverLocal = deps.discoverLocal ?? (() => new InstanceRegistry().discover(''))
  const listRemote = deps.listRemote ?? (() => new A2ATrustStore().list())
  const fetchInbound = deps.fetchInbound ?? fetchInboundDefault

  const api = new Hono()

  /** GET /api/a2a/agents — 本机活跃会话（含 inbound 活动）+ 远程已信任 Agent（token 脱敏） */
  api.get('/agents', async (c) => {
    // 本机活跃会话（传 '' 不排除任何 sessionId，列出全部本机节点）
    let localCards: InstanceCard[] = []
    try {
      localCards = discoverLocal()
    } catch {
      localCards = []
    }

    // 跨进程并行聚合各节点 inbound 活动；单节点失败不拖累其余
    const local = await Promise.all(
      localCards.map(async (card) => {
        const inbound = await fetchInbound(card.port)
        return { ...card, ...(inbound ? { inbound } : {}) }
      }),
    )

    // 远程白名单（去掉 authToken 明文，仅暴露是否需要鉴权）
    let remote: Array<{
      id: string
      url: string
      name: string
      alias?: string
      securityScheme: string
      hasToken: boolean
      addedAt: string
    }> = []
    try {
      const list = await listRemote()
      remote = list.map((a) => ({
        id: a.id,
        url: a.url,
        name: a.name,
        ...(a.alias !== undefined ? { alias: a.alias } : {}),
        securityScheme: a.securityScheme,
        hasToken: Boolean(a.authToken),
        addedAt: a.addedAt,
      }))
    } catch {
      remote = []
    }

    return c.json({ local, remote })
  })

  return api
}
