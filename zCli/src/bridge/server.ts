// src/bridge/server.ts

/**
 * Bridge Server — Hono HTTP + WebSocket 服务。
 *
 * 职责：
 * - WebSocket 端点：EventBus ↔ 浏览器双向桥接
 * - REST API 健康检查
 * - 后续扩展：静态资源托管 + Dashboard API
 */

import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import type { ServerType } from '@hono/node-server'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { eventBus, toSerializableEvent } from '@core/event-bus.js'
import type { BusEvent } from '@core/event-bus.js'
import type { AgentEvent } from '@core/agent-loop.js'

const DEFAULT_PORT = 9800
const VITE_DEV_PORT = 5173

interface BridgeServerOptions {
  port?: number
  /** dev 模式：根路径重定向到 Vite dev server */
  dev?: boolean
}

/** WebSocket 客户端上下文 */
interface WsClient {
  id: string
  send: (data: string) => void
}

let server: ServerType | null = null
const wsClients = new Map<string, WsClient>()
let clientCounter = 0

/** BridgeEvent 的类型集合，用于类型收窄 */
const BRIDGE_EVENT_TYPES = new Set([
  'user_input',
  'permission_response',
  'question_response',
  'client_connect',
  'client_disconnect',
])

/** 判断事件是否为 AgentEvent（非 BridgeEvent） */
function isAgentEvent(event: BusEvent): event is AgentEvent {
  return !BRIDGE_EVENT_TYPES.has(event.type)
}

export function startBridgeServer(options: BridgeServerOptions = {}): { port: number; close: () => void } {
  const port = options.port ?? DEFAULT_PORT
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  // WebSocket 端点
  app.get('/ws', upgradeWebSocket((c) => {
    const clientId = `web-${++clientCounter}`
    return {
      onOpen(_event, ws) {
        const client: WsClient = {
          id: clientId,
          send: (data: string) => ws.send(data),
        }
        wsClients.set(clientId, client)
        eventBus.emit({ type: 'client_connect', clientId, clientType: 'web' })
      },

      onMessage(event) {
        try {
          const msg = JSON.parse(String(event.data)) as { type: string; [key: string]: unknown }
          handleClientMessage(clientId, msg)
        } catch {
          // 无效 JSON，忽略
        }
      },

      onClose() {
        wsClients.delete(clientId)
        eventBus.emit({ type: 'client_disconnect', clientId })
      },
    }
  }))

  // 健康检查
  app.get('/api/health', (c) => c.json({ status: 'ok', clients: wsClients.size }))

  // 静态资源：dev 模式反向代理 Vite，生产模式托管构建产物
  const isDev = options.dev ?? false
  const distDir = join(import.meta.dirname ?? '.', '../../web/dist')

  if (isDev) {
    // dev 模式：反向代理到 Vite dev server，9800 一个端口搞定
    app.all('*', async (c) => {
      const url = new URL(c.req.url)
      const viteUrl = `http://localhost:${VITE_DEV_PORT}${url.pathname}${url.search}`
      try {
        const isBodyless = c.req.method === 'GET' || c.req.method === 'HEAD'
        const init: RequestInit = {
          method: c.req.method,
          headers: c.req.raw.headers,
        }
        if (!isBodyless && c.req.raw.body) {
          // Node fetch 接受 ReadableStream 作为 body
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          init.body = c.req.raw.body as any
        }
        const resp = await fetch(viteUrl, init)
        return new Response(resp.body, {
          status: resp.status,
          headers: resp.headers,
        })
      } catch {
        return c.text('Vite dev server 未就绪，请稍等...', 502)
      }
    })
  } else if (existsSync(distDir)) {
    // 生产模式：托管 web/ 构建产物
    app.use('/*', serveStatic({ root: distDir }))
    // SPA fallback：未匹配的路径返回 index.html
    app.get('*', serveStatic({ root: distDir, path: 'index.html' }))
  }

  // 订阅 EventBus，推送事件给所有 WebSocket 客户端
  eventBus.on((event) => {
    if (wsClients.size === 0) return
    // 内部管理事件不推送给浏览器
    if (event.type === 'client_connect' || event.type === 'client_disconnect') return
    if (event.type === 'permission_response' || event.type === 'question_response') return
    // Web 端自己发的 user_input 不 echo 回去（Web 端本地已显示）
    if (event.type === 'user_input' && event.source === 'web') return

    // AgentEvent 需要序列化（去除回调函数），BridgeEvent（user_input）直接序列化
    const serializable = isAgentEvent(event) ? toSerializableEvent(event) : event
    if (!serializable) return
    const json = JSON.stringify(serializable)
    for (const client of wsClients.values()) {
      try {
        client.send(json)
      } catch {
        // 发送失败，客户端可能已断开
      }
    }
  })

  server = serve({ fetch: app.fetch, port }, () => {
    // 启动成功回调（静默）
  })
  injectWebSocket(server)

  return {
    port,
    close: () => {
      if (server) {
        server.close()
        server = null
      }
    },
  }
}

/** 处理来自 Web 客户端的消息 */
function handleClientMessage(_clientId: string, msg: { type: string; [key: string]: unknown }): void {
  switch (msg.type) {
    case 'chat':
      eventBus.emit({
        type: 'user_input',
        text: String(msg['text'] ?? ''),
        source: 'web',
      })
      break
    case 'permission':
      eventBus.emit({
        type: 'permission_response',
        allow: Boolean(msg['allow']),
        source: 'web',
      })
      break
    case 'abort':
      eventBus.emit({ type: 'user_input', text: '__abort__', source: 'web' })
      break
    case 'question': {
      const cancelled = Boolean(msg['cancelled'])
      const answers = msg['answers'] as Record<string, string | string[]> | undefined
      eventBus.emit({
        type: 'question_response',
        cancelled,
        ...(answers ? { answers } : {}),
        source: 'web',
      })
      break
    }
  }
}
