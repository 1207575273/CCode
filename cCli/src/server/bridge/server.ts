// src/server/bridge/server.ts

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
// serveStatic 不再使用（全局安装时 cwd 和包路径可能跨盘，serveStatic 无法处理）
// import { serveStatic } from '@hono/node-server/serve-static'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import type { ServerType } from '@hono/node-server'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sessionStore } from '@persistence/index.js'
import { createApiRoutes } from '../dashboard/api.js'

const DEFAULT_PORT = 9800
/**
 * 端口递增重试上限。
 *
 * 当目标端口被占用时（常见于上一个 CLI 实例非正常退出，端口残留在 TIME_WAIT），
 * 自动尝试下一个端口（9800 → 9801 → 9802 ...），最多尝试 MAX_PORT_RETRIES 次。
 *
 * Windows TIME_WAIT 默认约 120 秒，3 个备选端口足以覆盖极端场景
 * （同时非正常退出 3 个实例的概率极低）。
 */
const MAX_PORT_RETRIES = 3
interface BridgeServerOptions {
  port?: number
  /** dev 模式：反向代理 Vite dev server */
  dev?: boolean
  /** dev 模式下 Vite dev server 的实际端口（由 ccli.ts 动态分配） */
  vitePort?: number
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
        const disconnected = clients.get(clientId)
        clients.delete(clientId)
        // CLI 断连时通知同 session 的 Web 客户端
        if (disconnected?.clientType === 'cli' && disconnected.sessionId) {
          const sid = disconnected.sessionId
          const msg = JSON.stringify({ type: 'cli_status', connected: false, sessionId: sid })
          for (const cl of clients.values()) {
            if (cl.clientType === 'web' && cl.sessionId === sid) {
              try { cl.send(msg) } catch { /* ignore */ }
            }
          }
        }
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

  // Dashboard REST API（总览/对话/设置/计价）
  app.route('/api', createApiRoutes())

  // 关闭 Bridge Server 的 API（Web 端关闭按钮 / CLI /bridge stop 指令）
  app.post('/api/bridge/stop', (c) => {
    setTimeout(closeBridge, 100)
    return c.json({ status: 'stopping' })
  })

  // 静态资源：dev 模式反向代理 Vite，生产模式托管构建产物
  const isDev = options.dev ?? false
  // distDir 路径解析：
  //   dev 模式：从源码目录回溯到 web/dist（兼容旧路径）
  //   生产模式：从 ccli.js 位置（dist/bin/）相对定位到 dist/web/
  //            即 import.meta.dirname/../web（打包后 dist/bin/ → dist/web/）
  //            回退到 cwd/web/dist（兼容未打包场景）
  const scriptDir = import.meta.dirname ?? '.'
  const distDir = isDev
    ? join(scriptDir, '../../web/dist')
    : existsSync(join(scriptDir, '../web/index.html'))
      ? join(scriptDir, '../web')         // 打包产物：dist/bin/ → dist/web/
      : join(process.cwd(), 'web/dist')   // 回退：开发环境直接跑编译产物

  if (isDev) {
    // Vite 反代：排除 /ws 和 /api（由 Bridge 自己处理）
    app.all('*', async (c, next) => {
      const path = new URL(c.req.url).pathname
      if (path === '/ws' || path.startsWith('/api/')) return next()

      const url = new URL(c.req.url)
      const viteUrl = `http://localhost:${options.vitePort}${url.pathname}${url.search}`
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
    // 生产模式：手动托管静态文件（绝对路径，不依赖 cwd）
    // Hono serveStatic 只支持相对 cwd 的路径，全局安装时 cwd 和包路径可能跨盘（Windows），
    // relative() 无法正确计算，所以用手动读文件方式。
    /** 文件扩展名 → Content-Type 映射 */
    const MIME: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    }

    app.get('*', (c) => {
      const urlPath = new URL(c.req.url).pathname
      // 尝试精确匹配文件
      let filePath = join(distDir, urlPath === '/' ? 'index.html' : urlPath)
      if (!existsSync(filePath)) {
        // SPA fallback：未匹配的路径返回 index.html
        filePath = join(distDir, 'index.html')
      }
      if (!existsSync(filePath)) {
        return c.text('Not Found', 404)
      }
      const ext = filePath.slice(filePath.lastIndexOf('.'))
      const contentType = MIME[ext] ?? 'application/octet-stream'
      const body = readFileSync(filePath)
      return new Response(body, { headers: { 'Content-Type': contentType } })
    })
  }

  // 端口绑定 + 自动递增重试
  // 场景：上一个 CLI 实例被 kill -9，端口残留在 TIME_WAIT（Windows 约 120 秒）
  // serve() 会同步触发底层 net.Server 的 'error' 事件抛 EADDRINUSE
  let bindPort = port
  for (let retry = 0; retry <= MAX_PORT_RETRIES; retry++) {
    try {
      server = serve({ fetch: app.fetch, port: bindPort }, () => { /* 启动成功 */ })
      break
    } catch (err) {
      const isAddrInUse = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      if (!isAddrInUse || retry === MAX_PORT_RETRIES) throw err
      // 端口被占，尝试下一个
      bindPort++
    }
  }
  injectWebSocket(server!)
  activePort = bindPort

  return { port: bindPort, close: closeBridge }
}

/** 广播消息给所有指定类型的客户端（供 Dashboard API 调用） */
export function broadcastToClients(msg: Record<string, unknown>, clientType?: 'cli' | 'web'): void {
  const json = JSON.stringify(msg)
  for (const client of clients.values()) {
    if (clientType && client.clientType !== clientType) continue
    try { client.send(json) } catch { /* ignore */ }
  }
}

export function closeBridge(): void {
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
      const oldSessionId = sender.sessionId
      sender.sessionId = sid

      // CLI 重新注册（resume 场景）：通知同 session 的 Web 客户端 CLI 回来了
      if (sender.clientType === 'cli' && sid) {
        const statusMsg = JSON.stringify({ type: 'cli_status', connected: true, sessionId: sid })
        for (const cl of clients.values()) {
          if (cl.clientType === 'web' && cl.sessionId === sid) {
            try { cl.send(statusMsg) } catch { /* ignore */ }
          }
        }
        // 如果 CLI 从 oldSession 切走，通知那边的 Web 断开
        if (oldSessionId && oldSessionId !== sid) {
          const offMsg = JSON.stringify({ type: 'cli_status', connected: false, sessionId: oldSessionId })
          for (const cl of clients.values()) {
            if (cl.clientType === 'web' && cl.sessionId === oldSessionId) {
              try { cl.send(offMsg) } catch { /* ignore */ }
            }
          }
        }
      }

      // Web 客户端注册时推送历史消息 + SubAgent 数据 + CLI 存活状态
      if (sender.clientType === 'web' && sender.sessionId) {
        // 检查是否有活跃的 CLI 在这个 session 上
        let cliConnected = false
        let activeSessionId: string | undefined
        for (const cl of clients.values()) {
          if (cl.clientType === 'cli' && cl.sessionId) {
            if (cl.sessionId === sender.sessionId) {
              cliConnected = true
            }
            // 记录第一个活跃 CLI 的 sessionId（供切换用）
            if (!activeSessionId) {
              activeSessionId = cl.sessionId
            }
          }
        }

        try {
          const snapshot = sessionStore.loadMessages(sender.sessionId)
          const subagents = sessionStore.loadSubagents(sender.sessionId, snapshot.cwd)
          sender.send(JSON.stringify({
            type: 'session_init',
            sessionId: sender.sessionId,
            provider: snapshot.provider,
            model: snapshot.model,
            messages: snapshot.messages,
            subagents,
            cliConnected,
            ...(activeSessionId && activeSessionId !== sender.sessionId ? { activeSessionId } : {}),
          }))
        } catch {
          sender.send(JSON.stringify({
            type: 'session_init',
            sessionId: sender.sessionId,
            messages: [],
            cliConnected,
            ...(activeSessionId && activeSessionId !== sender.sessionId ? { activeSessionId } : {}),
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

    // ── 配置变更通知 → 广播给所有 CLI 客户端 ──
    case 'config_changed': {
      const json = JSON.stringify(msg)
      for (const client of clients.values()) {
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
