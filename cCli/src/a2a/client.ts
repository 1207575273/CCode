/**
 * A2AClientWrapper — @a2a-js/sdk 的封装层
 *
 * 职责：
 * - 把 TrustedAgent 配置（url / securityScheme / authToken）转化为 SDK Client
 * - 把调用方的 text 字符串封装成合规的 MessageSendParams
 * - 统一流式事件透传
 * - cancelTask 本地兜底（底层抛错不上抛）
 *
 * 不包含：重试、限流、AgentCard 缓存——这些由上层调用方按需处理。
 */

import { randomUUID } from 'node:crypto'
import {
  ClientFactory,
  JsonRpcTransportFactory,
  RestTransportFactory,
  DefaultAgentCardResolver,
} from '@a2a-js/sdk/client'
import type { Client } from '@a2a-js/sdk/client'
import type {
  TrustedAgent,
  AgentCard,
  MessageSendParams,
  A2ASendResult,
  A2AStreamEvent,
} from './types.js'

// ── bearer fetch wrapper ─────────────────────────────────────────────────────

/**
 * 构造一个注入了 Authorization: Bearer 头的 fetch wrapper。
 * 仅在 securityScheme === 'bearer' && authToken 存在时使用。
 */
function makeBearerFetch(token: string): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return fetch(input, { ...init, headers })
  }
}

// ── 内部工具函数 ─────────────────────────────────────────────────────────────

/**
 * 把调用方传入的 text（和可选 contextId）封装成 A2A MessageSendParams。
 * exactOptionalPropertyTypes：contextId 存在时才展开，不赋 undefined。
 */
function buildSendParams(text: string, contextId?: string): MessageSendParams {
  return {
    message: {
      kind: 'message',
      messageId: randomUUID(),
      role: 'user',
      parts: [{ kind: 'text', text }],
      ...(contextId !== undefined ? { contextId } : {}),
    },
  }
}

/**
 * 根据 TrustedAgent 的鉴权配置构造 SDK ClientFactory。
 * bearer 模式时把 fetchImpl wrapper 注入到两个 transport factory。
 */
function buildClientFactory(agent: TrustedAgent): ClientFactory {
  const isBearerWithToken =
    agent.securityScheme === 'bearer' && agent.authToken !== undefined && agent.authToken !== ''

  if (isBearerWithToken) {
    // 已通过 isBearerWithToken 守卫，authToken 必然是 string
    const bearerFetch = makeBearerFetch(agent.authToken as string)
    return new ClientFactory({
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: bearerFetch }),
        new RestTransportFactory({ fetchImpl: bearerFetch }),
      ],
    })
  }

  return new ClientFactory({
    transports: [new JsonRpcTransportFactory(), new RestTransportFactory()],
  })
}

// ── A2AClientWrapper ─────────────────────────────────────────────────────────

export class A2AClientWrapper {
  /** 内部持有的 SDK Client 实例 */
  private readonly client: Client

  private constructor(client: Client) {
    this.client = client
  }

  // ── 静态工厂 ───────────────────────────────────────────────────────────────

  /**
   * 从 TrustedAgent 配置创建封装实例。
   * 内部通过 ClientFactory.createFromUrl 拉取 AgentCard 并建立 Client。
   */
  static async create(agent: TrustedAgent): Promise<A2AClientWrapper> {
    const factory = buildClientFactory(agent)
    const client = await factory.createFromUrl(agent.url)
    return new A2AClientWrapper(client)
  }

  /**
   * 独立拉取 AgentCard，不创建 Client 实例。
   * 可用于服务发现阶段的 card 验证。
   *
   * @param url       Agent 的 base URL
   * @param opts.timeoutMs  拉取超时（默认 8000ms）
   * @param opts.authToken  bearer token（若需要鉴权才能拉 card）
   */
  static async fetchAgentCard(
    url: string,
    opts?: { timeoutMs?: number; authToken?: string },
  ): Promise<AgentCard> {
    const timeoutMs = opts?.timeoutMs ?? 8000
    const signal = AbortSignal.timeout(timeoutMs)

    const fetchWithSignal: typeof fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      // 合并调用方已有 signal（取最先触发者）
      const mergedInit: RequestInit = { ...init, signal }
      if (opts?.authToken) {
        const headers = new Headers(init?.headers)
        headers.set('Authorization', `Bearer ${opts.authToken}`)
        mergedInit.headers = headers
      }
      return fetch(input, mergedInit)
    }

    const resolver = new DefaultAgentCardResolver({ fetchImpl: fetchWithSignal })
    return resolver.resolve(url, undefined)
  }

  // ── 实例方法 ───────────────────────────────────────────────────────────────

  /**
   * 发送单次消息，等待终态结果。
   * 返回 Message（轻量响应）或 Task（异步任务）。
   */
  async sendMessage(text: string, contextId?: string): Promise<A2ASendResult> {
    const params = buildSendParams(text, contextId)
    return this.client.sendMessage(params) as Promise<A2ASendResult>
  }

  /**
   * 流式发送消息，yield 底层 SDK 的每一个 A2AStreamEventData。
   * 调用方负责判断终态（TERMINAL_TASK_STATES）并停止消费。
   */
  async *sendMessageStream(text: string, contextId?: string): AsyncGenerator<A2AStreamEvent> {
    const params = buildSendParams(text, contextId)
    const gen = this.client.sendMessageStream(params)
    for await (const event of gen) {
      yield event as A2AStreamEvent
    }
  }

  /**
   * 取消任务。
   * 本地兜底：底层抛错（任务不存在、不可取消等）一律静默处理，不向上抛。
   * 上层若需感知失败，可在此处扩展为返回 boolean 或 Result 类型。
   */
  async cancelTask(taskId: string): Promise<void> {
    try {
      await this.client.cancelTask({ id: taskId })
    } catch {
      // 本地兜底：取消失败不影响调用方流程
      // 生产环境建议接入 observability 日志，此处 M1 简化
    }
  }
}
