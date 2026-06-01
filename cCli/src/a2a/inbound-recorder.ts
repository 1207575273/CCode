// src/a2a/inbound-recorder.ts

/**
 * inbound 记录器 — 把一个 A2A inbound 任务流包一层，记录"被调用了"这件事。
 *
 * 透传所有事件不改写，只在两端打点：
 *   - 拿到流之前记 start（状态 running）
 *   - 流正常结束记 end（completed，或检测到 final failed 则 failed）
 *   - 流抛错记 end（failed）后原样上抛
 *
 * 记录写入 node-status 的进程内 inbound 日志，供 StatusBar / Agent 网格页展示。
 * 与 server-executor 解耦：executor 保持纯翻译，记录副作用在此集中。
 */

import { recordInboundStart, recordInboundEnd, type InboundCaller } from './node-status.js'
import type { A2AStreamEvent } from './types.js'

/** 消息预览最大长度 */
const PREVIEW_MAX = 50

export interface RecordInboundMeta {
  taskId: string
  /** 原始消息（内部截断为预览） */
  message: string
  /** 发起方标识（块 2 透传后有值） */
  caller?: InboundCaller
}

/**
 * 包装 inbound 任务流，记录开始与终态。
 * @param now 注入时间源（默认 Date.now），便于测试断言耗时。
 */
export async function* recordInbound(
  meta: RecordInboundMeta,
  stream: AsyncGenerator<A2AStreamEvent>,
  now: () => number = Date.now,
): AsyncGenerator<A2AStreamEvent> {
  const startedAt = now()
  recordInboundStart({
    taskId: meta.taskId,
    messagePreview: previewMessage(meta.message),
    startedAt: new Date(startedAt).toISOString(),
    ...(meta.caller ? { caller: meta.caller } : {}),
  })

  let state: 'completed' | 'failed' = 'completed'
  try {
    for await (const evt of stream) {
      if (evt.kind === 'status-update' && evt.final && evt.status.state === 'failed') {
        state = 'failed'
      }
      yield evt
    }
  } catch (err) {
    const endedAt = now()
    recordInboundEnd(meta.taskId, { state: 'failed', durationMs: endedAt - startedAt, endedAt: new Date(endedAt).toISOString() })
    throw err
  }

  const endedAt = now()
  recordInboundEnd(meta.taskId, { state, durationMs: endedAt - startedAt, endedAt: new Date(endedAt).toISOString() })
}

/** 把消息压成单行预览并按上限截断 */
export function previewMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ')
  return trimmed.length > PREVIEW_MAX ? trimmed.slice(0, PREVIEW_MAX) + '…' : trimmed
}
