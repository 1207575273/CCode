#!/usr/bin/env node

/**
 * inspect-session.mjs — 检查 session JSONL 文件中的事件调用链路
 *
 * 用法：
 *   node scripts/inspect-session.mjs                  # 自动找最新的 session
 *   node scripts/inspect-session.mjs <session-file>   # 指定文件
 *   node scripts/inspect-session.mjs --all            # 列出所有 session 概览
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const SESSIONS_DIR = join(homedir(), '.zcli', 'sessions')

// ── 颜色工具 ──
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
}

// ── 事件类型 → 颜色/图标映射 ──
const EVENT_STYLE = {
  session_start:     { icon: '🚀', color: c.bold },
  session_resume:    { icon: '🔄', color: c.bold },
  session_end:       { icon: '🏁', color: c.bold },
  user:              { icon: '👤', color: c.cyan },
  assistant:         { icon: '🤖', color: c.green },
  llm_call_start:    { icon: '📡', color: c.yellow },
  llm_call_end:      { icon: '📡', color: c.yellow },
  tool_call_start:   { icon: '🔧', color: c.magenta },
  tool_call_end:     { icon: '🔧', color: c.magenta },
  mcp_connect_start: { icon: '🔌', color: c.blue },
  mcp_connect_end:   { icon: '🔌', color: c.blue },
  permission_grant:  { icon: '✅', color: c.green },
  tool_fallback:     { icon: '⚠️', color: c.yellow },
  error:             { icon: '❌', color: c.red },
}

function findLatestSession() {
  const slugs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  let latest = null
  let latestTime = 0

  for (const slug of slugs) {
    const dir = join(SESSIONS_DIR, slug)
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    for (const f of files) {
      const fp = join(dir, f)
      const st = statSync(fp)
      if (st.mtimeMs > latestTime) {
        latestTime = st.mtimeMs
        latest = fp
      }
    }
  }
  return latest
}

function listAllSessions() {
  const slugs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  const sessions = []
  for (const slug of slugs) {
    const dir = join(SESSIONS_DIR, slug)
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    for (const f of files) {
      const fp = join(dir, f)
      const st = statSync(fp)
      const content = readFileSync(fp, 'utf-8').trim()
      const lines = content.split('\n').filter(Boolean)
      const events = lines.map(l => JSON.parse(l))
      const types = events.map(e => e.type)
      const firstUser = events.find(e => e.type === 'user')
      sessions.push({
        file: fp,
        slug,
        size: st.size,
        mtime: st.mtime,
        eventCount: events.length,
        types,
        firstMessage: firstUser?.message?.content?.slice(0, 50) || '(no message)',
      })
    }
  }

  sessions.sort((a, b) => b.mtime - a.mtime)
  return sessions
}

function inspectSession(filePath) {
  const content = readFileSync(filePath, 'utf-8').trim()
  const lines = content.split('\n').filter(Boolean)
  const events = lines.map(l => JSON.parse(l))

  console.log(`\n${c.bold}Session File:${c.reset} ${filePath}`)
  console.log(`${c.bold}Events:${c.reset} ${events.length}`)
  console.log(`${c.dim}${'─'.repeat(90)}${c.reset}\n`)

  // ── 事件时间线 ──
  console.log(`${c.bold}Event Timeline:${c.reset}\n`)

  let indent = 0
  for (const event of events) {
    const style = EVENT_STYLE[event.type] || { icon: '·', color: '' }
    const ts = event.timestamp?.slice(11, 23) || '' // HH:MM:SS.mmm

    // 缩进逻辑：start 事件增加缩进，end 事件减少
    if (event.type.endsWith('_end') || event.type === 'llm_call_end' || event.type === 'tool_call_end' || event.type === 'mcp_connect_end') {
      indent = Math.max(0, indent - 1)
    }

    const pad = '  '.repeat(indent)
    let detail = ''

    switch (event.type) {
      case 'session_start':
        detail = `provider=${event.provider} model=${event.model}`
        break
      case 'session_end':
        detail = `tokens=${event.totalInputTokens}/${event.totalOutputTokens} tools=${event.totalToolCalls} llm=${event.totalLlmCalls} errors=${event.totalErrors} duration=${event.totalDurationMs}ms`
        break
      case 'user':
        detail = truncate(event.message?.content, 60)
        break
      case 'assistant':
        detail = truncate(event.message?.content, 60)
        break
      case 'llm_call_start':
        detail = `provider=${event.provider} model=${event.model} msgs=${event.messageCount}`
        break
      case 'llm_call_end':
        if (event.error) {
          detail = `${c.red}ERROR: ${event.error}${style.color} stop=${event.stopReason}`
        } else {
          detail = `in=${event.inputTokens} out=${event.outputTokens} stop=${event.stopReason}`
        }
        break
      case 'tool_call_start':
        detail = `${event.toolName}(${truncate(JSON.stringify(event.args), 40)})`
        break
      case 'tool_call_end':
        detail = `${event.toolName} ${event.success ? '✓' : '✗'} ${event.durationMs}ms ${truncate(event.resultSummary, 30)}`
        break
      case 'mcp_connect_start':
        detail = `${event.serverName} [${event.transport}]`
        break
      case 'mcp_connect_end':
        detail = event.success
          ? `${event.serverName} ✓ ${event.toolCount} tools ${event.durationMs}ms`
          : `${event.serverName} ✗ ${event.error}`
        break
      case 'permission_grant':
        detail = `${event.toolName} always=${event.always}`
        break
      case 'tool_fallback':
        detail = `${event.toolName} ${event.fromLevel}→${event.toLevel}: ${event.reason}`
        break
      case 'error':
        detail = `[${event.source}] ${event.error}`
        break
      default:
        detail = ''
    }

    console.log(`  ${c.dim}${ts}${c.reset} ${pad}${style.icon} ${style.color}${event.type.padEnd(20)}${c.reset} ${detail}`)

    if (event.type.endsWith('_start') || event.type === 'llm_call_start' || event.type === 'tool_call_start' || event.type === 'mcp_connect_start') {
      indent++
    }
  }

  // ── parentUuid 链检查 ──
  console.log(`\n${c.dim}${'─'.repeat(90)}${c.reset}`)
  console.log(`\n${c.bold}ParentUuid Chain Check:${c.reset}\n`)

  const uuidSet = new Set(events.map(e => e.uuid))
  let brokenLinks = 0
  for (const event of events) {
    if (event.parentUuid && !uuidSet.has(event.parentUuid)) {
      console.log(`  ${c.red}✗ BROKEN: ${event.type} (${event.uuid.slice(0,8)}...) → parentUuid ${event.parentUuid.slice(0,8)}... NOT FOUND${c.reset}`)
      brokenLinks++
    }
  }
  if (brokenLinks === 0) {
    console.log(`  ${c.green}✓ All ${events.length} events have valid parentUuid chain${c.reset}`)
  }

  // ── F9 事件统计 ──
  console.log(`\n${c.bold}F9 Event Statistics:${c.reset}\n`)

  const typeCounts = {}
  for (const e of events) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1
  }

  const f9Types = [
    'llm_call_start', 'llm_call_end',
    'tool_call_start', 'tool_call_end',
    'mcp_connect_start', 'mcp_connect_end',
    'permission_grant', 'tool_fallback', 'error', 'session_end',
  ]

  let hasF9 = false
  for (const t of f9Types) {
    if (typeCounts[t]) {
      hasF9 = true
      const style = EVENT_STYLE[t] || { icon: '·', color: '' }
      console.log(`  ${style.icon} ${style.color}${t.padEnd(22)}${c.reset} × ${typeCounts[t]}`)
    }
  }

  if (!hasF9) {
    console.log(`  ${c.yellow}⚠ No F9 events found — this session was created before F9${c.reset}`)
  }

  // ── 配对检查 ──
  console.log(`\n${c.bold}Start/End Pair Check:${c.reset}\n`)

  const pairs = [
    ['llm_call_start', 'llm_call_end'],
    ['tool_call_start', 'tool_call_end'],
    ['mcp_connect_start', 'mcp_connect_end'],
  ]

  for (const [start, end] of pairs) {
    const s = typeCounts[start] || 0
    const e = typeCounts[end] || 0
    const ok = s === e
    const icon = ok ? `${c.green}✓` : `${c.red}✗`
    console.log(`  ${icon} ${start}/${end}: ${s}/${e} ${ok ? '' : '(MISMATCH!)'}${c.reset}`)
  }

  console.log()
}

function truncate(str, max) {
  if (!str) return ''
  const s = String(str).replace(/\n/g, '\\n')
  return s.length > max ? s.slice(0, max) + '...' : s
}

// ── Main ──
const arg = process.argv[2]

if (arg === '--all') {
  const sessions = listAllSessions()
  console.log(`\n${c.bold}All Sessions (${sessions.length}):${c.reset}\n`)
  for (const s of sessions) {
    const f9Types = ['llm_call_start', 'llm_call_end', 'tool_call_start', 'tool_call_end', 'mcp_connect_start', 'mcp_connect_end', 'session_end']
    const hasF9 = s.types.some(t => f9Types.includes(t))
    const tag = hasF9 ? `${c.green}[F9]${c.reset}` : `${c.dim}[pre-F9]${c.reset}`
    console.log(`  ${tag} ${c.dim}${s.mtime.toISOString().slice(0,19)}${c.reset} ${s.eventCount} events  ${s.firstMessage}`)
    console.log(`    ${c.dim}${s.file}${c.reset}`)
  }
  console.log()
} else if (arg) {
  inspectSession(arg)
} else {
  const latest = findLatestSession()
  if (!latest) {
    console.log('No session files found in ~/.zcli/sessions/')
    process.exit(1)
  }
  inspectSession(latest)
}
