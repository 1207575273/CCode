// src/debug.ts — 临时调试日志，写文件避免被 Ink 覆盖
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const LOG_FILE = join(process.cwd(), 'debug.log')

export function dbg(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`
  appendFileSync(LOG_FILE, line, 'utf-8')
}

export { LOG_FILE }
