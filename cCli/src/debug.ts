// src/debug.ts — 调试日志，写入项目级 .ccode/debug.log，避免被 Ink 覆盖
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = join(process.cwd(), '.ccode')
mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = join(LOG_DIR, 'debug.log')

export function dbg(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`
  appendFileSync(LOG_FILE, line, 'utf-8')
}

export { LOG_FILE }
