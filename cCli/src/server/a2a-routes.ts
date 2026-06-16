// src/server/a2a-routes.ts
//
// A2A HTTP 路由 — Hono sub-app
//
// 协议依据（由 @a2a-js/sdk JsonRpcTransport 实现确认）：
//   sendMessage      -> POST / { jsonrpc:'2.0', method:'message/send',   params, id }
//   sendMessageStream -> POST / { jsonrpc:'2.0', method:'message/stream', params, id }
// SSE 每行格式：data: { jsonrpc:'2.0', id, result: <A2AStreamEvent> }
// 客户端校验：response.id === requestId（ID 不一致抛错），所以响应必须回传相同 id。
//
// 端点：
//   GET  /.well-known/agent-card.json  -> AgentCard JSON
//   POST /                             -> JSON-RPC 请求分发（SDK 默认 POST 到 agentCard.url 根路径）
//   POST /a2a/rpc                      -> JSON-RPC 请求分发（兼容旧路径）

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { collectA2ATask } from '../a2a/server-executor.js'
import type { AgentCard, A2AStreamEvent } from '../a2a/types.js'
import { CALLER_METADATA_KEY, type InboundCaller, type InboundActivity } from '../a2a/node-status.js'
import {
  registerTaskController, applyTaskEvent, getStoredTask, cancelStoredTask, reapExpiredTasks,
} from '../a2a/task-store.js'

/** A2A 标准错误码 */
const ERR_TASK_NOT_FOUND = -32001
const ERR_TASK_NOT_CANCELABLE = -32002

/** 旁路把每个流事件写入 task-store（维护 taskId->Task 快照），原样透传 */
async function* teeToTaskStore(stream: AsyncGenerator<A2AStreamEvent>): AsyncGenerator<A2AStreamEvent> {
  for await (const evt of stream) {
    applyTaskEvent(evt)
    yield evt
  }
}

/**
 * 从 message.metadata 提取发起方身份（块 2 透传）。
 * 容错：字段缺失/类型不符时返回 undefined，不构造空对象（exactOptionalPropertyTypes）。
 */
function extractCaller(message: Record<string, unknown> | undefined): InboundCaller | undefined {
  const metadata = message?.['metadata'] as Record<string, unknown> | undefined
  const raw = metadata?.[CALLER_METADATA_KEY] as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object') return undefined
  const port = typeof raw['port'] === 'number' ? (raw['port'] as number) : undefined
  const projectName = typeof raw['projectName'] === 'string' ? (raw['projectName'] as string) : undefined
  if (port === undefined && projectName === undefined) return undefined
  return {
    ...(port !== undefined ? { port } : {}),
    ...(projectName !== undefined ? { projectName } : {}),
  }
}

// ──────────────────────────────────────────
// 依赖注入接口
// ──────────────────────────────────────────

export interface A2ARoutesDeps {
  /** 返回本 Agent 的 AgentCard */
  getAgentCard: () => AgentCard
  /**
   * 执行一个 A2A 任务，产出流式事件序列。
   * 内部接 server-executor.executeA2ATask。
   */
  runTask: (params: { message: string; taskId: string; contextId: string; caller?: InboundCaller; signal?: AbortSignal }) => AsyncGenerator<A2AStreamEvent>
  /** 生成唯一 ID（注入便于测试） */
  genId?: () => string
  /**
   * 返回本节点 inbound 被调活动（被调方可见反馈）。
   * 供 Dashboard 跨进程聚合：dashboard 拉取每个本机节点的该端点拼出全景。
   */
  getInboundActivity?: () => InboundActivity
}

// ──────────────────────────────────────────
// JSON-RPC 工具函数
// ──────────────────────────────────────────

/** 构造 JSON-RPC 成功响应 */
function rpcOk(id: number | string, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result }
}

/** 构造 JSON-RPC 错误响应 */
function rpcError(id: number | string | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

// ──────────────────────────────────────────
// 路由工厂
// ──────────────────────────────────────────

export function createA2ARoutes(deps: A2ARoutesDeps): Hono {
  const { getAgentCard, runTask } = deps
  // 默认用 crypto.randomUUID，注入 genId 便于测试中固定 ID
  const genId = deps.genId ?? (() => crypto.randomUUID())

  const app = new Hono()

  // ── 1. AgentCard 发现端点 ──────────────────
  app.get('/.well-known/agent-card.json', (c) => {
    return c.json(getAgentCard())
  })

  // ── inbound 被调活动端点（供 Dashboard 跨进程聚合本机网格全景） ──
  app.get('/a2a/inbound-activity', (c) => {
    const activity = deps.getInboundActivity?.() ?? { active: 0, recent: [] }
    return c.json(activity)
  })

  // ── 2. JSON-RPC 处理器（提取为共享函数，多个路径复用） ──
  // SDK 的 JsonRpcTransport 默认 POST 到 agentCard.url 根路径（即 /），
  // 旧版用 /a2a/rpc，两个路径都要支持。
  const handleRpc = async (c: import('hono').Context) => {
    // 解析请求体
    let body: Record<string, unknown>
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'))
    }

    const id = body['id'] as number | string | undefined
    const method = body['method'] as string | undefined
    const params = body['params'] as Record<string, unknown> | undefined

    // 校验：必须是 JSON-RPC 2.0，且有 method 和 id
    if (body['jsonrpc'] !== '2.0' || !method || id === undefined) {
      return c.json(rpcError(id ?? null, -32600, 'Invalid Request'))
    }

    // 机会式清理过期终态 Task（轻量，避免无界增长）
    reapExpiredTasks()

    // ── tasks/get：查任务快照（标准 A2A method） ──
    if (method === 'tasks/get') {
      const targetId = params?.['id'] as string | undefined
      const task = targetId ? getStoredTask(targetId) : undefined
      if (!task) return c.json(rpcError(id, ERR_TASK_NOT_FOUND, `Task not found: ${targetId ?? ''}`))
      return c.json(rpcOk(id, task))
    }

    // ── tasks/cancel：取消任务（标准 A2A method） ──
    if (method === 'tasks/cancel') {
      const targetId = params?.['id'] as string | undefined
      const outcome = targetId ? cancelStoredTask(targetId) : 'not-found'
      if (outcome === 'not-found') return c.json(rpcError(id, ERR_TASK_NOT_FOUND, `Task not found: ${targetId ?? ''}`))
      if (outcome === 'not-cancelable') return c.json(rpcError(id, ERR_TASK_NOT_CANCELABLE, `Task not cancelable: ${targetId}`))
      return c.json(rpcOk(id, getStoredTask(targetId!)))
    }

    // ── tasks/resubscribe：重新订阅任务流（标准 A2A method） ──
    // 最小实现：不重放历史事件，按当前快照发一条状态事件（终态则 final）。
    if (method === 'tasks/resubscribe') {
      const targetId = params?.['id'] as string | undefined
      const task = targetId ? getStoredTask(targetId) : undefined
      if (!task) return c.json(rpcError(id, ERR_TASK_NOT_FOUND, `Task not found: ${targetId ?? ''}`))
      return streamSSE(c, async (stream) => {
        const terminal = ['completed', 'failed', 'canceled', 'rejected'].includes(task.status.state)
        const evt: A2AStreamEvent = {
          kind: 'status-update',
          taskId: task.id,
          contextId: task.contextId,
          status: task.status,
          final: terminal,
        } as A2AStreamEvent
        await stream.writeSSE({ data: JSON.stringify(rpcOk(id, evt)) })
      })
    }

    // 从 params.message.parts 提取第一个 text part 作为 message
    const messageObj = params?.['message'] as Record<string, unknown> | undefined
    const msgParts = messageObj?.['parts'] as Array<Record<string, unknown>> | undefined
    const messageText = msgParts?.find((p) => p['kind'] === 'text')?.['text'] as string | undefined
    const message = messageText ?? ''

    // 发起方身份（块 2 透传，缺省时为 undefined）
    const caller = extractCaller(messageObj)

    // contextId：优先取 params，无则生成
    const contextId = (params?.['contextId'] as string | undefined) ?? genId()
    const taskId = genId()

    // 为本次任务登记取消句柄（tasks/cancel 据此中断 sidechain）
    const controller = new AbortController()
    registerTaskController(taskId, controller)

    // ── method/send：收集流事件，同步返回最终 Task ──
    if (method === 'message/send') {
      try {
        const stream = runTask({ message, taskId, contextId, signal: controller.signal, ...(caller ? { caller } : {}) })
        const task = await collectA2ATask(teeToTaskStore(stream))
        return c.json(rpcOk(id, task))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return c.json(rpcError(id, -32603, `Internal error: ${msg}`))
      }
    }

    // ── message/stream：SSE 流式推送每个事件 ──
    if (method === 'message/stream') {
      return streamSSE(c, async (stream) => {
        try {
          for await (const evt of runTask({ message, taskId, contextId, signal: controller.signal, ...(caller ? { caller } : {}) })) {
            applyTaskEvent(evt)
            await stream.writeSSE({
              data: JSON.stringify(rpcOk(id, evt)),
            })
          }
        } catch (err) {
          // 流出错时推一条错误事件（客户端会解析）
          const msg = err instanceof Error ? err.message : String(err)
          await stream.writeSSE({
            data: JSON.stringify(rpcError(id, -32603, `Internal error: ${msg}`)),
          })
        }
      })
    }

    // ── 未知 method ──
    return c.json(rpcError(id, -32601, `Method not found: ${method}`))
  }

  // SDK JsonRpcTransport 默认 POST 到 agentCard.url（即根路径 /）
  app.post('/', handleRpc)
  // 兼容旧路径
  app.post('/a2a/rpc', handleRpc)

  return app
}
