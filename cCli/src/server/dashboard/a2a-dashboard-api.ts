// src/server/dashboard/a2a-dashboard-api.ts

/**
 * A2A Dashboard API — 给 Web 控制台提供 Agent 网格视图数据。
 *
 * 注意：与 `src/server/a2a-routes.ts`（A2A 协议端点 /a2a/rpc）区分开。
 * 本模块是 Dashboard 的只读列表接口（/api/a2a/agents），不参与 A2A 协议。
 *
 * 数据源：
 * - local：本机 lockfile 发现的活跃 CCode 会话（InstanceRegistry）
 * - remote：受信任的远程 Agent 白名单（A2ATrustStore，token 脱敏后返回）
 */

import { Hono } from 'hono'
import { InstanceRegistry } from '../../a2a/instance-registry.js'
import { A2ATrustStore } from '../../config/a2a-config.js'

export function createA2aDashboardRoutes(): Hono {
  const api = new Hono()

  /** GET /api/a2a/agents — 返回本机活跃会话 + 远程已信任 Agent（token 脱敏） */
  api.get('/agents', async (c) => {
    // 本机活跃会话（传 '' 不排除任何 sessionId，列出全部本机节点）
    let local: ReturnType<InstanceRegistry['discover']> = []
    try {
      local = new InstanceRegistry().discover('')
    } catch {
      local = []
    }

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
      const list = await new A2ATrustStore().list()
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
