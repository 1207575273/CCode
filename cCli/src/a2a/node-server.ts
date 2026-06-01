// src/a2a/node-server.ts

/**
 * A2A 节点启动器 — 把当前会话变成一个可被寻址的 A2A Agent 节点。
 *
 * 方案 Y（每进程独立 A2A server）：
 * - 每个会话起一个独立的轻量 A2A HTTP server（动态端口，不与共享 Bridge 抢端口）
 * - 写 lockfile 名片（按 sessionId），供本机其他会话发现（端口动态，靠名片不靠猜）
 * - 被调用时在本进程起 AgentLoop 干活（本进程有完整 provider/registry/上下文）
 *
 * 整合：a2a-routes(HTTP) + server-executor(AgentLoop->A2A事件) + agent-card-builder(身份) + instance-registry(发现)
 */

import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { AddressInfo } from 'node:net'

/**
 * 探测本机局域网 IPv4 地址（供其他机器连接用）。
 * 取第一个非 internal 的 IPv4；找不到回退 127.0.0.1（仅本机可达）。
 */
export function getLanHost(): string {
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return '127.0.0.1'
}
import { createA2ARoutes } from '../server/a2a-routes.js'
import { executeA2ATask, type RunLoopFn } from './server-executor.js'
import { recordInbound, previewMessage } from './inbound-recorder.js'
import { mirrorInboundToUI } from './inbound-ui-mirror.js'
import { getInboundActivity, type InboundCaller } from './node-status.js'
import { buildLocalAgentCard } from './agent-card-builder.js'
import { InstanceRegistry } from './instance-registry.js'

/** 把发起方标识格式化成卡片来源简写（项目名 > 端口 > "远程"） */
function formatCallerName(caller: InboundCaller | undefined): string {
  if (caller?.projectName) return caller.projectName
  if (caller?.port !== undefined) return `:${caller.port}`
  return '远程'
}

/** 心跳间隔（与 instance-registry 的 30s 过期判定配套，留足余量） */
const HEARTBEAT_INTERVAL_MS = 10_000
/** 孤儿清理扫描间隔 */
const REAP_INTERVAL_MS = 30_000

export interface A2ANodeDeps {
  sessionId: string
  cwd: string
  projectName: string
  gitBranch?: string
  version: string
  /** 取当前会话工具名列表（生成 AgentCard.skills） */
  getToolNames: () => string[]
  /** 在本进程起 AgentLoop 跑一轮（被 A2A 调用时执行） */
  runLoop: RunLoopFn
  /** 注入便于测试：默认 @hono/node-server 的 serve */
  serveImpl?: typeof serve
  /** 注入便于测试：默认真实 InstanceRegistry */
  registry?: InstanceRegistry
}

export interface A2ANodeHandle {
  port: number
  /** 完整 baseUrl（含局域网 IP），可直接给其他机器/会话连接 */
  baseUrl: string
  stop: () => void
}

/**
 * 启动当前会话的 A2A 节点。返回实际端口和停止函数。
 * 幂等性由调用方保证（一个会话只调一次）。
 */
export function startA2ANode(deps: A2ANodeDeps): A2ANodeHandle {
  const serveImpl = deps.serveImpl ?? serve
  const registry = deps.registry ?? new InstanceRegistry()
  // 本机会话互调统一用 127.0.0.1（最可靠）。
  // getLanHost() 自动探测可能命中代理/VPN 虚拟网卡（如 Clash 的 198.18.0.0/15 段），
  // 导致 client 连该地址被代理拦截返回 404。跨机器（用真实局域网 IP）需配合鉴权,作为 M3。
  const host = '127.0.0.1'

  // port 在 serve 之后才确定；getAgentCard 是延迟调用（HTTP 请求时），闭包读最新 port
  let port = 0

  const routes = createA2ARoutes({
    getAgentCard: () => ({
      ...buildLocalAgentCard({
        sessionId: deps.sessionId,
        port,
        cwd: deps.cwd,
        projectName: deps.projectName,
        ...(deps.gitBranch ? { gitBranch: deps.gitBranch } : {}),
        toolNames: deps.getToolNames(),
        version: deps.version,
      }),
      // 覆盖为局域网完整地址，供其他机器/会话连接
      url: `http://${host}:${port}`,
    }),
    // 两层包装（都不打断本会话主对话，inbound 任务仍在后台 sidechain 执行）：
    //   recordInbound      —— 记录"被调用"这件事，供 StatusBar / Agent 网格页展示
    //   mirrorInboundToUI  —— 把 sidechain 的 AgentEvent 镜像成 subagent 卡片，
    //                         让被调方像发起方一样看到执行过程（CLI 状态卡 + Web 时间轴）
    runTask: ({ message, taskId, contextId, caller }) => {
      const agentId = `a2a-in-${taskId.slice(0, 8)}`
      const name = `来自 ${formatCallerName(caller)} 的委托`
      const description = previewMessage(message)
      const mirroredRunLoop: RunLoopFn = (msg, signal) =>
        mirrorInboundToUI({ agentId, name, description }, deps.runLoop(msg, signal))

      return recordInbound(
        { taskId, message, ...(caller ? { caller } : {}) },
        executeA2ATask({
          message,
          taskId,
          contextId,
          runLoop: mirroredRunLoop,
          signal: new AbortController().signal,
        }),
      )
    },
    genId: () => randomUUID(),
    // 暴露本进程 inbound 活动，供 Dashboard 跨进程聚合本机网格全景
    getInboundActivity: () => getInboundActivity(),
  })

  // 动态端口（port 0 由系统分配）
  const server: ServerType = serveImpl({ fetch: routes.fetch, port: 0 })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? (addr as AddressInfo).port : 0

  // 写名片 + 起心跳 + 起孤儿清理
  registry.writeSelf({
    sessionId: deps.sessionId,
    pid: process.pid,
    port,
    agentCardUrl: `http://${host}:${port}/.well-known/agent-card.json`,
    projectName: deps.projectName,
    cwd: deps.cwd,
    ...(deps.gitBranch ? { gitBranch: deps.gitBranch } : {}),
  })

  const heartbeatTimer = setInterval(() => {
    try {
      registry.heartbeat(deps.sessionId)
    } catch {
      // 心跳失败不致命，下一轮重试
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()

  const reapTimer = setInterval(() => {
    try {
      registry.reapOrphans()
    } catch {
      // 清理失败不致命
    }
  }, REAP_INTERVAL_MS)
  reapTimer.unref?.()

  const stop = (): void => {
    clearInterval(heartbeatTimer)
    clearInterval(reapTimer)
    try {
      registry.removeSelf(deps.sessionId)
    } catch {
      // 删除失败由其他实例的 scanner 兜底清理
    }
    try {
      server.close()
    } catch {
      // 关闭失败忽略
    }
  }

  return { port, baseUrl: `http://${host}:${port}`, stop }
}
