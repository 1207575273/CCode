// src/debug.ts — 调试日志，写入项目级 .ccode/debug.log，避免被 Ink 覆盖
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 调试开关 —— 仅当 CCODE_DEBUG 置位时才落盘。
 * 关闭时 dbg() 直接短路返回,热路径(每个流式 chunk / 每轮历史)零开销。
 */
const DEBUG_ENABLED = !!process.env.CCODE_DEBUG
const LOG_DIR = join(process.cwd(), '.ccode')
const LOG_FILE = join(LOG_DIR, 'debug.log')
let dirReady = false

/**
 * 写调试日志。
 *
 * msg 支持惰性 thunk —— 关闭调试时连参数里的 JSON.stringify 都不会执行,
 * 避免在生产态为构造日志字符串而付出「整段历史 / 每个 chunk」的序列化成本。
 * 热路径调用务必传 thunk: dbg(() => `... ${JSON.stringify(x)}`)。
 */
export function dbg(msg: string | (() => string)): void {
  if (!DEBUG_ENABLED) return
  if (!dirReady) {
    mkdirSync(LOG_DIR, { recursive: true })
    dirReady = true
  }
  const text = typeof msg === 'function' ? msg() : msg
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}`, 'utf-8')
}

export { LOG_FILE }
