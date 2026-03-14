// src/bridge/server.ts

/**
 * Bridge Server — 纯消息路由器。
 *
 * 不持有 EventBus、不持有 AgentLoop。
 * 所有 CLI 和 Web 都是平等的 WebSocket 客户端，按 sessionId 隔离。
 *
 * 客户端类型：
 * - cli: CLI 终端进程，推送 AgentEvent，接收 Web 端输入
 * - web: 浏览器页面，接收 AgentEvent，发送用户输入
 *
 * 路由规则：
 * - CLI 推送的事件 → 广播给同 session 的所有 Web 客户端
 * - Web 发送的输入 → 转发给同 session 的 CLI 客户端
 * - bridge_stop → 关闭 Bridge Server（任何客户端都有权执行）
 */

import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import type { ServerType } from '@hono/node-server'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { sessionStore } from '@persistence/index.js'

const DEFAULT_PORT = 9800
const VITE_DEV_PORT = 5173

interface BridgeServerOptions {
  port?: number
  /** dev 模式：反向代理 Vite dev server */
  dev?: boolean
}

/** WebSocket 客户端上下文 */
interface WsClient {
  id: string
  clientType: 'cli' | 'web'
  sessionId: string | null
  send: (data: string) => void
}

let server: ServerType | null = null
let activePort: number | null = null
const clients = new Map<string, WsClient>()
let clientCounter = 0

/** Bridge Server 是否已启动 */
export function isBridgeRunning(): boolean {
  return server != null && activePort != null
}

/** 获取指定 session 的已连接客户端数 */
export function getSessionClientCount(sessionId: string): number {
  let count = 0
  for (const c of clients.values()) {
    if (c.sessionId === sessionId) count++
  }
  return count
}

export function startBridgeServer(options: BridgeServerOptions = {}): { port: number; close: () => void } {
  if (server && activePort) {
    return { port: activePort, close: closeBridge }
  }

  const port = options.port ?? DEFAULT_PORT
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  // WebSocket 端点
  app.get('/ws', upgradeWebSocket((c) => {
    const clientId = `client-${++clientCounter}`
    return {
      onOpen(_event, ws) {
        const client: WsClient = {
          id: clientId,
          clientType: 'web', // 默认 web，register 消息后可能改为 cli
          sessionId: null,
          send: (data: string) => ws.send(data),
        }
        clients.set(clientId, client)
      },

      onMessage(event) {
        try {
          const msg = JSON.parse(String(event.data)) as { type: string; [key: string]: unknown }
          routeMessage(clientId, msg)
        } catch {
          // 无效 JSON，忽略
        }
      },

      onClose() {
        clients.delete(clientId)
      },
    }
  }))

  // 健康检查 + 状态
  app.get('/api/health', (c) => {
    const sessions = new Set<string>()
    for (const cl of clients.values()) {
      if (cl.sessionId) sessions.add(cl.sessionId)
    }
    return c.json({ status: 'ok', clients: clients.size, sessions: [...sessions] })
  })

  // 关闭 Bridge Server 的 API（Web 端关闭按钮 / CLI /bridge stop 指令）
  app.post('/api/bridge/stop', (c) => {
    setTimeout(closeBridge, 100)
    return c.json({ status: 'stopping' })
  })

  // 静态资源：dev 模式反向代理 Vite，生产模式托管构建产物
  const isDev = options.dev ?? false
  const distDir = join(import.meta.dirname ?? '.', '../../web/dist')

  if (isDev) {
    // Vite 反代：排除 /ws 和 /api（由 Bridge 自己处理）
    app.all('*', async (c, next) => {
      const path = new URL(c.req.url).pathname
      if (path === '/ws' || path.startsWith('/api/')) return next()

      const url = new URL(c.req.url)
      const viteUrl = `http://localhost:${VITE_DEV_PORT}${url.pathname}${url.search}`
      try {
        const isBodyless = c.req.method === 'GET' || c.req.method === 'HEAD'
        const init: RequestInit = {
          method: c.req.method,
          headers: c.req.raw.headers,
        }
        if (!isBodyless && c.req.raw.body) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          init.body = c.req.raw.body as any
        }
        const resp = await fetch(viteUrl, init)
        return new Response(resp.body, { status: resp.status, headers: resp.headers })
      } catch {
        return c.text('Vite dev server 未就绪，请稍等...', 502)
      }
    })
  } else if (existsSync(distDir)) {
    app.use('/*', serveStatic({ root: distDir }))
    app.get('*', serveStatic({ root: distDir, path: 'index.html' }))
  }

  server = serve({ fetch: app.fetch, port }, () => { /* 启动成功 */ })
  injectWebSocket(server)
  activePort = port

  return { port, close: closeBridge }
}

function closeBridge(): void {
  // 通知所有客户端 Bridge 即将关闭
  const closeMsg = JSON.stringify({ type: 'bridge_stop' })
  for (const client of clients.values()) {
    try { client.send(closeMsg) } catch { /* ignore */ }
  }
  if (server) {
    server.close()
    server = null
    activePort = null
  }
}

/**
 * 消息路由核心 — 按 clientType + sessionId 分发
 */
function routeMessage(senderId: string, msg: { type: string; [key: string]: unknown }): void {
  const sender = clients.get(senderId)
  if (!sender) return

  switch (msg.type) {
    // ── 注册消息：CLI/Web 连接后第一条消息，声明身份和 session ──
    case 'register': {
      sender.clientType = (msg['clientType'] as 'cli' | 'web') ?? 'web'
      let sid = String(msg['sessionId'] ?? '')

      // Web 注册空 sessionId 时，自动分配第一个活跃的 CLI session
      if (sender.clientType === 'web' && !sid) {
        for (const cl of clients.values()) {
          if (cl.clientType === 'cli' && cl.sessionId) {
            sid = cl.sessionId
            break
          }
        }
      }
      sender.sessionId = sid

      // Web 客户端注册时推送历史消息
      if (sender.clientType === 'web' && sender.sessionId) {
        try {
          const snapshot = sessionStore.loadMessages(sender.sessionId)
          sender.send(JSON.stringify({
            type: 'session_init',
            sessionId: sender.sessionId,
            provider: snapshot.provider,
            model: snapshot.model,
            messages: snapshot.messages,
          }))
        } catch {
          sender.send(JSON.stringify({
            type: 'session_init',
            sessionId: sender.sessionId,
            messages: [],
          }))
        }
      }
      break
    }

    // ── CLI 推送事件 → 广播给同 session 的 Web 客户端 ──
    case 'event': {
      const payload = msg['payload'] as Record<string, unknown> | undefined
      if (!payload || !sender.sessionId) break
      const json = JSON.stringify(payload)
      for (const client of clients.values()) {
        if (client.id === senderId) continue
        if (client.sessionId !== sender.sessionId) continue
        if (client.clientType !== 'web') continue
        try { client.send(json) } catch { /* ignore */ }
      }
      break
    }

    // ── Web 发送输入 → 转发给同 session 的 CLI 客户端 ──
    case 'chat':
    case 'permission':
    case 'question':
    case 'abort': {
      if (!sender.sessionId) break
      const json = JSON.stringify(msg)
      for (const client of clients.values()) {
        if (client.id === senderId) continue
        if (client.sessionId !== sender.sessionId) continue
        if (client.clientType !== 'cli') continue
        try { client.send(json) } catch { /* ignore */ }
      }
      break
    }

    // ── 任何客户端都可以关闭 Bridge ──
    case 'bridge_stop': {
      setTimeout(closeBridge, 100)
      break
    }
  }
}
