// src/persistence/session-store.ts

import {
  mkdirSync,
  readFileSync,
  appendFileSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import type { SessionEvent, SessionSnapshot, SessionSummary, BranchInfo } from './session-types.js'
import {
  toProjectSlug,
  generateSessionId,
  generateEventId,
  formatSessionFilename,
  extractSessionId,
  getGitBranch,
} from './session-utils.js'

const DEFAULT_LIST_LIMIT = 10
const DEFAULT_RETENTION_DAYS = 30
const FIRST_MESSAGE_MAX_LENGTH = 80

export class SessionStore {
  readonly baseDir: string
  #pathCache = new Map<string, string>()

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  /** Create a new session, write session_start event, return sessionId */
  create(cwd: string, provider: string, model: string): string {
    const sessionId = generateSessionId()
    const projectSlug = toProjectSlug(cwd)
    const projectDir = join(this.baseDir, projectSlug)
    mkdirSync(projectDir, { recursive: true })

    const filename = formatSessionFilename(sessionId)
    const filePath = join(projectDir, filename)

    const gitBranch = getGitBranch(cwd)
    const eventId = generateEventId()

    const event: SessionEvent = {
      sessionId,
      type: 'session_start',
      timestamp: new Date().toISOString(),
      uuid: eventId,
      parentUuid: null,
      cwd,
      gitBranch,
      provider,
      model,
    }

    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8')
    this.#pathCache.set(sessionId, filePath)

    return sessionId
  }

  /** Append an event line to the session's JSONL file */
  append(sessionId: string, event: SessionEvent): void {
    const filePath = this.#resolveFilePath(sessionId)
    if (!filePath) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8')
  }

  /** Read JSONL, extract user/assistant text messages along a branch path, return snapshot */
  loadMessages(sessionId: string, leafEventUuid?: string): SessionSnapshot {
    const filePath = this.#resolveFilePath(sessionId)
    if (!filePath) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const allEvents: SessionEvent[] = lines.map(l => JSON.parse(l) as SessionEvent)

    // Determine the leaf to trace from
    let targetLeafUuid = leafEventUuid
    if (!targetLeafUuid) {
      const latestLeaf = this.#findLatestLeaf(allEvents)
      if (!latestLeaf) {
        // Fallback: empty session
        return { sessionId, provider: '', model: '', cwd: '', messages: [], leafEventUuid: null }
      }
      targetLeafUuid = latestLeaf.uuid
    }

    // Walk the tree from leaf to root
    const path = this.#buildEventPath(allEvents, targetLeafUuid)

    let provider = ''
    let model = ''
    let cwd = ''
    const messages: SessionSnapshot['messages'] = []

    // 收集工具事件：tool_call_start 的 args + tool_call_end 的结果
    const toolStartArgs = new Map<string, Record<string, unknown>>()
    // 本轮积累的已完成工具记录（在 assistant 消息前插入）
    let pendingTools: SessionSnapshot['messages'][0]['toolEvents'] = []

    for (const event of path) {
      if (event.type === 'session_start' || event.type === 'session_resume') {
        if (event.provider) provider = event.provider
        if (event.model) model = event.model
        if (event.cwd) cwd = event.cwd
      }

      // 记录 tool_call_start 的 args（tool_call_end 里没有 args）
      if (event.type === 'tool_call_start' && event.toolCallId && event.toolName) {
        toolStartArgs.set(event.toolCallId, event.args ?? {})
      }

      // 收集已完成的工具记录
      if (event.type === 'tool_call_end' && event.toolCallId && event.toolName) {
        if (!pendingTools) pendingTools = []
        const toolEvt: import('./session-types.js').SnapshotToolEvent = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: toolStartArgs.get(event.toolCallId) ?? {},
        }
        if (event.durationMs != null) toolEvt.durationMs = event.durationMs
        if (event.success != null) toolEvt.success = event.success
        if (event.resultSummary != null) toolEvt.resultSummary = event.resultSummary
        pendingTools.push(toolEvt)
      }

      if (event.type === 'user' && event.message && typeof event.message.content === 'string') {
        // user 消息前：如果有未归属的工具记录，先插入（属于上一轮的尾部）
        if (pendingTools && pendingTools.length > 0) {
          messages.push({ id: `tools-${event.uuid}`, role: 'system', content: '', toolEvents: pendingTools })
          pendingTools = []
        }
        messages.push({ id: event.uuid, role: 'user', content: event.message.content })
      }

      if (event.type === 'assistant' && event.message && typeof event.message.content === 'string') {
        // assistant 消息前：插入本轮工具记录
        if (pendingTools && pendingTools.length > 0) {
          messages.push({ id: `tools-${event.uuid}`, role: 'system', content: '', toolEvents: pendingTools })
          pendingTools = []
        }
        const assistantMsg: SessionSnapshot['messages'][number] = { id: event.uuid, role: 'assistant', content: event.message.content }
        if (event.message.model) assistantMsg.model = String(event.message.model)
        if (event.message.provider) assistantMsg.provider = String(event.message.provider)
        // 提取新增的统计字段
        const rawMsg = event.message as Record<string, unknown>
        if (rawMsg['assistantUsage']) {
          const u = rawMsg['assistantUsage'] as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
          assistantMsg.usage = u
        }
        if (rawMsg['stopReason']) assistantMsg.stopReason = String(rawMsg['stopReason'])
        if (rawMsg['llmCallCount']) assistantMsg.llmCallCount = Number(rawMsg['llmCallCount'])
        if (rawMsg['toolCallCount']) assistantMsg.toolCallCount = Number(rawMsg['toolCallCount'])
        if (rawMsg['thinking']) assistantMsg.thinking = String(rawMsg['thinking'])
        messages.push(assistantMsg)
      }
    }

    // 末尾可能有未归属的工具记录（对话中断时）
    if (pendingTools && pendingTools.length > 0) {
      messages.push({ id: `tools-tail`, role: 'system', content: '', toolEvents: pendingTools })
    }

    return { sessionId, provider, model, cwd, messages, leafEventUuid: targetLeafUuid }
  }

  /** List all branches in a session (each leaf event = one branch) */
  listBranches(sessionId: string): BranchInfo[] {
    const filePath = this.#resolveFilePath(sessionId)
    if (!filePath) throw new Error(`Session not found: ${sessionId}`)

    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const events: SessionEvent[] = lines.map(l => JSON.parse(l) as SessionEvent)

    // Build parent→children and uuid→event maps
    const childrenOf = new Set<string>() // set of all parentUuids that have children

    for (const ev of events) {
      if (ev.parentUuid) childrenOf.add(ev.parentUuid)
    }

    // Leaf events: events whose uuid is NOT in childrenOf
    const leaves = events.filter(ev => !childrenOf.has(ev.uuid))

    // Count children for each event (used to find fork points)
    const childCount = new Map<string, number>()
    for (const ev of events) {
      if (ev.parentUuid) {
        childCount.set(ev.parentUuid, (childCount.get(ev.parentUuid) ?? 0) + 1)
      }
    }

    // For each leaf, walk up to find branch info
    const branches: BranchInfo[] = leaves.map(leaf => {
      const path = this.#buildEventPath(events, leaf.uuid)

      // Count user+assistant messages
      const msgs = path.filter(e =>
        (e.type === 'user' || e.type === 'assistant') &&
        e.message && typeof e.message.content === 'string'
      )

      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1]! : null
      const lastMessageText = lastMsg?.message?.content
      const lastMessage = typeof lastMessageText === 'string'
        ? (lastMessageText.length > 80 ? lastMessageText.slice(0, 80) + '...' : lastMessageText)
        : ''

      // Find fork point: the deepest event in the path that has multiple children
      let forkPoint: string | null = null
      for (let i = path.length - 1; i >= 0; i--) {
        if ((childCount.get(path[i]!.uuid) ?? 0) > 1) {
          forkPoint = path[i]!.uuid
          break
        }
      }

      return {
        leafEventUuid: leaf.uuid,
        lastMessage,
        messageCount: msgs.length,
        updatedAt: leaf.timestamp,
        forkPoint,
      }
    })

    // Sort by updatedAt descending
    branches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    return branches
  }

  /** List sessions, optionally filtered by projectSlug, sorted by updatedAt desc */
  list(options?: { projectSlug?: string; limit?: number }): SessionSummary[] {
    const limit = options?.limit ?? DEFAULT_LIST_LIMIT
    const slugs = options?.projectSlug
      ? [options.projectSlug]
      : this.#listProjectSlugs()

    const summaries: SessionSummary[] = []

    for (const slug of slugs) {
      const projectDir = join(this.baseDir, slug)
      if (!existsSync(projectDir)) continue

      let entries: string[]
      try {
        entries = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }

      for (const entry of entries) {
        const filePath = join(projectDir, entry)
        const sessionId = extractSessionId(entry)

        // Cache for future lookups
        this.#pathCache.set(sessionId, filePath)

        const stat = statSync(filePath)
        const extracted = this.#extractSummary(filePath)

        summaries.push({
          sessionId,
          projectSlug: slug,
          firstMessage: extracted.firstMessage,
          updatedAt: extracted.updatedAt || stat.mtime.toISOString(),
          gitBranch: extracted.gitBranch,
          fileSize: stat.size,
          filePath,
        })
      }
    }

    // Sort by updatedAt descending
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    return summaries.slice(0, limit)
  }

  /** Delete JSONL files older than retentionDays */
  cleanup(retentionDays: number = DEFAULT_RETENTION_DAYS): void {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const slugs = this.#listProjectSlugs()

    for (const slug of slugs) {
      const projectDir = join(this.baseDir, slug)
      let entries: string[]
      try {
        entries = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }

      for (const entry of entries) {
        const filePath = join(projectDir, entry)
        try {
          const stat = statSync(filePath)
          if (stat.mtime.getTime() < cutoff) {
            rmSync(filePath)
            // Remove from cache
            const sessionId = extractSessionId(entry)
            this.#pathCache.delete(sessionId)
          }
        } catch {
          // File may have been deleted concurrently, skip
        }
      }

      // Remove empty project directories
      try {
        const remaining = readdirSync(projectDir)
        if (remaining.length === 0) {
          rmSync(projectDir, { recursive: true })
        }
      } catch {
        // Ignore
      }
    }
  }

  /**
   * 创建子 Agent JSONL 文件，写入 session_start 事件。
   *
   * 目录结构（与 Claude Code 对齐）:
   *   <baseDir>/<projectSlug>/<parentSessionId>/subagents/agent-<agentId>.jsonl
   *
   * 返回虚拟 sessionId = `subagent-<agentId>`，用于后续 append 操作。
   */
  createSubagent(
    agentId: string,
    parentSessionId: string,
    cwd: string,
    provider: string,
    model: string,
  ): string {
    const projectSlug = toProjectSlug(cwd)
    const subagentDir = join(this.baseDir, projectSlug, parentSessionId, 'subagents')
    mkdirSync(subagentDir, { recursive: true })

    const virtualSessionId = `subagent-${agentId}`
    const filePath = join(subagentDir, `agent-${agentId}.jsonl`)

    const gitBranch = getGitBranch(cwd)
    const eventId = generateEventId()

    const event: SessionEvent = {
      sessionId: virtualSessionId,
      type: 'session_start',
      timestamp: new Date().toISOString(),
      uuid: eventId,
      parentUuid: null,
      cwd,
      gitBranch,
      provider,
      model,
      isSidechain: true,
      agentId,
      parentSessionId,
    }

    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8')
    this.#pathCache.set(virtualSessionId, filePath)

    return virtualSessionId
  }

  /**
   * 加载指定会话的所有 SubAgent 数据（从 JSONL 回放）。
   *
   * 扫描 `<baseDir>/<projectSlug>/<sessionId>/subagents/` 目录，
   * 解析每个 agent-<agentId>.jsonl，提取描述、状态和详细事件。
   */
  loadSubagents(sessionId: string, cwd: string): SubagentSnapshot[] {
    const projectSlug = toProjectSlug(cwd)
    const subagentDir = join(this.baseDir, projectSlug, sessionId, 'subagents')
    if (!existsSync(subagentDir)) return []

    const results: SubagentSnapshot[] = []
    const files = readdirSync(subagentDir).filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))

    for (const file of files) {
      try {
        const filePath = join(subagentDir, file)
        const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
        const events: SessionEvent[] = lines.map(l => JSON.parse(l) as SessionEvent)

        // 从 session_start 提取 agentId
        const startEvent = events.find(e => e.type === 'session_start')
        if (!startEvent?.agentId) continue

        const agentId = startEvent.agentId
        const endEvent = events.find(e => e.type === 'session_end')
        const userEvent = events.find(e => e.type === 'user')
        const assistantEvent = events.find(e => e.type === 'assistant')

        // 提取描述：从父会话 dispatch_agent 的 description 参数获取不到，
        // 用 user message 的前 50 字符作为 fallback
        const description = typeof userEvent?.message?.content === 'string'
          ? userEvent.message.content.slice(0, 50)
          : agentId

        // 提取详细事件
        const detailEvents: SubagentSnapshotEvent[] = []
        for (const ev of events) {
          if (ev.type === 'tool_call_start' && ev.toolName) {
            detailEvents.push({
              kind: 'tool_start',
              toolName: ev.toolName,
              toolCallId: ev.toolCallId ?? '',
              args: ev.args,
            })
          } else if (ev.type === 'tool_call_end' && ev.toolName) {
            detailEvents.push({
              kind: 'tool_done',
              toolName: ev.toolName,
              toolCallId: ev.toolCallId ?? '',
              durationMs: ev.durationMs,
              success: ev.success,
              resultSummary: ev.resultSummary,
            })
          } else if (ev.type === 'assistant' && typeof ev.message?.content === 'string') {
            detailEvents.push({
              kind: 'text',
              text: ev.message.content,
            })
          } else if (ev.type === 'error') {
            detailEvents.push({
              kind: 'error',
              error: ev.error ?? 'unknown error',
            })
          }
        }

        const status: 'done' | 'error' | 'running' = endEvent
          ? (endEvent.totalErrors && endEvent.totalErrors > 0 ? 'error' : 'done')
          : 'running' // 没有 session_end 说明还在运行或异常退出

        results.push({
          agentId,
          description,
          status,
          events: detailEvents,
        })
      } catch {
        // 单个 JSONL 解析失败不影响其他
      }
    }

    return results
  }

  /** Walk from leafUuid up to root via parentUuid, return chronological path */
  #buildEventPath(events: SessionEvent[], leafUuid: string): SessionEvent[] {
    const eventMap = new Map<string, SessionEvent>()
    for (const ev of events) eventMap.set(ev.uuid, ev)

    const path: SessionEvent[] = []
    let current: SessionEvent | undefined = eventMap.get(leafUuid)
    while (current) {
      path.push(current)
      current = current.parentUuid ? eventMap.get(current.parentUuid) : undefined
    }
    path.reverse()
    return path
  }

  /** Find the latest leaf event (event with no children) */
  #findLatestLeaf(events: SessionEvent[]): SessionEvent | undefined {
    const hasChildren = new Set<string>()
    for (const ev of events) {
      if (ev.parentUuid) hasChildren.add(ev.parentUuid)
    }
    const leaves = events.filter(ev => !hasChildren.has(ev.uuid))
    if (leaves.length === 0) return undefined
    // Pick the one with the latest timestamp
    return leaves.reduce((latest, ev) =>
      ev.timestamp > latest.timestamp ? ev : latest
    )
  }

  /** Extract firstMessage, updatedAt, gitBranch from JSONL content */
  #extractSummary(filePath: string): {
    firstMessage: string
    updatedAt: string
    gitBranch: string
  } {
    let firstMessage = ''
    let updatedAt = ''
    let gitBranch = 'unknown'

    try {
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)

      for (const line of lines) {
        const event = JSON.parse(line) as SessionEvent

        // Track latest timestamp
        if (event.timestamp) {
          updatedAt = event.timestamp
        }

        // Extract gitBranch from first event that has it
        if (event.gitBranch && gitBranch === 'unknown') {
          gitBranch = event.gitBranch
        }

        // Extract first user message
        if (
          !firstMessage &&
          event.type === 'user' &&
          event.message &&
          typeof event.message.content === 'string'
        ) {
          firstMessage =
            event.message.content.length > FIRST_MESSAGE_MAX_LENGTH
              ? event.message.content.slice(0, FIRST_MESSAGE_MAX_LENGTH) + '...'
              : event.message.content
        }
      }
    } catch {
      // Corrupted file, return defaults
    }

    return { firstMessage, updatedAt, gitBranch }
  }

  /** Find JSONL file by sessionId — cache first, then scan directories */
  #resolveFilePath(sessionId: string): string | undefined {
    const cached = this.#pathCache.get(sessionId)
    if (cached && existsSync(cached)) {
      return cached
    }

    // Scan all project directories
    const slugs = this.#listProjectSlugs()
    for (const slug of slugs) {
      const projectDir = join(this.baseDir, slug)
      let entries: string[]
      try {
        entries = readdirSync(projectDir)
      } catch {
        continue
      }

      for (const entry of entries) {
        if (extractSessionId(entry) === sessionId) {
          const filePath = join(projectDir, entry)
          this.#pathCache.set(sessionId, filePath)
          return filePath
        }
      }
    }

    return undefined
  }

  /** List subdirectories (project slugs) under baseDir */
  #listProjectSlugs(): string[] {
    if (!existsSync(this.baseDir)) return []

    try {
      return readdirSync(this.baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return []
    }
  }
}
