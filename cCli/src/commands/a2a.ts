// src/commands/a2a.ts

/**
 * /a2a 命令 — 管理受信任的远端 A2A Agent 白名单。
 *
 * 用法：
 *   /a2a                       — 列出已信任的 Agent（同 list）
 *   /a2a list                  — 列出已信任的 Agent
 *   /a2a add <url> [别名]       — 信任一个远端 Agent（M1 不拉取 AgentCard 验证，信任用户输入）
 *   /a2a remove <url|id|别名>   — 移除一个已信任的 Agent
 *
 * 设计说明：
 * - Command.execute 是同步的，故本命令用同步 fs（readFileSync/writeFileSync）直接读写
 *   与 A2ATrustStore 相同的白名单文件（DEFAULT_FILE_PATH），schema 一致。
 * - 结果通过 show_help action 文本展示（复用现有渲染，不引入新的 UI 分支）。
 * - M1 的 add 不做 AgentCard 拉取与协议校验，正式的「拉取 + 信任两步」在 M2 Web 端实现。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Command, CommandResult } from './types.js'
import { DEFAULT_FILE_PATH, maskToken } from '@config/a2a-config.js'
import type { TrustedAgent } from '../a2a/types.js'

export class A2aCommand implements Command {
  readonly name = 'a2a'
  readonly description = '管理受信任的远端 A2A Agent（list/add/remove）'

  readonly #filePath: string

  constructor(filePath: string = DEFAULT_FILE_PATH) {
    this.#filePath = filePath
  }

  execute(args: string[]): CommandResult {
    const sub = (args[0] ?? 'list').toLowerCase()

    switch (sub) {
      case 'list':
        return this.handleList()
      case 'add':
        return this.handleAdd(args.slice(1))
      case 'remove':
      case 'rm':
        return this.handleRemove(args.slice(1))
      default:
        // 无法识别的子命令 → 显示用法
        return this.usage()
    }
  }

  // ───────────────────────────────────────────────
  // 子命令处理
  // ───────────────────────────────────────────────

  private handleList(): CommandResult {
    const list = this.readList()
    if (list.length === 0) {
      return {
        handled: true,
        action: {
          type: 'show_help',
          content: '[INFO] 暂无已信任的远端 A2A Agent。\n用 /a2a add <url> [别名] 信任一个。',
        },
      }
    }

    const lines = list.map((a, i) => {
      const aliasPart = a.alias ? ` (${a.alias})` : ''
      const auth = a.securityScheme === 'bearer' ? `bearer ${maskToken(a.authToken)}` : 'none'
      return `${i + 1}. ${a.name}${aliasPart}\n   url: ${a.url}\n   鉴权: ${auth}  |  id: ${a.id}`
    })
    return {
      handled: true,
      action: {
        type: 'show_help',
        content: `[INFO] 已信任的远端 A2A Agent（${list.length}）：\n\n${lines.join('\n\n')}`,
      },
    }
  }

  private handleAdd(rest: string[]): CommandResult {
    const url = rest[0]
    if (!url) {
      return { handled: true, action: { type: 'error', message: '用法: /a2a add <url> [别名]' } }
    }
    if (!/^https?:\/\//i.test(url)) {
      return { handled: true, action: { type: 'error', message: 'url 必须以 http:// 或 https:// 开头' } }
    }
    const alias = rest[1]

    const list = this.readList()
    const existingIndex = list.findIndex((a) => a.url === url)
    const name = alias ?? hostOf(url)

    let entry: TrustedAgent
    if (existingIndex >= 0) {
      const existing = list[existingIndex]!
      entry = {
        id: existing.id,
        url,
        name,
        securityScheme: 'none',
        addedAt: existing.addedAt,
        ...(alias !== undefined ? { alias } : {}),
      }
      list[existingIndex] = entry
    } else {
      entry = {
        id: randomUUID(),
        url,
        name,
        securityScheme: 'none',
        addedAt: new Date().toISOString(),
        ...(alias !== undefined ? { alias } : {}),
      }
      list.push(entry)
    }
    this.writeList(list)

    return {
      handled: true,
      action: {
        type: 'show_help',
        content: `[PASS] 已信任远端 Agent：${entry.name}\n   url: ${entry.url}\n现在可让 Agent 通过 dispatch_remote_agent 调用它。`,
      },
    }
  }

  private handleRemove(rest: string[]): CommandResult {
    const ref = rest[0]
    if (!ref) {
      return { handled: true, action: { type: 'error', message: '用法: /a2a remove <url|id|别名>' } }
    }
    const list = this.readList()
    const next = list.filter((a) => a.url !== ref && a.id !== ref && a.alias !== ref)
    if (next.length === list.length) {
      return { handled: true, action: { type: 'error', message: `未找到匹配 "${ref}" 的已信任 Agent` } }
    }
    this.writeList(next)
    return {
      handled: true,
      action: { type: 'show_help', content: `[PASS] 已移除 "${ref}"，剩余 ${next.length} 个已信任 Agent。` },
    }
  }

  private usage(): CommandResult {
    return {
      handled: true,
      action: {
        type: 'show_help',
        content: [
          '/a2a 用法：',
          '  /a2a list                 列出已信任的远端 Agent',
          '  /a2a add <url> [别名]      信任一个远端 Agent',
          '  /a2a remove <url|id|别名>  移除一个已信任的 Agent',
        ].join('\n'),
      },
    }
  }

  // ───────────────────────────────────────────────
  // 同步文件读写（与 A2ATrustStore 共用同一文件与 schema）
  // ───────────────────────────────────────────────

  private readList(): TrustedAgent[] {
    try {
      const raw = readFileSync(this.#filePath, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as TrustedAgent[]) : []
    } catch {
      // 文件不存在 / 解析失败 → 空列表（不中断）
      return []
    }
  }

  /** 原子写：先写 .tmp 再 rename，与 A2ATrustStore 保持一致 */
  private writeList(data: TrustedAgent[]): void {
    mkdirSync(dirname(this.#filePath), { recursive: true })
    const tmp = this.#filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, this.#filePath)
  }
}

/** 从 url 提取 host 作为默认展示名 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
